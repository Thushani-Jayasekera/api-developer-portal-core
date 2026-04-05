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
 * Agent access levels and their descriptions are defined in AGENT_ACCESS_LEVELS and
 * AGENT_ACCESS_LEVEL_DESCRIPTIONS below — those are the single source of truth.
 *
 * The `agentAccess` object on each API contains only `level` and `reason`. No
 * provider-side contact or approval URL — the approval relationship is between the
 * agent and its own human operator, which the portal has no visibility into.
 */

const AGENT_ACCESS_LEVELS = {
    FULL: 'full',
    READ_ONLY: 'read_only',
    HUMAN_APPROVAL: 'human_approval',
    HIDDEN: 'hidden',
};

// Single source of truth for access level descriptions — used in agent.json discovery
// endpoints, llms.txt, and anywhere else that needs to explain levels to agents or humans.
const AGENT_ACCESS_LEVEL_DESCRIPTIONS = {
    [AGENT_ACCESS_LEVELS.FULL]: 'Agents can discover and use this API freely.',
    [AGENT_ACCESS_LEVELS.READ_ONLY]: 'Agents can read docs and spec but cannot subscribe or call.',
    [AGENT_ACCESS_LEVELS.HUMAN_APPROVAL]: 'This API requires a human in the loop. Agents can discover and read its documentation, but must pause and get explicit consent from their human operator before subscribing or invoking.',
    [AGENT_ACCESS_LEVELS.HIDDEN]: 'Not visible to agents.',
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
            // Prefer sandbox for development/testing; fall back to production
            summary.recommended_base_url = apiMetadata.endPoints.sandboxURL || apiMetadata.endPoints.productionURL;
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
const toAgentApiDetail = (apiMetadata, scopes, baseUrl, host) => {
    const agentAccess = resolveAgentAccess(apiMetadata);
    const handle = apiMetadata.apiHandle;
    const isMCP = apiMetadata.apiInfo?.apiType === 'MCP';
    const apiPathSegment = isMCP ? 'mcp' : 'api';

    const gatewayVendor = apiMetadata.apiInfo?.gatewayVendor || null;

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
        gateway_vendor: gatewayVendor,
        subscription_required: gatewayVendor !== 'wso2/api-platform',
    };

    if (apiMetadata.endPoints?.productionURL || apiMetadata.endPoints?.sandboxURL) {
        detail.endpoints = {};
        if (apiMetadata.endPoints.productionURL) {
            detail.endpoints.production = apiMetadata.endPoints.productionURL;
        }
        if (apiMetadata.endPoints.sandboxURL) {
            detail.endpoints.sandbox = apiMetadata.endPoints.sandboxURL;
        }
        // Prefer sandbox for development/testing; fall back to production
        detail.recommended_base_url = apiMetadata.endPoints.sandboxURL || apiMetadata.endPoints.productionURL;
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

    if (host) {
        detail._discovery = buildDiscovery(host, baseUrl);
    }

    return detail;
};

/**
 * Shapes MCP server schema tools for the agent response.
 */
const toAgentMCPDetail = (apiMetadata, schemaDefinition, baseUrl, host) => {
    const detail = toAgentApiDetail(apiMetadata, null, baseUrl, host);

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
 * Builds the discovery block included in every agent JSON response.
 * Regardless of which URL the agent landed on, the response body itself
 * tells them where to find llms.txt and the org manifest.
 * orgName is the first path segment of baseUrl (e.g. "/acme/views/default" → "acme").
 */
const buildDiscovery = (host, baseUrl) => {
    const orgName = baseUrl.split('/').filter(Boolean)[0];
    return {
        llms_txt: `${host}/llms.txt`,
        org_manifest: `${host}/${orgName}/agent.json`,
    };
};

/**
 * Builds the paginated list response for agent API catalog.
 */
const toAgentApiListResponse = (metaDataList, baseUrl, isMCPView, host) => {
    const visible = metaDataList.filter((api) => !isHiddenFromAgents(api));
    const summaries = visible.map((api) => toAgentApiSummary(api, baseUrl));

    return {
        _discovery: host ? buildDiscovery(host, baseUrl) : undefined,
        count: summaries.length,
        [isMCPView ? 'mcp_servers' : 'apis']: summaries,
    };
};

module.exports = {
    AGENT_ACCESS_LEVELS,
    AGENT_ACCESS_LEVEL_DESCRIPTIONS,
    resolveAgentAccess,
    isHiddenFromAgents,
    toAgentApiListResponse,
    toAgentApiDetail,
    toAgentMCPDetail,
};
