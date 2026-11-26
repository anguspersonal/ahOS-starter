/**
 * HTTP Route Exemptions (#1407, ADR-100).
 *
 * This is a reviewed file: adding an entry requires review:architect sign-off.
 * Any other new route must be written as a CAR action and served through /api/actions.
 */

export const HTTP_ROUTE_EXEMPTION_REASONS = [
	"upload",
	"streaming",
	"inbound_webhook",
	"oauth_callback",
	"non_json_response",
	"public_unauthenticated",
	"health",
] as const;

export type HttpRouteExemptionReason = (typeof HTTP_ROUTE_EXEMPTION_REASONS)[number];

export interface HttpRouteExemption {
	reason: HttpRouteExemptionReason;
	note: string;
}

export const HTTP_ROUTE_EXEMPTIONS: Record<string, HttpRouteExemption> = {
	"/healthz": {
		reason: "health",
		note: "Liveness probe (Railway). Deliberately unauthenticated and leaks nothing.",
	},
	"/webhooks/notion": {
		reason: "inbound_webhook",
		note: "Inbound Notion webhook (ADR-048) authenticated via X-Notion-Signature HMAC.",
	},
	"/webhooks/capture": {
		reason: "inbound_webhook",
		note: "Inbound capture webhook (ADR-048) for direct external artifact ingestion.",
	},
	"/webhooks/slack/interactive": {
		reason: "inbound_webhook",
		note: "Inbound Slack interactivity webhook (#1544, ADR-104) authenticated via X-Slack-Signature HMAC.",
	},
	"/webhooks/slack": {
		reason: "inbound_webhook",
		note: "Inbound Slack webhook (ADR-048) for event-driven message and note capture.",
	},
	"/webhooks/drive": {
		reason: "inbound_webhook",
		note: "Inbound Google Drive webhook (ADR-048) for push-notification change discovery.",
	},
	mcpAuthRouter: {
		reason: "oauth_callback",
		note: "OAuth 2.1 authorization-server metadata, DCR, token, and revoke endpoints mounted at root.",
	},
	ownerLoginRouter: {
		reason: "oauth_callback",
		note: "Bespoke single-owner consent POST step for OAuth authorization.",
	},
	"/mcp": {
		reason: "streaming",
		note: "Streamable HTTP transport endpoint for MCP protocol SSE/POST session communication.",
	},
};
