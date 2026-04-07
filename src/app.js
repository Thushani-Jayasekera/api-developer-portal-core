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
/* eslint-disable no-undef */
const express = require('express');
const { engine } = require('express-handlebars');
const passport = require('passport');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const logger = require('./config/logger');
const { auditMiddleware } = require('./middlewares/auditLogger');
const agentNegotiation = require('./middlewares/agentNegotiation');
const agentActivityLogger = require('./middlewares/agentActivityLogger');
const { AGENT_ACCESS_LEVEL_DESCRIPTIONS } = require('./dto/agentApiDTO');
const adminDao = require('./dao/admin');
const apiDao = require('./dao/apiMetadata');
const authRoute = require('./routes/authRoute');
const devportalRoute = require('./routes/devportalRoute');
const orgContent = require('./routes/orgContentRoute');
const apiContent = require('./routes/apiContentRoute');
const applicationContent = require('./routes/applicationsContentRoute');
const sdkJobService = require('./services/sdkJobService');
const customContent = require('./routes/customPageRoute');
const subscriptionsContent = require('./routes/subscriptionsContentRoute');
const config = require(process.cwd() + '/config.json');
const Handlebars = require('handlebars');
const constants = require("./utils/constants");
const designRoute = require('./routes/designModeRoute');
const settingsRoute = require('./routes/configureRoute');
const AsyncLock = require('async-lock');
const util = require('./utils/util');

const OAuth2Strategy = require('passport-oauth2');
const jwt = require('jsonwebtoken');
const secretConf = require(process.cwd() + '/secret.json');
const { v4: uuidv4 } = require('uuid');

const lock = new AsyncLock();
const app = express();
// const secret = crypto.randomBytes(64).toString('hex');
const sessionSecret = 'my-secret';
const filePrefix = config.pathToContent;

const SERVER_ID = uuidv4();

logger.info(`Starting server with ID: ${SERVER_ID}`);

//PostgreSQL connection pool for session store

if (config.advanced.dbSslDialectOption) {
    pool = new Pool({
        user: config.db.username,
        host: config.db.host,
        database: config.db.database,
        password: secretConf.dbSecret,
        port: config.db.port,
        ssl: { require: true, rejectUnauthorized: false }
    });
} else {
    pool = new Pool({
        user: config.db.username,
        host: config.db.host,
        database: config.db.database,
        password: secretConf.dbSecret,
        port: config.db.port
    });
}

app.engine('.hbs', engine({
    extname: '.hbs'
}));

app.set('view engine', 'hbs');

// #region Register Handlebars helpers

// Handlebars helper to filter subscriptions by status (case-insensitive, supports 'ALL')
Handlebars.registerHelper('filterByStatus', function (array, status) {
    if (!Array.isArray(array)) return [];
    if (!status || status === 'ALL') return array;
    const statusLower = status.toLowerCase();
    return array.filter(item => item.status && item.status.toLowerCase() === statusLower);
});

// Handlebars helper to check if an array is empty
Handlebars.registerHelper('isEmpty', function (arr) {
    return !arr || arr.length === 0;
});

// Handlebars 'filter' helper: returns a filtered array for use as a subexpression
Handlebars.registerHelper('filter', function (array, property, value, include) {
    if (!Array.isArray(array)) return [];
    if (typeof include !== 'boolean') {
        include = true;
    }
    if (include) {
        return array.filter(item => item && item[property] === value);
    } else {
        return array.filter(item => item && item[property] !== value);
    }
});

Handlebars.registerHelper('json', function (context) {

    if (context) {
        return JSON.stringify(context);
    } else {
        return JSON.stringify();
    }
});

Handlebars.registerHelper('jsonBeautify', function (context) {
    if (context) {
        if (!(typeof context == 'string')) {
            return JSON.stringify(context, null, 2); 
        } else {
            return context;
        }
    } else {
        return '{}'; 
    }
});

Handlebars.registerHelper('jsonSafePlatformSubscriptions', function (context) {
    try {
        if (!context || !Array.isArray(context)) return JSON.stringify([]);
        const safe = context.map(function (s) {
            return {
                subscriptionId: s.subscriptionId,
                subscriptionPlanName: s.subscriptionPlanName,
                status: s.status,
                customerName: s.customerName || s.customer || null,
                maskedToken: s.subscriptionToken ? ('****' + String(s.subscriptionToken).slice(-4)) : '****'
            };
        });
        return JSON.stringify(safe);
    } catch (e) {
        return JSON.stringify([]);
    }
});

Handlebars.registerHelper("every", function (array, key, options) {
    if (!Array.isArray(array)) {
        return options.inverse(this);
    }

    const allMatch = array.every(item => item[key]);

    return allMatch ? true : false;
});

Handlebars.registerHelper("firstTwoLetters", function (text) {
    return text ? text.substring(0, 2).toUpperCase() : "";
});

Handlebars.registerHelper('getSubIDs', function (subAPIs) {
    const subIDs = subAPIs.map(api => api.subID);
    return JSON.stringify(subIDs);
});

Handlebars.registerHelper('beforeSeparator', function (value, separator) {
    if (typeof value === 'string' && typeof separator === 'string') {
        return value.split(separator)[0];
    }
    return value;
});

Handlebars.registerHelper("some", function (array, key, options) {
    if (!Array.isArray(array)) {
        return options.inverse(this);
    }

    const someMatch = array.some(item => item[key]);

    return someMatch ? true : false;
});

Handlebars.registerHelper('eq', function (a, b) {
    return (a === b || (a != null && b != null && (a === b.toString() || a.toString() === b)));
});

Handlebars.registerHelper('compare', function (a, operator, b, options) {
    if (arguments.length < 4) {
        throw new Error('Handlebars Helper "compare" needs 3 parameters');
    }
    let result;
    switch (operator) {
        case '===': result = a === b; break;
        case '!==': result = a !== b; break;
        case '<': result = a < b; break;
        case '>': result = a > b; break;
        case '<=': result = a <= b; break;
        case '>=': result = a >= b; break;
        default: throw new Error('Handlebars Helper "compare" doesn\'t know the operator ' + operator);
    }
    return result ? options.fn(this) : options.inverse(this);
});

/**
 * Formats API key expiry for display: ISO-8601 strings, Unix seconds, or Unix milliseconds
 * (e.g. CP may return 1774923420000 as a number or string).
 */
Handlebars.registerHelper('formatExpiresAt', function (value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    let d;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        if (Number.isNaN(n)) {
            return s;
        }
        const digitLen = String(n).length;
        d = digitLen <= 10 ? new Date(n * 1000) : new Date(n);
    } else {
        d = new Date(s);
    }
    if (Number.isNaN(d.getTime())) {
        return s;
    }
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
});

Handlebars.registerHelper('in', function (value, options) {
    const rawValues = Array.isArray(options.hash.values)
        ? options.hash.values
        : options.hash.values.split(',');
    const validValues = rawValues.map(v => v.trim());
    const trimmedValue = value?.trim();

    const match = validValues.some(valid => trimmedValue?.includes(valid));
    return match ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('conditionalIf', function (condition, value1, value2) {
    return condition ? value1 : value2;
});

Handlebars.registerHelper('contains', function (array, value) {
    return array && array.includes(value);
});

Handlebars.registerHelper('let', function (name, value, options) {
    const data = Handlebars.createFrame(options.data);
    data[name] = value;
    return options.fn({ ...options.hash, ...data });
});

Handlebars.registerHelper('and', function () {
    const args = Array.prototype.slice.call(arguments);
    const lastArg = args.pop();
    return args.every(Boolean) ? lastArg.fn(this) : lastArg.inverse(this);
});

Handlebars.registerHelper('getValue', function (obj, key) {
    return obj[key];
});

Handlebars.registerHelper('lowercase', function (str) {
    return typeof str === 'string' ? str.toLowerCase() : str;
});

Handlebars.registerHelper('isMiddle', function (index, length) {
    const middleIndex = Math.floor(length / 2);
    return index === middleIndex;
});

Handlebars.registerHelper('startsWith', function (str, includeStr, options) {
    if (str && str.startsWith(includeStr)) {
        return options.fn(this);
    } else {
        return options.inverse(this);
    }
});

Handlebars.registerHelper('isFederatedAPI', function (gatewayVendor) {
    if (!gatewayVendor || typeof gatewayVendor !== 'string') {
        return false;
    }
    return constants.FEDERATED_GATEWAY_VENDORS.includes(gatewayVendor);
});

Handlebars.registerHelper('formatPrice', function (price) {
    if (!price) return '0';
    return parseFloat(price).toString();
});

Handlebars.registerHelper('formatBillingPeriod', function (period) {
    const map = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };
    const p = String(period || '').toLowerCase();
    return map[p] || (p + 'ly');
});

Handlebars.registerHelper('formatTierRange', function (startUnit, endUnit) {
    const start = startUnit != null ? Number(startUnit).toLocaleString() : '0';
    if (endUnit == null || endUnit === '' || endUnit === Infinity) {
        return start + ' +';
    }
    return start + ' – ' + Number(endUnit).toLocaleString();
});

Handlebars.registerHelper('maskToken', function (token) {
    if (!token || token.length <= 4) return '****';
    return '****' + token.slice(-4);
});

Handlebars.registerHelper('isCurrentPlan', function (policyName, platformSubscriptions) {
    if (!Array.isArray(platformSubscriptions) || !policyName) return false;
    return platformSubscriptions.some(sub => sub.subscriptionPlanName === policyName);
});

// #endregion

app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        pruneSessionInterval: 3600,
        debug: (message) => logger.debug('Session store debug', { message }),
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        maxAge: 60 * 60 * 1000,
    },
}));

// Stripe webhook endpoint MUST use raw body parser for signature verification
const billingController = require('./controllers/billingController');
app.post('/webhooks/stripe/:orgId', express.raw({ type: 'application/json' }), billingController.handleStripeWebhook);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add audit logging middleware (human traffic)
app.use(auditMiddleware({
    excludePaths: ['/health', '/metrics', '/favicon.ico', '/styles', '/scripts', '/images', '/technical-styles', '/technical-scripts'],
    sensitiveFields: ['password', 'token', 'secret', 'key', 'authorization', 'idToken', 'accessToken', 'refreshToken']
}));

// Agent request detection — must run before agentActivityLogger so req.wantsJSON is set
app.use(agentNegotiation);

// Agent activity logging & anomaly detection — only activates when req.wantsJSON is true.
// Logs to agent-YYYY-MM-DD.log (separate from human audit log) and warns on anomalies.
// Thresholds can be tuned via config.agentMonitoring in config.json.
app.use(agentActivityLogger);

// Agent discoverability — advertise the agent manifest on every response so that any
// agent landing on any URL can find the discovery document without prior knowledge.
// Analogous to <link rel="canonical"> in SEO: passive, zero-cost, always present.
app.use((req, res, next) => {
    const host = req.protocol + '://' + req.get('host');
    res.set('Link', `<${host}/.well-known/llms.txt>; rel="agent-manifest"`);
    next();
});

app.use(passport.initialize());
app.use(passport.session());

let claimNames = {
    [constants.ROLES.ROLE_CLAIM]: config.roleClaim,
    [constants.ROLES.GROUP_CLAIM]: config.groupsClaim,
    [constants.ROLES.ORGANIZATION_CLAIM]: config.orgIDClaim
};
// configurePassport(config.identityProvider, claimNames);

const strategy = new OAuth2Strategy({
    name: 'Asgardeo',
    issuer: config.identityProvider.issuer,
    authorizationURL: config.identityProvider.authorizationURL,
    tokenURL: config.identityProvider.tokenURL,
    userInfoURL: config.identityProvider.userInfoURL,
    clientID: config.identityProvider.clientId,
    callbackURL: config.identityProvider.callbackURL,
    pkce: true,
    state: true,
    logoutURL: process.env.OAUTH2_LOGOUT_ENDPOINT,
    logoutRedirectURI: process.env.OAUTH2_POST_LOGOUT_REDIRECT_URI,
    certificate: '',
    jwksURL: process.env.OAUTH2_JWKS_ENDPOINT,
    passReqToCallback: true,
    scope: ['openid', 'profile', 'email'],
}, async (req, accessToken, refreshToken, params, profile, done) => {
    if (!accessToken) {
        return done(new Error('Access token missing'));
    }
    let orgList, userOrg;
    if (config.advanced.tokenExchanger?.enabled) {
        try {
            const exchangedToken = await util.tokenExchanger(accessToken, req.session.returnTo.split("/")[1]);
            const decodedExchangedToken = jwt.decode(exchangedToken);
            orgList = decodedExchangedToken.organizations;
            userOrg = decodedExchangedToken.organization.uuid;
            req['exchangedToken'] = exchangedToken;
        } catch (error) {
            logger.error('Token exchange failed during authentication', {
                error: error.message,
                returnTo: req.session.returnTo
            });
            return done(error);
        }
    }
    const decodedJWT = jwt.decode(params.id_token);
    const decodedAccessToken = jwt.decode(accessToken);
    const firstName = decodedJWT['given_name'] || decodedJWT['nickname'];
    const lastName = decodedJWT['family_name'];
    const organizationID = decodedJWT[claimNames[constants.ROLES.ORGANIZATION_CLAIM]] ? decodedJWT[config.orgIDClaim] : '';
    const roles = decodedJWT[claimNames[constants.ROLES.ROLE_CLAIM]] ? decodedJWT[config.roleClaim] : '';
    const groups = decodedJWT[claimNames[constants.ROLES.GROUP_CLAIM]] ? decodedJWT[config.groupsClaim] : '';
    let isAdmin, isSuperAdmin = false;
    if (roles.includes(constants.ROLES.SUPER_ADMIN) || roles.includes(constants.ROLES.ADMIN)) {
        isAdmin = true;
    }
    if (roles.includes(constants.ROLES.SUPER_ADMIN)) {
        isSuperAdmin = true;
    }
    const returnTo = req.session.returnTo;
    let view = '';
    if (returnTo) {
        const startIndex = returnTo.indexOf('/views/') + 7;
        const endIndex = returnTo.indexOf('/', startIndex) !== -1 ? returnTo.indexOf('/', startIndex) : returnTo.length;
        view = returnTo.substring(startIndex, endIndex);
    }
    let imageURL = "https://raw.githubusercontent.com/wso2/docs-bijira/refs/heads/main/en/devportal-theming/profile.svg";
    if (decodedJWT['google_pic_url']) {
        imageURL = decodedJWT['google_pic_url'];
    } else {
        imageURL = decodedJWT['picture'] ? decodedJWT['picture'] : imageURL;
    }
    profile = {
        'firstName': firstName ? (firstName.includes(" ") ? firstName.split(" ")[0] : firstName) : '',
        'lastName': lastName ? lastName : (firstName && firstName.includes(" ") ? firstName.split(" ")[1] : ''),
        'view': view,
        'idToken': params.id_token,
        'email': decodedJWT['email'] || req.session.username,
        [constants.ROLES.ORGANIZATION_CLAIM]: organizationID,
        'returnTo': req.session.returnTo,
        accessToken,
        refreshToken,
        'authorizedOrgs': orgList,
        'exchangeToken': req.exchangedToken,
        [constants.ROLES.ROLE_CLAIM]: roles,
        [constants.ROLES.GROUP_CLAIM]: groups,
        'isAdmin': isAdmin,
        'isSuperAdmin': isSuperAdmin,
        [constants.USER_ID]: decodedAccessToken[constants.USER_ID],
        serverId: SERVER_ID,
        imageURL: imageURL,
        userOrg: userOrg
    };
    req.session.regenerate((err) => {
        if (err) {
            logger.error('Session regeneration failed', { 
                error: err.message, 
                stack: err.stack,
                operation: 'sessionRegeneration'
            });
            return done(err);
        }
        // Store the new user profile in the session
        req.login(profile, (err) => {
            if (err) {
                logger.error('Login failed after session regeneration', { 
                    error: err.message, 
                    stack: err.stack,
                    operation: 'loginAfterSessionRegen'
                });
                return done(err);
            }
            return done(null, profile);
        });
    });

    logger.debug('Returning profile', { userId: profile.sub, organization: userOrg });

    //return done(null, profile);
});

strategy.authorizationParams = function (options) {
    const params = {};
    if (options.prompt) {
        params.prompt = options.prompt;
    }
    if (options.fidp) {
        params.fidp = options.fidp;
    }
    if (options.username) {
        params.username = options.username;
    }
    return params;
};

passport.use(strategy);

// Serialize user into the session
passport.serializeUser((user, done) => {
    logger.debug('Serializing user', { userId: user.sub });
    const profile = {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        imageURL: user.imageURL,
        view: user.view,
        idToken: user.idToken,
        [constants.ROLES.ORGANIZATION_CLAIM]: user[constants.ROLES.ORGANIZATION_CLAIM],
        'returnTo': user.returnTo,
        accessToken: user.accessToken,
        refreshToken: user.refreshToken,
        'exchangeToken': user.exchangeToken,
        'authorizedOrgs': user.authorizedOrgs,
        [constants.ROLES.ROLE_CLAIM]: user.roles,
        [constants.ROLES.GROUP_CLAIM]: user.groups,
        'isAdmin': user.isAdmin,
        'isSuperAdmin': user.isSuperAdmin,
        [constants.USER_ID]: user[constants.USER_ID],
        'userOrg': user.userOrg
    };
    lock.acquire('serialize', (release) => {
        release(null, profile);
    }, (err, ret) => {
        if (err) {
            return done(err);
        }
        done(null, ret);
    });
    //done(null, user);
});

// Deserialize user from the session
passport.deserializeUser(async (sessionData, done) => {
    //return done(null, sessionData);
    lock.acquire('deserialize', async (release) => {
        try {
            release(null, sessionData);
        } catch (err) {
            release(err);
        }
    }, (err, ret) => {
        if (err) {
            return done(err);
        }
        done(null, ret);
    });
});

// passport.deserializeUser((obj, done) => {
//     done(null, obj)
// });

app.use(constants.ROUTE.TECHNICAL_STYLES, express.static(path.join(require.main.filename, '../styles')));
app.use(constants.ROUTE.TECHNICAL_SCRIPTS, express.static(path.join(require.main.filename, '../scripts')));

// ─── Arazzo workflow files ────────────────────────────────────────────────────
// Serves the /workflows directory so agents can fetch the Arazzo spec directly.
// e.g. GET /workflows/integrate-api.arazzo.yaml
app.use('/workflows', express.static(path.join(process.cwd(), 'workflows')));

// ─── Shared helpers for agent.json responses ─────────────────────────────────

/**
 * Builds the authentication section shared by both agent discovery endpoints.
 * Reads IDP URLs from config so agents know how to obtain credentials upfront.
 */
function buildAgentAuthSection() {
    return {
        schemes: [
            {
                type: 'bearer',
                description: 'OAuth2 Bearer token. Required for subscriptions, applications, and key generation.',
                agent_instructions: 'Ask the user to provide their Bearer token, then include it as "Authorization: Bearer <token>" on each authenticated request.',
            },
            {
                type: 'apikey',
                description: 'Portal-level API key for service-to-service access. Does not grant user-scoped actions (subscriptions, key generation).',
                agent_instructions: 'Ask the user to provide their API key, then include it in the request header specified in the "header" field.',
            },
        ],
        hint: 'Read-only discovery requires no authentication. To subscribe to APIs or generate keys, authenticate as a user via Bearer token. Use the token_retrieval_flow in the bearer scheme — do not ask the user to manually locate or copy their token.',
    };
}


// ─── llms.txt — entry point for LLM/agent crawlers ──────────────────────────
// Served at both the well-known path and the root (both conventions are in use).
// Source of truth: /llms.txt in the project root. Edit that file — do not add
// content here. The handler reads the file and substitutes {host} at request time.
const llmsTxtTemplate = fs.readFileSync(path.join(process.cwd(), 'llms.txt'), 'utf8');

const llmsTxt = (req, res) => {
    const host = req.protocol + '://' + req.get('host');
    const content = llmsTxtTemplate.replace(/\{host\}/g, host);
    res.type('text/plain').send(content);
};

app.get('/llms.txt', llmsTxt);
app.get('/.well-known/llms.txt', llmsTxt);

// OpenAI-convention plugin manifest — many agent frameworks auto-check this path.
// Points agents into our llms.txt / agent.json discovery flow.
app.get('/.well-known/ai-plugin.json', (req, res) => {
    const host = req.protocol + '://' + req.get('host');
    res.json({
        schema_version: 'v1',
        name_for_human: 'API Developer Portal',
        name_for_model: 'api_developer_portal',
        description_for_human: 'Discover, subscribe to, and integrate with APIs programmatically.',
        description_for_model: 'A developer portal for discovering and integrating with APIs. Start by fetching the llms.txt endpoint for structured discovery instructions, then use the per-org agent.json for concrete URLs.',
        api: {
            type: 'openapi',
            url: `${host}/.well-known/llms.txt`,
        },
        auth: { type: 'none' },
        logo_url: `${host}/images/logo.png`,
        contact_email: '',
        legal_info_url: '',
    });
});

// Per-org agent discovery — resolves {orgName} and {viewName} into concrete usable URLs.
// Entry point for agents: read llms.txt first to find the org name, then call this.
// No authentication required.
app.get('/:orgName/agent.json', async (req, res) => {
    const { orgName } = req.params;
    if (['favicon.ico', 'images', 'portal', 'devportal', 'styles', 'scripts'].includes(orgName)) {
        return res.status(404).json({ error: 'not_found' });
    }
    try {
        const host = req.protocol + '://' + req.get('host');

        const orgDetails = await adminDao.getOrganization(orgName);
        const orgID = orgDetails.ORG_ID;

        // Fetch available views, fall back to ["default"] if none configured
        let views = ['default'];
        try {
            const viewRows = await apiDao.getAllViews(orgID);
            if (viewRows?.length > 0) {
                views = viewRows.map(v => v.dataValues?.NAME || v.NAME).filter(Boolean);
            }
        } catch (_) { /* use fallback */ }

        const defaultView = views[0];

        res.json({
            schema_version: '1.0',
            org: orgName,
            org_id: orgID,

            // All views available in this org — substitute one of these for {viewName}
            views,
            default_view: defaultView,

            important: 'All REST API requests MUST include the header Accept: application/json.' +
                'Without it, the portal returns HTML pages instead of machine-readable JSON.',

            authentication: buildAgentAuthSection(),

            // Concrete, ready-to-call URLs — no placeholders to resolve
            capabilities: [
                {
                    name: 'api_discovery',
                    description: 'List and search APIs in this org.',
                    auth_required: false,
                    accept: 'application/json',
                    urls: views.map(v => `${host}/${orgName}/views/${v}/apis`),
                    default_url: `${host}/${orgName}/views/${defaultView}/apis`,
                    query_params: {
                        query: 'Keyword search across API names. Example: ?query=payment',
                    },
                },
                {
                    name: 'mcp_server_discovery',
                    description: 'List MCP servers and their tools in this org.',
                    auth_required: false,
                    accept: 'application/json',
                    urls: views.map(v => `${host}/${orgName}/views/${v}/mcps`),
                    default_url: `${host}/${orgName}/views/${defaultView}/mcps`,
                },
                {
                    name: 'api_detail',
                    description: 'Get details of a specific API. Replace {apiHandle} with a handle from api_discovery.',
                    auth_required: false,
                    accept: 'application/json',
                    url_pattern: `${host}/${orgName}/views/${defaultView}/api/{apiHandle}`,
                    agent_access_levels: AGENT_ACCESS_LEVEL_DESCRIPTIONS,
                },
                {
                    name: 'api_specification',
                    description: 'Get the raw OpenAPI / AsyncAPI / GraphQL spec for an API.',
                    auth_required: false,
                    accept: 'application/json',
                    url_pattern: `${host}/${orgName}/views/${defaultView}/api/{apiHandle}/docs/specification`,
                },
                {
                    name: 'api_usage_workflow',
                    description: 'Get the API usage workflow for a specific API. These describe how the API\'s own '
                        + 'operations connect together for real-world use cases — the correct sequence of API calls, '
                        + 'required inputs/outputs between steps, and supported scenarios. Not all APIs have these — '
                        + 'check for has_api_usage_workflow or links.api_usage_workflow in the API detail response. '
                        + 'NOTE: These are different from the portal integration workflows (discover-api, '
                        + 'integrate-api, generate-*-key) which describe how to interact with the portal itself.',
                    auth_required: false,
                    accept: 'application/json',
                    url_pattern: `${host}/${orgName}/views/${defaultView}/api/{apiHandle}/docs/workflow`,
                },
                {
                    name: 'application_management',
                    description: 'Create and manage applications. Required before subscribing to APIs.'
                        + 'This is optional for APIs with gateway vendor set to ' + PLATFORM_GATEWAY,
                    auth_required: true,
                    auth_schemes: ['bearer'],
                    accept: 'application/json',
                    url: `${host}/devportal/organizations/${orgID}/applications`,
                },
                {
                    name: 'subscription_management',
                    description: 'Subscribe an application to an API under a chosen plan.' +
                        +'This is optional for APIs with gateway vendor set to ' + PLATFORM_GATEWAY,
                    auth_required: true,
                    auth_schemes: ['bearer'],
                    accept: 'application/json',
                    url: `${host}/devportal/organizations/${orgID}/subscriptions`,
                },
                {
                    name: 'api_key_generation',
                    description: 'Generate, regenerate, or revoke API keys for APIs with gateway vendor'
                        + PLATFORM_GATEWAY,
                    auth_required: true,
                    auth_schemes: ['bearer'],
                    accept: 'application/json',
                    url: `${host}/devportal/organizations/${orgID}/platform-api-keys/generate`,
                },
                {
                    name: 'oauth2_key_generation',
                    description: 'Generate client ID and secret for the created application.',
                    auth_required: true,
                    auth_schemes: ['bearer'],
                    accept: 'application/json',
                    url: `${host}/devportal/organizations/${orgID}/oauth2/generate`,
                },
            ],

            // Arazzo workflows — machine-readable step-by-step integration logic.
            // Each workflow lives in its own file. Fetch only what you need.
            // IMPORTANT: After discovery, build your integration code FIRST using the spec
            // with placeholder env vars. Only then fetch the credential workflow.
            workflows: {
                orchestrator_url: `${host}/workflows/integrate-api.arazzo.yaml`,
                portal_host: host,
                note: 'Each workflow is a separate file. Fetch only the file matching your current phase to keep payloads small.',
                phases: [
                    {
                        phase: 1,
                        name: 'discovery',
                        file: `${host}/workflows/discover-api.arazzo.yaml`,
                        workflowId: 'discover-api',
                        summary: 'Search the catalog, evaluate candidates, and recommend the best API.',
                        auth_required: false,
                        use_when: 'Always — this is the first step.',
                    },
                    {
                        phase: 2,
                        name: 'build_integration',
                        file: null,
                        workflowId: null,
                        summary: 'Build your integration code using the API spec from Phase 1. Use placeholder env vars (API_BASE_URL, API_KEY). Use sandbox endpoint if available.',
                        auth_required: false,
                        use_when: 'Always — immediately after discovery, BEFORE credential generation.',
                    },
                    {
                        phase: 3,
                        name: 'generate_credentials',
                        summary: 'Generate credentials. Fetch ONLY the file matching gateway_vendor and securityScheme.',
                        auth_required: true,
                        use_when: 'After integration code is built. Requires bearer token.',
                        options: [
                            {
                                file: `${host}/workflows/generate-wso2-key.arazzo.yaml`,
                                workflowId: 'generate-wso2-platform-api-key',
                                use_when: 'gateway_vendor == "wso2/api-platform" and securityScheme is api_key.',
                            },
                            {
                                file: `${host}/workflows/generate-cloud-api-key.arazzo.yaml`,
                                workflowId: 'generate-cloud-gateway-api-key',
                                use_when: 'gateway_vendor is NOT "wso2/api-platform" and securityScheme is api_key.',
                            },
                            {
                                file: `${host}/workflows/generate-oauth2-credentials.arazzo.yaml`,
                                workflowId: 'generate-oauth2-credentials',
                                use_when: 'gateway_vendor is NOT "wso2/api-platform" and securityScheme is oauth2.',
                            },
                        ],
                    },
                ],
            },

            // What each error response means in this portal's context and what to do next.
            // Agents should consult this before retrying, escalating, or giving up.
            common_errors: {
                overview: 'All error responses include an "error" field (machine-readable code) and a "message" field (human-readable detail). Use the "error" field for programmatic handling.',
                errors: [
                    {
                        status: 400,
                        error_code: 'bad_request',
                        meaning: 'The request body is malformed or missing required fields.',
                        common_causes: [
                            'Missing required field when creating an application or subscription.',
                            'Invalid JSON body.',
                            'Uploading a file in an unsupported format.',
                        ],
                        resolution: 'Read the "message" field for which field is missing or invalid. Correct the request body and retry. Do not retry without fixing the payload.',
                    },
                    {
                        status: 401,
                        error_code: 'unauthorized',
                        meaning: 'No credentials were provided or the bearer token has expired.',
                        common_causes: [
                            'Calling a protected endpoint (application, subscription, key management) without a bearer token.',
                            'Token has expired mid-session.',
                        ],
                        resolution: 'Re-authenticate using the auth flow described in the "authentication" section of this document. Obtain a fresh token and retry the request.',
                    },
                    {
                        status: 403,
                        error_code: 'access_restricted',
                        meaning: 'The request was understood but the caller is not permitted to perform this action.',
                        common_causes: [
                            'Fetching the spec of a read_only API — agents are not entitled to the spec for read_only APIs.',
                            'Fetching any resource belonging to a hidden API.',
                            'Authenticated user does not have sufficient portal permissions for the requested operation.',
                        ],
                        resolution: 'Check the "level" field in the error body. If "read_only" or "hidden", pick a different API with agent_access.level of "full" or "human_approval". For permission errors, do not retry — escalate to the human operator.',
                    },
                    {
                        status: 404,
                        error_code: 'not_found',
                        meaning: 'The requested resource does not exist or is intentionally not visible to agents.',
                        common_causes: [
                            'Incorrect apiHandle — double-check the handle from the api_discovery response.',
                            'The API has agent_access.level of "hidden" — these are filtered out and return 404 to agents.',
                            'The organization name is wrong.',
                        ],
                        resolution: 'Verify the handle by re-fetching the api_discovery list. Do not guess or iterate through handles. If the org returns 404, confirm the org name with the user.',
                    },
                    {
                        status: 409,
                        error_code: 'conflict',
                        meaning: 'The resource you are trying to create already exists.',
                        common_causes: [
                            'Creating an application with a name that already exists for this user.',
                            'Subscribing an application to an API it is already subscribed to.',
                        ],
                        resolution: 'List existing applications or subscriptions first. If the resource already exists, reuse it rather than creating a new one.',
                    },
                    {
                        status: 429,
                        error_code: 'rate_limited',
                        meaning: 'The agent is making requests too fast. The portal has detected abnormal request patterns.',
                        common_causes: [
                            'More than 60 requests per minute from the same agent.',
                            'More than 500 requests per hour.',
                            'Iterating through more than 20 distinct API handles in under 5 minutes (detected as scanning).',
                            'More than 5 consecutive 404 responses (detected as probing).',
                        ],
                        resolution: 'Back off immediately. Wait at least 60 seconds before retrying. Use ?query= to search for specific APIs rather than iterating through the catalog. If the task genuinely requires broad catalog access, inform the human operator.',
                    },
                    {
                        status: 500,
                        error_code: 'internal_error',
                        meaning: 'An unexpected error occurred on the portal server.',
                        resolution: 'Retry once after a short delay (5–10 seconds). If the error persists, do not keep retrying — inform the human operator that the portal is experiencing an issue.',
                    },
                    {
                        status: 'timeout',
                        meaning: 'The portal did not respond within the expected window.',
                        common_causes: [
                            'Fetching a large API specification.',
                            'Transient portal load spike.',
                        ],
                        resolution: 'Retry once with a longer timeout. If it times out again, inform the human operator rather than retrying in a loop.',
                    },
                ],
            },
        });
    } catch (error) {
        logger.error('Per-org agent.json error', { orgName, error: error.message });
        res.status(404).json({ error: 'not_found', message: `Organization '${orgName}' not found.` });
    }
});

//backend routes
app.use(constants.ROUTE.DEV_PORTAL, devportalRoute);

if (config.mode === constants.DEV_MODE) {
    app.use(constants.ROUTE.STYLES, express.static(path.join(process.cwd(), filePrefix + 'styles')));
    app.use(constants.ROUTE.IMAGES, express.static(path.join(process.cwd(), filePrefix + 'images')));
    app.use(constants.ROUTE.MOCK, express.static(path.join(process.cwd(), filePrefix + 'mock')));
    app.use(constants.ROUTE.DEFAULT, designRoute);
} else {
    app.use(constants.ROUTE.STYLES, express.static(path.join(process.cwd(), './src/defaultContent/' + 'styles')));
    app.use(constants.ROUTE.IMAGES, express.static(path.join(process.cwd(), './src/defaultContent/' + 'images')));
    app.use(constants.ROUTE.DEFAULT, authRoute);
    app.use(constants.ROUTE.DEFAULT, apiContent);
    app.use(constants.ROUTE.DEFAULT, applicationContent);
    app.use(constants.ROUTE.DEFAULT, orgContent);
    app.use(constants.ROUTE.DEFAULT, settingsRoute);
    app.use(constants.ROUTE.DEFAULT, subscriptionsContent);
    app.use(constants.ROUTE.DEFAULT, customContent);
}


app.use( (err, req, res, next) => {
    Handlebars.registerPartial('header', '');
    Handlebars.registerPartial('sidebar', '');
    logger.error('Application error', { 
        error: err.message, 
        stack: err.stack,
        url: req.url,
        method: req.method,
        operation: 'expressErrorHandler'
    });
    let templateContent = {
        devportalMode: 'DEFAULT',
        baseUrl: '/' + req.originalUrl?.split('/')[1] + '/' + constants.ROUTE.VIEWS_PATH + "default",
        errorMessage: "Oops! Something went wrong"
    }
    let html = "";
    if (err.status === 401) {
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).send("Logout failed");
            }
        });
        templateContent.errorMessage = constants.ERROR_MESSAGE.COMMON_AUTH_ERROR_MESSAGE;
        html = util.renderTemplate('../pages/error-page/page.hbs', 'src/pages/error-layout/main.hbs', templateContent, true);
    } else {
        html = util.renderTemplate('../pages/error-page/page.hbs', 'src/pages/error-layout/main.hbs', templateContent, true);
    }
    res.status(err.status || 500).send(`
      ${html}
    `);
});


const PORT = process.env.PORT || config.defaultPort;
if (config.advanced.http) {
    http.createServer(app).listen(PORT, '0.0.0.0', () => {
        logStartupInfo();
    });

} else {
    try {
        const certPath = path.join(process.cwd(), config.serverCerts.pathToCert);
        const keyPath = path.join(process.cwd(), config.serverCerts.pathToPK);
        const caPath = path.join(process.cwd(), config.serverCerts.pathToCA);

        const serverCert = fs.readFileSync(certPath);
        const serverKey = fs.readFileSync(keyPath);
        const caCert = fs.readFileSync(caPath);

        https.createServer({
            key: serverKey,
            cert: serverCert,
            ca: caCert,
            requestCert: true,
            rejectUnauthorized: false
        }, app).listen(PORT, () => {
            logStartupInfo();
        });

    } catch (err) {
        logger.error('Error setting up HTTPS server', { 
            error: err.message, 
            stack: err.stack,
            operation: 'httpsServerSetup'
        });
    }
}

const logStartupInfo = () => {
    logger.info(`Developer Portal V2 is running on port ${PORT}`);
    logger.info(`Mode: ${config.mode}`);

    if (config.mode === constants.DEV_MODE) {
        logger.info('⚠️  Since you are in DEV mode, ensure default content is available at configured pathToContent ' + 
            'and mock folder must exist in root directory');
    }

    const visitUrl = config.baseUrl + (config.mode === constants.DEV_MODE ? "/views/default" : "/<organization>/views/default");
    logger.info(`Visit ${visitUrl}`);
    
    // Start SDK cleanup scheduler
    try {
        sdkJobService.startSDKCleanupScheduler();
        logger.info('SDK cleanup scheduler started successfully');
    } catch (error) {
        logger.warn('Could not start SDK cleanup scheduler', { 
            error: error.message, 
            stack: error.stack 
        });
    }
};

// Handle Uncaught Exceptions
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception - Application will exit', { 
        error: err.message, 
        stack: err.stack,
        type: 'uncaughtException'
    });
});

// Handle Unhandled Rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection - Application will exit', { 
        reason: reason?.message || reason, 
        promise: promise?.toString(),
        type: 'unhandledRejection'
    });
});

// Graceful shutdown handlers
const gracefulShutdown = (signal) => {
    logger.info('Graceful shutdown initiated...', { 
        signal,
        message: `Received ${signal}. Gracefully shutting down...`
    });
    
    // Stop SDK cleanup scheduler
    try {
        sdkJobService.stopSDKCleanupScheduler();
        logger.info('SDK cleanup scheduler stopped successfully');
    } catch (error) {
        logger.warn('Error stopping SDK cleanup scheduler', { 
            error: error.message, 
            stack: error.stack 
        });
    }
    
    logger.info('Application shutdown complete');
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
