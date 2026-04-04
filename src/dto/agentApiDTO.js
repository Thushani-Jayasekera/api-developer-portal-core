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
 * DTOs for agent-facing JSON responses.
 *
 * These shape the machine-readable API catalog responses served when a client
 * sends `Accept: application/json`. The format is designed to give agents
 * everything they need to discover, evaluate, and integrate with APIs without
 * needing to scrape HTML or infer structure from URLs.
 *
 * Agent access levels (stored in apiInfo.agentAccess):
 *   full            - Agents can discover and use the API freely (default)
 *   read_only       - Agents can discover and read docs, but cannot subscribe/call
 *   human_approval  - Discovery and docs allowed; subscription requires human approval
 *   hidden          - Not visible to agents at all (filtered out before this DTO is used)
 *
 * Note: `agentAccess` is a portal-specific design. No industry standard exists
 * for per-API agent access control as of April 2026. This field will be mapped
 * to emerging standards (MCP annotations, IETF CHEQ) as they mature.
 */

const AGENT_ACCESS_LEVELS = {
    FULL: 'full',
    READ_ONLY: 'read_only',
    HUMAN_APPROVAL: 'human_approval',
    HIDDEN: 'hidden',
};

/**
 * Resolves the agentAccess configuration from API metadata.
 * Reads from apiInfo.agentAccess if set; defaults to 'full'.
 */
const resolveAgentAccess = (apiMetadata) => {
    const configured = apiMetadata?.apiInfo?.agentAccess;
    if (!configured) {
        return { level: AGENT_ACCESS_LEVELS.FULL };
    }
    if (typeof configured === 'string') {
        return { level: configured };
    }
    return configured;
};

/**
 * Returns true if the API should be hidden from agents entirely.
 */
const isHiddenFromAgents = (apiMetadata) => {
    return resolveAgentAccess(apiMetadata).level === AGENT_ACCESS_LEVELS.HIDDEN;
};

/**
 * Shapes a single API entry for the agent catalog list response.
 */
const toAgentApiSummary = (apiMetadata, baseUrl) => {
    const agentAccess = resolveAgentAccess(apiMetadata);
    const handle = apiMetadata.apiHandle;
    const isMCP = apiMetadata.apiInfo?.apiType === 'MCP';
    const apiPathSegment = isMCP ? 'mcp' : 'api';

    const summary = {
        id: apiMetadata.apiID,
        name: apiMetadata.apiInfo?.apiName,
        handle,
        version: apiMetadata.apiInfo?.apiVersion,
        description: apiMetadata.apiInfo?.apiDescription || null,
        type: apiMetadata.apiInfo?.apiType,
        visibility: apiMetadata.apiInfo?.visibility || 'PUBLIC',
        tags: apiMetadata.apiInfo?.tags || [],
        agent_access: agentAccess,
        links: {
            self: `${baseUrl}/${apiPathSegment}/${handle}`,
        },
    };

    // Only expose endpoint and spec links for non-hidden, accessible APIs
    if (agentAccess.level !== AGENT_ACCESS_LEVELS.HIDDEN) {
        if (apiMetadata.endPoints?.productionURL) {
            summary.endpoints = {
                production: apiMetadata.endPoints.productionURL,
            };
            if (apiMetadata.endPoints?.sandboxURL) {
                summary.endpoints.sandbox = apiMetadata.endPoints.sandboxURL;
            }
        }

        if (agentAccess.level !== AGENT_ACCESS_LEVELS.READ_ONLY) {
            summary.links.specification = `${baseUrl}/${apiPathSegment}/${handle}/docs/specification`;
        }

        if (apiMetadata.subscriptionPolicyDetails?.length > 0) {
            summary.subscription_plans = apiMetadata.subscriptionPolicyDetails.map(toAgentSubscriptionPlan);
        }
    }

    return summary;
};

/**
 * Shapes a single API entry for the agent API detail response.
 */
const toAgentApiDetail = (apiMetadata, scopes, baseUrl) => {
    const agentAccess = resolveAgentAccess(apiMetadata);
    const handle = apiMetadata.apiHandle;
    const isMCP = apiMetadata.apiInfo?.apiType === 'MCP';
    const apiPathSegment = isMCP ? 'mcp' : 'api';

    const detail = {
        id: apiMetadata.apiID,
        name: apiMetadata.apiInfo?.apiName,
        handle,
        version: apiMetadata.apiInfo?.apiVersion,
        description: apiMetadata.apiInfo?.apiDescription || null,
        type: apiMetadata.apiInfo?.apiType,
        provider: apiMetadata.provider || null,
        visibility: apiMetadata.apiInfo?.visibility || 'PUBLIC',
        tags: apiMetadata.apiInfo?.tags || [],
        agent_access: agentAccess,
    };

    if (apiMetadata.endPoints?.productionURL || apiMetadata.endPoints?.sandboxURL) {
        detail.endpoints = {};
        if (apiMetadata.endPoints.productionURL) {
            detail.endpoints.production = apiMetadata.endPoints.productionURL;
        }
        if (apiMetadata.endPoints.sandboxURL) {
            detail.endpoints.sandbox = apiMetadata.endPoints.sandboxURL;
        }
    }

    if (scopes?.length > 0) {
        detail.scopes = scopes;
    }

    if (apiMetadata.subscriptionPolicies?.length > 0) {
        detail.subscription_plans = apiMetadata.subscriptionPolicies.map(toAgentSubscriptionPlan);
    }

    detail.links = {
        self: `${baseUrl}/${apiPathSegment}/${handle}`,
        specification: `${baseUrl}/${apiPathSegment}/${handle}/docs/specification`,
    };

    // For human_approval APIs, include where a human can approve agent access
    if (agentAccess.level === AGENT_ACCESS_LEVELS.HUMAN_APPROVAL) {
        detail.links.approval = agentAccess.approval_url || `${baseUrl}/${apiPathSegment}/${handle}/subscriptions`;
    }

    return detail;
};

/**
 * Shapes MCP server schema tools for the agent response.
 */
const toAgentMCPDetail = (apiMetadata, schemaDefinition, baseUrl) => {
    const detail = toAgentApiDetail(apiMetadata, null, baseUrl);

    if (schemaDefinition?.length > 0) {
        detail.tools = schemaDefinition.map((tool) => ({
            name: tool.name,
            description: tool.description || null,
            input_schema: tool.inputSchema || null,
        }));
    }

    if (apiMetadata.endPoints?.productionURL) {
        detail.server_url = `${apiMetadata.endPoints.productionURL}/mcp`;
    }

    return detail;
};

/**
 * Shapes a subscription plan for agent responses.
 */
const toAgentSubscriptionPlan = (plan) => ({
    name: plan.policyName || plan.name,
    display_name: plan.displayName || plan.policyName || plan.name,
    description: plan.description || null,
    request_count: plan.requestCount || null,
    billing_plan: plan.billingPlan || null,
});

/**
 * Builds the paginated list response for agent API catalog.
 */
const toAgentApiListResponse = (metaDataList, baseUrl, isMCPView) => {
    const visible = metaDataList.filter((api) => !isHiddenFromAgents(api));
    const summaries = visible.map((api) => toAgentApiSummary(api, baseUrl));

    return {
        count: summaries.length,
        [isMCPView ? 'mcp_servers' : 'apis']: summaries,
    };
};

module.exports = {
    AGENT_ACCESS_LEVELS,
    isHiddenFromAgents,
    toAgentApiListResponse,
    toAgentApiDetail,
    toAgentMCPDetail,
};
