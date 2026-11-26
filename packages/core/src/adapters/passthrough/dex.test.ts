import { describe, expect, it, vi } from "vitest";
import { DEX_TOOLS } from "../../domain/dex/catalog.js";
import { createDexPassthroughAdapter } from "./dex.js";

const DEX_MCP_URL = "https://mcp.getdex.com/mcp";

describe("createDexPassthroughAdapter", () => {
	it("throws a clear setup error before any request when DEX_API_KEY is unset", async () => {
		const fetchFn = vi.fn();
		const adapter = createDexPassthroughAdapter({
			apiKey: () => undefined,
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		await expect(adapter.callTool("dex_search_contacts", {})).rejects.toThrow(
			/DEX_API_KEY is not set/,
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("lists all catalog tools locally without requiring DEX_API_KEY or making HTTP requests", async () => {
		const fetchFn = vi.fn();
		const adapter = createDexPassthroughAdapter({
			apiKey: () => undefined,
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		const tools = await adapter.listTools();
		expect(tools).toHaveLength(DEX_TOOLS.length);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("calls Dex MCP with a timeout signal and returns JSON tool results", async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({
				jsonrpc: "2.0",
				id: "1",
				result: { content: [{ type: "text", text: "Matteo Costa" }] },
			}),
		}));
		const adapter = createDexPassthroughAdapter({
			apiKey: () => "dex-test-key",
			fetchFn: fetchMock as unknown as typeof fetch,
		});

		const res = await adapter.callTool("dex_search_contacts", { query: "Matteo Costa" });
		expect(res).toEqual({ content: [{ type: "text", text: "Matteo Costa" }] });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(DEX_MCP_URL);
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(init.body as string)).toEqual({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "dex_search_contacts", arguments: { query: "Matteo Costa" } },
			id: "1",
		});
	});

	it("returns immediately and cancels the stream when an SSE response stays open after emitting the result", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'event: message\ndata: {"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"streamed ok"}]}}\n\n',
					),
				);
			},
			cancel() {
				cancelled = true;
			},
		});

		const adapter = createDexPassthroughAdapter({
			apiKey: () => "dex-test-key",
			fetchFn: vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/event-stream" }),
				body: stream,
				text: async () => {
					throw new Error("res.text() should not be called when res.body is readable");
				},
			})) as unknown as typeof fetch,
		});

		const res = await adapter.callTool("dex_list_tags", {});
		expect(res).toEqual({ content: [{ type: "text", text: "streamed ok" }] });
		expect(cancelled).toBe(true);
	});

	it("surfaces JSON-RPC errors framed inside an SSE stream", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'data: {"jsonrpc":"2.0","id":"1","error":{"code":-32602,"message":"Invalid tag filter"}}\n\n',
					),
				);
			},
		});

		const adapter = createDexPassthroughAdapter({
			apiKey: () => "dex-test-key",
			fetchFn: vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/event-stream" }),
				body: stream,
			})) as unknown as typeof fetch,
		});

		await expect(adapter.callTool("dex_list_tags", {})).rejects.toThrow(
			/Dex: Invalid tag filter/,
		);
	});

	it("throws when an SSE stream ends without a result or error", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(": keepalive\n\n"));
				controller.close();
			},
		});

		const adapter = createDexPassthroughAdapter({
			apiKey: () => "dex-test-key",
			fetchFn: vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/event-stream" }),
				body: stream,
			})) as unknown as typeof fetch,
		});

		await expect(adapter.callTool("dex_list_tags", {})).rejects.toThrow(
			/Dex MCP returned an empty SSE stream/,
		);
	});

	it("surfaces non-2xx HTTP errors from Dex MCP", async () => {
		const adapter = createDexPassthroughAdapter({
			apiKey: () => "dex-test-key",
			fetchFn: vi.fn(async () => ({
				ok: false,
				status: 502,
				statusText: "Bad Gateway",
				headers: new Headers({ "content-type": "text/plain" }),
				text: async () => "upstream timeout",
			})) as unknown as typeof fetch,
		});

		await expect(adapter.callTool("dex_list_tags", {})).rejects.toThrow(
			/Dex MCP error 502: upstream timeout/,
		);
	});
});
