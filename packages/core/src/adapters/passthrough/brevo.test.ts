import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrevoPassthroughAdapter } from "./brevo.js";

let currentApiKey: string | undefined = "test-key";
let currentUrl: string | undefined;

const adapter = createBrevoPassthroughAdapter({
	apiKey: () => currentApiKey,
	url: () => currentUrl,
});
const callBrevoTool = (name: string, args: Record<string, unknown>) => adapter.callTool(name, args);
const listBrevoTools = () => adapter.listTools();
const resetBrevoSession = () => adapter.resetSession();

const MCP_URL = "https://mcp.brevo.com/v1/brevo/mcp";

function jsonRes(
	body: unknown,
	opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
	const status = opts.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		headers: new Headers({ "content-type": "application/json", ...opts.headers }),
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function sseRes(events: unknown[], opts: { status?: number } = {}): Response {
	const status = opts.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		headers: new Headers({ "content-type": "text/event-stream" }),
		text: async () => events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n"),
		json: async () => {
			throw new Error("not json");
		},
	} as unknown as Response;
}

// The handshake pair every fresh session performs: initialize (returns a session id
// header) then notifications/initialized (202, no body).
function handshakeResponses(sessionId = "sess-1"): Response[] {
	return [
		jsonRes(
			{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
			{ headers: { "mcp-session-id": sessionId } },
		),
		jsonRes(null, { status: 202 }),
	];
}

function stubFetchQueue(responses: Response[]) {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
		const next = responses.shift();
		if (!next) throw new Error("fetch called more times than responses were queued");
		return next;
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	resetBrevoSession();
});

afterEach(() => {
	currentApiKey = "test-key";
	currentUrl = undefined;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("callBrevoTool", () => {
	it("throws a clear setup error when BREVO_MCP_API_KEY is unset", async () => {
		currentApiKey = undefined;
		const fetchMock = stubFetchQueue([]);
		await expect(callBrevoTool("get_account", {})).rejects.toThrow(
			/BREVO_MCP_API_KEY is not set/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("performs the MCP handshake, then calls the tool with the session headers", async () => {
		const fetchMock = stubFetchQueue([
			...handshakeResponses("sess-42"),
			jsonRes({
				jsonrpc: "2.0",
				id: 2,
				result: { content: [{ type: "text", text: "ok" }] },
			}),
		]);

		const out = await callBrevoTool("get_account", { verbose: true });
		expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// 1st call: initialize, no session header, Bearer auth.
		const [initUrl, initInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(initUrl).toBe(MCP_URL);
		const initHeaders = initInit.headers as Record<string, string>;
		expect(initHeaders.Authorization).toBe("Bearer test-key");
		expect(initHeaders["Mcp-Session-Id"]).toBeUndefined();
		const initBody = JSON.parse(initInit.body as string);
		expect(initBody.method).toBe("initialize");
		expect(initBody.params.clientInfo).toEqual({ name: "ahOS", version: "0.2.0" });

		// 2nd call: notifications/initialized carries the freshly issued session id.
		const [, notifyInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(JSON.parse(notifyInit.body as string).method).toBe("notifications/initialized");
		expect((notifyInit.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-42");

		// 3rd call: tools/call with session + negotiated protocol version.
		const [, callInit] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
		const callHeaders = callInit.headers as Record<string, string>;
		expect(callHeaders["Mcp-Session-Id"]).toBe("sess-42");
		expect(callHeaders["MCP-Protocol-Version"]).toBe("2025-03-26");
		expect(JSON.parse(callInit.body as string)).toMatchObject({
			method: "tools/call",
			params: { name: "get_account", arguments: { verbose: true } },
		});
	});

	it("reuses the session across calls instead of re-initializing", async () => {
		const fetchMock = stubFetchQueue([
			...handshakeResponses(),
			jsonRes({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "a" }] } }),
			jsonRes({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "b" }] } }),
		]);

		await callBrevoTool("x", {});
		await callBrevoTool("y", {});
		// 2 handshake calls + 2 tool calls — no second initialize.
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("surfaces a 404 as an error, without re-handshaking, when the server never issued a session id", async () => {
		// A sessionless 404 is a wrong endpoint, not an expired session — the `s.id`
		// guard must let it surface instead of triggering a retry loop.
		const fetchMock = stubFetchQueue([
			jsonRes(
				{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
				{ headers: {} }, // no mcp-session-id header
			),
			jsonRes(null, { status: 202 }),
			jsonRes({ error: "nope" }, { status: 404 }),
		]);

		await expect(callBrevoTool("get_account", {})).rejects.toThrow(/Brevo MCP error 404/);
		// initialize + notification + the one failing call — no second handshake.
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("surfaces an initialize failure (non-ok and JSON-RPC error) as a clear error", async () => {
		stubFetchQueue([jsonRes({ boom: true }, { status: 500 })]);
		await expect(callBrevoTool("x", {})).rejects.toThrow(/Brevo MCP initialize failed 500/);

		resetBrevoSession();
		stubFetchQueue([
			jsonRes({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "bad key" } }),
		]);
		await expect(callBrevoTool("x", {})).rejects.toThrow(/Brevo MCP initialize error: bad key/);
	});

	it("errors when an SSE stream contains no response for the request id", async () => {
		stubFetchQueue([
			...handshakeResponses(),
			sseRes([
				{ jsonrpc: "2.0", method: "notifications/progress", params: {} },
				{ jsonrpc: "2.0", id: 999, result: { content: [] } }, // some other request's id
			]),
		]);

		await expect(callBrevoTool("get_account", {})).rejects.toThrow(
			/no response for the request/,
		);
	});

	it("deduplicates concurrent handshakes — two parallel first calls share one initialize", async () => {
		const fetchMock = stubFetchQueue([
			...handshakeResponses(),
			jsonRes({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "a" }] } }),
			jsonRes({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "b" }] } }),
		]);

		await Promise.all([callBrevoTool("x", {}), callBrevoTool("y", {})]);

		// init + notification + two tool calls; exactly ONE initialize among them.
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const initializeCalls = fetchMock.mock.calls.filter(
			(c) => JSON.parse((c[1] as RequestInit).body as string).method === "initialize",
		);
		expect(initializeCalls).toHaveLength(1);
	});

	it("keeps the session usable when notifications/initialized is rejected by the server", async () => {
		stubFetchQueue([
			jsonRes(
				{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
				{ headers: { "mcp-session-id": "sess-1" } },
			),
			jsonRes({ error: "notifications not accepted" }, { status: 400 }), // rejected notification
			jsonRes({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }),
		]);

		const out = await callBrevoTool("get_account", {});
		expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
	});

	it("re-initializes and retries when the server reports an in-band 'No valid session' error", async () => {
		// The shape observed live on Railway: SSE-framed -32000 with `id: null` on a
		// non-2xx status — no 404, so the status-based retry never saw it.
		const fetchMock = stubFetchQueue([
			...handshakeResponses("old-sess"),
			sseRes(
				[
					{
						jsonrpc: "2.0",
						error: { code: -32000, message: "No valid session. Send an initialize request first." },
						id: null,
					},
				],
				{ status: 400 },
			),
			...handshakeResponses("new-sess"),
			jsonRes({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "ok" }] } }),
		]);

		const out = await callBrevoTool("get_account", {});
		expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
		const lastHeaders = fetchMock.mock.calls[5]?.[1]?.headers as Record<string, string>;
		expect(lastHeaders["Mcp-Session-Id"]).toBe("new-sess");
	});

	it("retries a session error only once — a second one surfaces instead of looping", async () => {
		const sessionError = {
			jsonrpc: "2.0",
			error: { code: -32000, message: "No valid session. Send an initialize request first." },
			id: null,
		};
		const fetchMock = stubFetchQueue([
			...handshakeResponses("s1"),
			jsonRes(sessionError),
			...handshakeResponses("s2"),
			jsonRes(sessionError),
		]);

		await expect(callBrevoTool("get_account", {})).rejects.toThrow(/Brevo: No valid session/);
		// 2 × (initialize + notification + call), then stop — no third handshake.
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("surfaces an id:null rejection that is not a session error, without retrying", async () => {
		const fetchMock = stubFetchQueue([
			...handshakeResponses(),
			sseRes([{ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null }]),
		]);

		await expect(callBrevoTool("get_account", {})).rejects.toThrow(/Brevo: Invalid Request/);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("re-runs the handshake once when the server 404s an expired session", async () => {
		const fetchMock = stubFetchQueue([
			...handshakeResponses("old-sess"),
			jsonRes({ error: "session expired" }, { status: 404 }),
			...handshakeResponses("new-sess"),
			jsonRes({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "ok" }] } }),
		]);

		const out = await callBrevoTool("get_account", {});
		expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
		const lastHeaders = fetchMock.mock.calls[5]?.[1]?.headers as Record<string, string>;
		expect(lastHeaders["Mcp-Session-Id"]).toBe("new-sess");
	});

	it("decodes SSE-framed responses", async () => {
		stubFetchQueue([
			...handshakeResponses(),
			sseRes([
				{ jsonrpc: "2.0", method: "notifications/progress", params: {} },
				{ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "sse ok" }] } },
			]),
		]);

		const out = await callBrevoTool("get_account", {});
		expect(out).toEqual({ content: [{ type: "text", text: "sse ok" }] });
	});

	it("surfaces upstream JSON-RPC errors and propagates isError results", async () => {
		stubFetchQueue([
			...handshakeResponses(),
			jsonRes({
				jsonrpc: "2.0",
				id: 2,
				error: { code: -32602, message: "Unknown tool: nope" },
			}),
			jsonRes({
				jsonrpc: "2.0",
				id: 3,
				result: { content: [{ type: "text", text: "bad sender" }], isError: true },
			}),
		]);

		await expect(callBrevoTool("nope", {})).rejects.toThrow(/Brevo: Unknown tool: nope/);

		const out = await callBrevoTool("send_email", {});
		expect(out.isError).toBe(true);
		expect(out.content).toEqual([{ type: "text", text: "bad sender" }]);
	});

	it("stringifies non-text content instead of dropping it", async () => {
		stubFetchQueue([
			...handshakeResponses(),
			jsonRes({
				jsonrpc: "2.0",
				id: 2,
				result: { content: [{ type: "resource", uri: "brevo://campaigns/1" }] },
			}),
		]);

		const out = await callBrevoTool("get_campaign", {});
		expect(out.content).toEqual([
			{ type: "text", text: JSON.stringify({ type: "resource", uri: "brevo://campaigns/1" }) },
		]);
	});
});

describe("listBrevoTools", () => {
	it("follows tools/list pagination and concatenates pages", async () => {
		const fetchMock = stubFetchQueue([
			...handshakeResponses(),
			jsonRes({
				jsonrpc: "2.0",
				id: 2,
				result: { tools: [{ name: "a" }, { name: "b" }], nextCursor: "p2" },
			}),
			jsonRes({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "c" }] } }),
		]);

		const tools = await listBrevoTools();
		expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);

		const secondPage = JSON.parse(fetchMock.mock.calls[3]?.[1]?.body as string);
		expect(secondPage.params).toEqual({ cursor: "p2" });
	});
});
