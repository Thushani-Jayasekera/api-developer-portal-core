/*
 * Copyright (c) 2024, WSO2 LLC. (http://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Agent Activity Logger & Anomaly Detector
 *
 * Only activates for agent requests (req.wantsJSON = true set by agentNegotiation middleware).
 * Human browser traffic is unaffected.
 *
 * What it does:
 *   1. Logs every agent request to a dedicated agent-YYYY-MM-DD.log file, separate
 *      from human audit logs, so agent traffic can be monitored and retained independently.
 *
 *   2. Detects anomalous patterns using Redis sliding-window counters (with an in-memory
 *      fallback when Redis is unavailable):
 *        - Burst rate    : > BURST_LIMIT requests per minute from one identity
 *        - Hourly rate   : > HOURLY_LIMIT requests per hour from one identity
 *        - API scanning  : accessing > SCAN_LIMIT distinct API handles in SCAN_WINDOW_S seconds
 *        - 404 probing   : > PROBE_LIMIT consecutive 404 responses (probing for hidden APIs)
 *
 * Agent identity is resolved (highest specificity first):
 *   1. Hash of Bearer token (when Authorization header is present)
 *   2. Hash of API key (when configured key header is present)
 *   3. Client IP address (fallback — less reliable behind proxies)
 *
 * Anomalies are logged as warnings (never block the request — detection only).
 * To add blocking, call res.status(429).json(...) before next() in the anomaly handler.
 */

const crypto = require('crypto');
const logger = require('../config/logger');
const config = require(process.cwd() + '/config.json');

// ─── Thresholds (tune via config.agentMonitoring or leave as defaults) ────────

const cfg = config.agentMonitoring || {};

const BURST_LIMIT    = cfg.burstLimitPerMinute   ?? 60;   // requests/minute
const HOURLY_LIMIT   = cfg.hourlyLimit            ?? 500;  // requests/hour
const SCAN_LIMIT     = cfg.scanDistinctApis       ?? 20;   // distinct API handles / window
const SCAN_WINDOW_S  = cfg.scanWindowSeconds      ?? 300;  // 5 minutes
const PROBE_LIMIT    = cfg.consecutive404Limit    ?? 5;    // consecutive 404s before alert

// ─── In-memory fallback (used when Redis is unavailable) ─────────────────────
// Uses a simple Map per identity with expiring entries. Not shared across pods.

const memStore = new Map();

function memIncr(key, ttlSeconds) {
    const now = Date.now();
    const entry = memStore.get(key) || { count: 0, expiresAt: now + ttlSeconds * 1000 };
    if (now > entry.expiresAt) {
        entry.count = 0;
        entry.expiresAt = now + ttlSeconds * 1000;
    }
    entry.count += 1;
    memStore.set(key, entry);
    return entry.count;
}

function memSAdd(key, value, ttlSeconds) {
    const now = Date.now();
    const entry = memStore.get(key) || { set: new Set(), expiresAt: now + ttlSeconds * 1000 };
    if (now > entry.expiresAt) {
        entry.set = new Set();
        entry.expiresAt = now + ttlSeconds * 1000;
    }
    entry.set.add(value);
    memStore.set(key, entry);
    return entry.set.size;
}

function memGetAndReset(key) {
    const entry = memStore.get(key);
    if (!entry) return 0;
    const val = entry.count || 0;
    memStore.delete(key);
    return val;
}

// ─── Redis helpers (graceful degradation) ─────────────────────────────────────

let redisClient = null;

function getRedis() {
    if (redisClient) return redisClient;
    try {
        const redisService = require('../services/redisService');
        if (redisService.isConnected && redisService.redis) {
            redisClient = redisService.redis;
        }
    } catch (_) { /* Redis not available */ }
    return redisClient;
}

async function incrWithTTL(key, ttlSeconds) {
    const redis = getRedis();
    if (redis) {
        try {
            const count = await redis.incr(key);
            if (count === 1) await redis.expire(key, ttlSeconds);
            return count;
        } catch (_) { /* fall through */ }
    }
    return memIncr(key, ttlSeconds);
}

async function sAddWithTTL(key, value, ttlSeconds) {
    const redis = getRedis();
    if (redis) {
        try {
            await redis.sadd(key, value);
            await redis.expire(key, ttlSeconds);
            return await redis.scard(key);
        } catch (_) { /* fall through */ }
    }
    return memSAdd(key, value, ttlSeconds);
}

async function getAndDel(key) {
    const redis = getRedis();
    if (redis) {
        try {
            const val = parseInt(await redis.get(key) || '0', 10);
            await redis.del(key);
            return val;
        } catch (_) { /* fall through */ }
    }
    return memGetAndReset(key);
}

// ─── Identity resolution ──────────────────────────────────────────────────────

function resolveAgentIdentity(req) {
    const auth = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) {
        const token = auth.slice(7);
        return {
            id: 'bearer:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16),
            type: 'bearer',
        };
    }

    const apiKeyHeader = config.advanced?.apiKey?.keyType?.toLowerCase();
    if (apiKeyHeader) {
        const key = req.headers[apiKeyHeader];
        if (key) {
            return {
                id: 'apikey:' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
                type: 'apikey',
            };
        }
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';
    return { id: 'ip:' + ip, type: 'ip' };
}

// ─── API handle extraction ────────────────────────────────────────────────────

function extractApiHandle(req) {
    return req.params?.apiHandle || null;
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

async function checkAnomalies(identity, apiHandle, statusCode, org) {
    const anomalies = [];
    const safeId = identity.id.replace(/[^a-zA-Z0-9:_-]/g, '_');

    // 1. Burst rate: requests per minute
    const burstKey = `agent:rate:min:${safeId}`;
    const burstCount = await incrWithTTL(burstKey, 60);
    if (burstCount === BURST_LIMIT + 1) {
        anomalies.push({ type: 'burst_rate', value: burstCount, limit: BURST_LIMIT, window: '1min' });
    }

    // 2. Hourly rate: requests per hour
    const hourKey = `agent:rate:hour:${safeId}`;
    const hourCount = await incrWithTTL(hourKey, 3600);
    if (hourCount === HOURLY_LIMIT + 1) {
        anomalies.push({ type: 'hourly_rate', value: hourCount, limit: HOURLY_LIMIT, window: '1hour' });
    }

    // 3. API scanning: distinct API handles in a 5-minute window
    if (apiHandle) {
        const scanKey = `agent:scan:${safeId}`;
        const distinctCount = await sAddWithTTL(scanKey, apiHandle, SCAN_WINDOW_S);
        if (distinctCount === SCAN_LIMIT + 1) {
            anomalies.push({ type: 'api_scanning', value: distinctCount, limit: SCAN_LIMIT, window: `${SCAN_WINDOW_S}s` });
        }
    }

    // 4. Consecutive 404 probing
    const probeKey = `agent:consec404:${safeId}`;
    if (statusCode === 404) {
        const probeCount = await incrWithTTL(probeKey, 300);
        if (probeCount === PROBE_LIMIT + 1) {
            anomalies.push({ type: '404_probing', value: probeCount, limit: PROBE_LIMIT, window: '5min' });
        }
    } else if (statusCode < 400) {
        // Reset consecutive 404 counter on a successful response
        await getAndDel(probeKey);
    }

    return anomalies;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

const agentActivityLogger = (req, res, next) => {
    // Only runs for agent requests
    if (!req.wantsJSON) {
        return next();
    }

    const startTime = Date.now();
    const identity = resolveAgentIdentity(req);
    const apiHandle = extractApiHandle(req);
    const org = req.params?.orgName || null;

    // Hook into res.end to capture response status after the handler completes
    const originalEnd = res.end;
    res.end = function (chunk, encoding) {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;

        // Run async anomaly checks and logging without blocking the response
        setImmediate(async () => {
            try {
                const anomalies = await checkAnomalies(identity, apiHandle, statusCode, org);

                const logEntry = {
                    identity: identity.id,
                    identity_type: identity.type,
                    org,
                    method: req.method,
                    path: req.originalUrl,
                    api_handle: apiHandle,
                    status: statusCode,
                    duration_ms: duration,
                    anomalies: anomalies.length > 0 ? anomalies : undefined,
                };

                logger.agent(`${req.method} ${req.originalUrl} - ${statusCode} - ${duration}ms`, logEntry);

                if (anomalies.length > 0) {
                    anomalies.forEach((anomaly) => {
                        logger.warn(`[AGENT_ANOMALY] ${anomaly.type} detected`, {
                            ...anomaly,
                            identity: identity.id,
                            identity_type: identity.type,
                            org,
                            path: req.originalUrl,
                        });
                    });
                }
            } catch (err) {
                logger.error('Agent activity logger error', { error: err.message });
            }
        });

        originalEnd.call(this, chunk, encoding);
    };

    next();
};

module.exports = agentActivityLogger;
module.exports.resolveAgentIdentity = resolveAgentIdentity;
