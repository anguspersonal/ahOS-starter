import type { McpPassthroughCallResult, McpPassthroughPort, McpPassthroughToolSummary } from "../../ports/mcpPassthrough.js";

// Brevo's provider-hosted MCP server (ADR-055). Unlike Dex's server (dexClient.ts,
// which answers bare tools/call requests), Brevo speaks full streamable-HTTP MCP:
// the server may issue an `Mcp-Session-Id` on initialize and expect it — plus the
// negotiated protocol version — on every subsequent request. So this client runs
// the real handshake once per process and re-runs it when the session expires,
// instead of firing sessionless calls and hoping.

const DEFAULT_BREVO_MCP_URL = "https://mcp.brevo.com/v1/brevo/mcp";

// The endpoint is early-access and may move; override without a code change.
// `||` not `??`: an empty BREVO_MCP_URL= line copied from .env.example must fall
// through to the default rather than produce fetch("").
function brevoMcpUrl(url?: string | (() => string | undefined)): string {
	const raw = typeof url === "function" ? url() : url;
	return (raw || DEFAULT_BREVO_MCP_URL).replace(/\/+$/, "");
}

export interface BrevoPassthroughAdapterOptions {
	apiKey: () => string | undefined;
	url?: string | (() => string | undefined);
	fetchFn?: typeof fetch;
}

export interface BrevoPassthroughPort extends McpPassthroughPort {
	resetSession(): void;
}

const PROTOCOL_VERSION = "2025-03-26";

type Session = {
	/** null when the server chose not to issue a session id (sessionless mode). */
	id: string | null;
	protocolVersion: string;
};

type BrevoClientState = BrevoPassthroughAdapterOptions & {
	session: Session | null;
	handshake: Promise<Session> | null;
	rpcId: number;
};

type RpcMessage = {
	jsonrpc: "2.0";
	id?: number | string;
	result?: unknown;
	error?: { code?: number; message?: string };
};

async function post(ctx: BrevoClientState, apiKey: string, body: unknown, s: Session | null): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${apiKey}`,
	};
	if (s) {
		headers["MCP-Protocol-Version"] = s.protocolVersion;
		if (s.id) headers["Mcp-Session-Id"] = s.id;
	}
	return (ctx.fetchFn ?? fetch)(brevoMcpUrl(ctx.url), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

// Decode a JSON- or SSE-framed JSON-RPC response body, returning the message that
// carries `id`'s result or error, or null when the body holds neither.
function decodeRpc(contentType: string, body: string, id: number): RpcMessage | null {
	if (contentType.includes("text/event-stream")) {
		// Line-wise decode: assumes one JSON payload per `data:` line, which matches
		// Brevo's current framing. A spec-legal multi-line data event would fail the
		// per-line parse and fall through to the null return below — harden here
		// (accumulate data lines per event) if that ever shows up.
		let match: RpcMessage | null = null;
		let rejection: RpcMessage | null = null;
		for (const line of body.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			try {
				const event = JSON.parse(line.slice(6)) as RpcMessage;
				// Tolerate a server echoing the id as a string ("2" for 2).
				const idMatches = event.id === id || event.id === String(id);
				if (idMatches && (event.result !== undefined || event.error !== undefined)) {
					match = event;
				} else if (event.id == null && event.error !== undefined) {
					// Brevo rejects a request it won't dispatch (dead session, bad auth)
					// with an `id: null` error — keep it as a fallback answer rather than
					// reporting "no response for the request".
					rejection = event;
				}
			} catch {
				// ignore malformed SSE lines
			}
		}
		return match ?? rejection;
	}

	// Plain JSON carries exactly one message, and it is the answer to this POST —
	// no id check, so an id echoed as null/string can't turn a real answer into
	// a "no response" error.
	try {
		return JSON.parse(body) as RpcMessage;
	} catch {
		return null;
	}
}

// Brevo signals a dead or expired session in-band as JSON-RPC -32000
// ("No valid session. Send an initialize request first."), with `id: null`, and
// not necessarily on a 404 — so detection is by code + message. Matching on
// -32000 alone would be too broad: Brevo uses it for auth failures too.
function isSessionInvalidError(error: RpcMessage["error"]): boolean {
	return error?.code === -32000 && /no valid session|session.*(expired|invalid|not found)/i.test(error.message ?? "");
}

async function initialize(ctx: BrevoClientState, apiKey: string): Promise<Session> {
	const id = ++ctx.rpcId;
	const res = await post(
		ctx,
		apiKey,
		{
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "ahOS", version: "0.2.0" },
			},
		},
		null,
	);

	const body = await res.text().catch(() => "");
	if (!res.ok) {
		throw new Error(`Brevo MCP initialize failed ${res.status}: ${body || res.statusText}`);
	}

	const message = decodeRpc(res.headers.get("content-type") ?? "", body, id);
	if (!message) {
		throw new Error("Brevo MCP initialize returned no response for the request");
	}
	if (message.error) {
		throw new Error(
			`Brevo MCP initialize error: ${message.error.message ?? JSON.stringify(message.error)}`,
		);
	}

	const negotiated =
		(message.result as { protocolVersion?: string } | undefined)?.protocolVersion ??
		PROTOCOL_VERSION;
	const created: Session = {
		id: res.headers.get("mcp-session-id"),
		protocolVersion: negotiated,
	};
	// Durable diagnostic (#640): on the next live failure this line says whether the
	// upstream handshake worked and whether Brevo issued a session id at all.
	// console.warn, not .error (#644): a successful handshake isn't a failure —
	// stdout is reserved for the stdio JSON-RPC stream (see index.ts), so stderr
	// is the only place this can go, and warn keeps it there while no longer
	// tagging routine traffic as an error.
	console.warn(
		`[brevo] initialize ${res.status}: session id ${
			created.id ? `'${created.id.slice(0, 8)}…'` : "NOT issued"
		}, protocol ${negotiated}`,
	);

	// Complete the handshake. Servers vary in how they answer the notification
	// (202, 204, even 4xx) — none of those outcomes invalidates the session.
	await post(ctx, apiKey, { jsonrpc: "2.0", method: "notifications/initialized" }, created).catch(
		() => undefined,
	);

	return created;
}

async function ensureSession(ctx: BrevoClientState, apiKey: string): Promise<Session> {
	if (ctx.session) return ctx.session;
	ctx.handshake ??= initialize(ctx, apiKey);
	try {
		ctx.session = await ctx.handshake;
	} finally {
		ctx.handshake = null;
	}
	return ctx.session;
}

// One request attempt: POST, drain the body exactly once (a Response body is
// single-read), decode. Callers inspect all three to tell apart HTTP failures,
// dead sessions, and JSON-RPC errors.
async function request(
	ctx: BrevoClientState, apiKey: string, method: string,
	params: Record<string, unknown>,
	s: Session,
): Promise<{ res: Response; body: string; message: RpcMessage | null }> {
	const id = ++ctx.rpcId;
	// console.warn, not .error (#644): this fires on every single RPC, so at
	// .error severity it was a permanent tax on the error stream for calls that
	// mostly succeed. warn keeps it on stderr (stdout is the stdio JSON-RPC
	// stream, see index.ts) without flagging routine traffic as a failure.
	console.warn(
		`[brevo] ${method} (id ${id}) with session ${s.id ? `'${s.id.slice(0, 8)}…'` : "NONE"}`,
	);
	const res = await post(ctx, apiKey, { jsonrpc: "2.0", id, method, params }, s);
	const body = await res.text().catch(() => "");
	return { res, body, message: decodeRpc(res.headers.get("content-type") ?? "", body, id) };
}

async function rpc(ctx: BrevoClientState, method: string, params: Record<string, unknown>): Promise<unknown> {
	const apiKey = ctx.apiKey();
	if (!apiKey) {
		throw new Error(
			"BREVO_MCP_API_KEY is not set. Generate an MCP-enabled API key in Brevo (Account → SMTP & API → API Keys → toggle 'Create MCP server API key') and add it to packages/mcp-server/.env to enable the Brevo tools.",
		);
	}

	let s = await ensureSession(ctx, apiKey);
	let attempt = await request(ctx, apiKey, method, params, s);

	// Streamable-HTTP session expiry arrives in two shapes: a 404 on an established
	// session, or an in-band -32000 "No valid session" JSON-RPC error (Brevo sends
	// the latter — SSE-framed, `id: null`, and not always with a 404 status). Either
	// way: re-run the handshake once and retry, rather than surfacing a dead-session
	// error. (A 404 with NO issued session id is not retried: that's a wrong
	// endpoint, and re-handshaking would just repeat it.)
	if ((attempt.res.status === 404 && s.id) || isSessionInvalidError(attempt.message?.error)) {
		// Stays at .error (#644): unlike the two diagnostics above, this is an
		// actual upstream anomaly — Brevo dropped a session that should still be
		// live — not routine traffic, even though the retry below usually recovers.
		console.error(
			`[brevo] session rejected upstream (HTTP ${attempt.res.status}) — re-initializing and retrying ${method}`,
		);
		// Invalidate only if no concurrent caller already re-established a fresh
		// session — their handshake must not be clobbered by our stale failure. And
		// only the session, never rpcId: the counter stays monotonic so the re-minted
		// id can't collide with ids handed out after the re-handshake.
		if (ctx.session === s) {
			ctx.session = null;
			ctx.handshake = null;
		}
		s = await ensureSession(ctx, apiKey);
		attempt = await request(ctx, apiKey, method, params, s);
	}

	const { res, body, message } = attempt;
	if (!res.ok) {
		throw new Error(`Brevo MCP error ${res.status}: ${body || res.statusText}`);
	}
	if (!message) {
		throw new Error("Brevo MCP returned no response for the request");
	}
	if (message.error) {
		throw new Error(`Brevo: ${message.error.message ?? JSON.stringify(message.error)}`);
	}
	return message.result;
}

export type BrevoToolSummary = McpPassthroughToolSummary;

async function listToolsWith(ctx: BrevoClientState): Promise<BrevoToolSummary[]> {
	const tools: BrevoToolSummary[] = [];
	let cursor: string | undefined;
	do {
		const result = (await rpc(ctx, "tools/list", cursor ? { cursor } : {})) as {
			tools?: BrevoToolSummary[];
			nextCursor?: string;
		};
		tools.push(...(result.tools ?? []));
		cursor = result.nextCursor || undefined;
	} while (cursor);
	return tools;
}

type UpstreamContent = { type: string; text?: string; [key: string]: unknown };

async function callToolWith(
	ctx: BrevoClientState,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpPassthroughCallResult> {
	const result = (await rpc(ctx, "tools/call", { name: toolName, arguments: args })) as {
		content?: UpstreamContent[];
		isError?: boolean;
	};

	// Coerce upstream content to text items — non-text payloads (resources, images)
	// are JSON-stringified rather than dropped, so nothing is silently lost.
	const content = (result.content ?? []).map((item) =>
		item.type === "text" && typeof item.text === "string"
			? { type: "text" as const, text: item.text }
			: { type: "text" as const, text: JSON.stringify(item) },
	);
	if (content.length === 0) {
		content.push({ type: "text", text: JSON.stringify(result) });
	}

	return result.isError ? { content, isError: true } : { content };
}

export function createBrevoPassthroughAdapter(options: BrevoPassthroughAdapterOptions): BrevoPassthroughPort {
	const ctx: BrevoClientState = { ...options, session: null, handshake: null, rpcId: 0 };
	return {
		listTools: () => listToolsWith(ctx),
		callTool: (name, args) => callToolWith(ctx, name, args),
		resetSession: () => { ctx.session = null; ctx.handshake = null; ctx.rpcId = 0; },
	};
}
