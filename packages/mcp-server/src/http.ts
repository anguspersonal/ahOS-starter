// MUST be first: Sentry patches http/express as they load, so init has to
// run before any of them are imported. See ./instrument.ts.
import "./instrument.js";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	mcpAuthRouter,
	getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
	gateMcpGet,
	gateMcpPost,
	gateMcpSessionRequest,
} from "./httpSessionGate.js";
import { httpEnv } from "./env.js";
import { getCurrentUserId } from "./identity.js";
import { createServer } from "./server.js";
import { loadHandshakeReads } from "./handshakeReads.js";
import { startScheduler } from "./schedule/index.js";
import { SupabaseClientStore } from "./auth/supabaseClientStore.js";
import { OwnerOAuthProvider, OWNER_SCOPE } from "./auth/ownerOAuthProvider.js";
import { ownerLoginRouter } from "./auth/loginRouter.js";
import { notionWebhookRouter } from "./webhooks/notionWebhook.js";
import { captureWebhookRouter } from "./webhooks/captureWebhook.js";
import { slackInteractiveRouter } from "./webhooks/slackInteractive.js";
import { slackWebhookRouter } from "./webhooks/slackWebhook.js";
import { driveWebhookRouter } from "./webhooks/driveWebhook.js";
import { actionsRouter } from "./actions/actionsRouter.js";
import { serverRegistry } from "./actions/serverRegistry.js";
import { configureLedger } from "./actions/ledger.js";
import { configureApprovals } from "./actions/approvals.js";
import { configureActionScope } from "./actions/scope.js";

/**
 * Remote, authenticated HTTP serving surface for the ahkms MCP server
 * (ADR-019 follow-up #1 / issue #84). Speaks MCP Streamable HTTP behind a self-hosted
 * OAuth 2.1 gate, so the knowledge store is reachable from any environment (claude.ai
 * web/mobile, Cursor, another machine) — not just a local stdio subprocess.
 *
 * The Supabase service-role key stays in this process's env; clients present an OAuth
 * bearer token minted by {@link OwnerOAuthProvider}, never the Supabase credential.
 */
async function main() {
	configureApprovals();
	configureLedger();
	configureActionScope();
	serverRegistry();
	if (process.env.CHECK_SMOKE === "1") {
		return;
	}
	const cfg = httpEnv();
	const publicUrl = new URL(cfg.publicUrl);
	const mcpUrl = new URL("/mcp", publicUrl);

	const provider = new OwnerOAuthProvider(
		cfg,
		new SupabaseClientStore(),
		getCurrentUserId(),
	);

	const app = express();
	app.disable("x-powered-by");
	// Behind Railway's single proxy hop: trust one layer of X-Forwarded-For so `req.ip`
	// reflects the real client, which the /owner-login per-IP brute-force limiter keys on.
	app.set("trust proxy", 1);

	// Centralised Action Registry HTTP endpoint (ADR-100 / #1317 / #1440).
	// Web client and other internal callers invoke CAR actions via authenticated
	// Supabase JWT bearer tokens, executing server-side with audit logging.
	// Mounted before the global CORS middleware so actionsRouter's exact-origin
	// policy and allowed headers handle action preflight and POST requests.
	app.use("/api/actions", actionsRouter());

	// Browser MCP clients (claude.ai web) make cross-origin requests; expose the session
	// and auth-challenge headers they need to read.
	app.use(
		cors({
			origin: true,
			exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
			allowedHeaders: [
				"Content-Type",
				"Authorization",
				"mcp-session-id",
				"mcp-protocol-version",
			],
		}),
	);

	// Liveness probe (Railway). Deliberately unauthenticated and leaks nothing.
	app.get("/healthz", (_req, res) => {
		res.json({ ok: true, server: "ahOS" });
	});

	// Inbound Notion webhook (#546 / ADR-048) — the automations capability's fast
	// path. Outside the OAuth bearer gate: deliveries authenticate via the
	// X-Notion-Signature HMAC (verification token in env), not a bearer token.
	app.use("/webhooks/notion", notionWebhookRouter());

	// Inbound capture webhook (ADR-048) — direct external artifact ingestion.
	app.use("/webhooks/capture", captureWebhookRouter());

	// Inbound Slack interactivity webhook (#1544 / ADR-104): inline owner approval/rejection.
	app.use("/webhooks/slack/interactive", slackInteractiveRouter());

	// Inbound Slack webhook (ADR-048) — event-driven message and note capture.
	app.use("/webhooks/slack", slackWebhookRouter());

	// Inbound Google Drive webhook (ADR-048) — push-notification change discovery.
	app.use("/webhooks/drive", driveWebhookRouter());

	// OAuth 2.1 authorization-server + protected-resource metadata, DCR, token, revoke.
	// Mounted at root so the well-known discovery endpoints resolve where clients expect.
	app.use(
		mcpAuthRouter({
			provider,
			issuerUrl: publicUrl,
			baseUrl: publicUrl,
			resourceServerUrl: mcpUrl,
			scopesSupported: [OWNER_SCOPE],
			resourceName: "ahkms knowledge store",
		}),
	);

	// The bespoke single-owner consent POST (step 2 of authorize).
	app.use(ownerLoginRouter(provider));

	// Everything past here requires a valid bearer token; unauthenticated calls get a 401
	// with a WWW-Authenticate header pointing at the protected-resource metadata.
	const requireAuth = requireBearerAuth({
		verifier: provider,
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
	});

	// One Streamable HTTP transport per MCP session, keyed by the Mcp-Session-Id header.
	const transports = new Map<string, StreamableHTTPServerTransport>();

	// 10 MB ceiling: tool calls like `capture` can carry a sizeable document body, well
	// above express's 100 KB default.
	const mcpJson = express.json({ limit: "10mb" });

	app.post("/mcp", requireAuth, mcpJson, async (req, res) => {
		const sessionId = req.header("mcp-session-id");
		let transport = sessionId ? transports.get(sessionId) : undefined;

		// Status-code contract lives in httpSessionGate.ts — in particular, an unknown
		// session id MUST 404 (not 400) so clients re-initialize transparently after a
		// deploy wipes the in-memory session map.
		const decision = gateMcpPost({
			sessionId,
			sessionKnown: transport !== undefined,
			isInitialize: isInitializeRequest(req.body),
		});
		if (decision.kind === "reject") {
			const rpcMethod =
				typeof req.body === "object" &&
				req.body !== null &&
				"method" in req.body &&
				typeof (req.body as { method?: unknown }).method === "string"
					? (req.body as { method: string }).method
					: Array.isArray(req.body)
						? "batch"
						: "unknown";
			console.error(
				`[mcp-http] rejected POST (${decision.status}): session ${
					sessionId ? `'${sessionId.slice(0, 8)}...' unknown` : "id missing"
				} (method=${rpcMethod}); ${transports.size} live session(s)`,
			);
			res.status(decision.status).json({
				jsonrpc: "2.0",
				error: { code: decision.code, message: decision.message },
				id: null,
			});
			return;
		}

		if (!transport) {
			// Each session gets its own server instance sharing the same tool set. Tone
			// rules and the hot tier are re-read per session (#819, #1023), bounded by
			// HANDSHAKE_READ_TIMEOUT_MS so a slow DB read cannot time out connect (#1714).
			const { toneRules, hotRows, durationMs } = await loadHandshakeReads();

			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (id) => {
					transports.set(id, transport!);
					console.error(
						`[mcp-http] session initialized: '${id.slice(0, 8)}…' (${transports.size} live, handshake reads ${durationMs}ms)`,
					);
				},
			});
			transport.onclose = () => {
				if (transport!.sessionId) {
					transports.delete(transport!.sessionId);
					console.error(
						`[mcp-http] session closed: '${transport!.sessionId.slice(0, 8)}…' (${transports.size} live)`,
					);
				}
			};
			await createServer(toneRules, hotRows).connect(transport);
		}

		await transport.handleRequest(req, res, req.body);
	});

	// GET /mcp: standalone server-initiated SSE stream is not offered; return 405
	// per the MCP Streamable HTTP spec ("Listening for Messages from the Server" §3)
	// so clients do not hold open a silent SSE connection that hits proxy idle
	// timeouts and exhausts their retry budget.
	app.get("/mcp", requireAuth, (_req, res) => {
		const decision = gateMcpGet();
		res.status(decision.status).set("Allow", decision.allow).send(decision.message);
	});

	// DELETE (session teardown) reuses the session.
	// Status-code contract lives in httpSessionGate.ts (gateMcpSessionRequest) — same
	// 404-vs-400 split as POST, tested there rather than hand-rolled per verb.
	app.delete("/mcp", requireAuth, async (req, res) => {
		const sessionId = req.header("mcp-session-id");
		const transport = sessionId ? transports.get(sessionId) : undefined;
		const decision = gateMcpSessionRequest({
			sessionId,
			sessionKnown: transport !== undefined,
		});
		if (decision.kind === "reject") {
			res.status(decision.status).send(decision.message);
			return;
		}
		await transport!.handleRequest(req, res);
	});

	app.listen(cfg.port, () => {
		console.error(
			`ahOS MCP server (HTTP) listening on :${cfg.port} — public ${cfg.publicUrl}, MCP endpoint ${mcpUrl.href}`,
		);
	});

	startScheduler();
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
