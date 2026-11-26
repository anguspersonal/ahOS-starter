import { z } from "zod";
import { DEX_TOOLS } from "../../domain/dex/catalog.js";
import type {
	McpPassthroughCallResult,
	McpPassthroughPort,
	McpPassthroughToolSummary,
} from "../../ports/mcpPassthrough.js";

const DEX_MCP_URL = "https://mcp.getdex.com/mcp";
const DEX_TIMEOUT_MS = 30_000;

export interface DexPassthroughAdapterOptions {
	apiKey: () => string | undefined;
	url?: string;
	fetchFn?: typeof fetch;
}

type DexToolResult = { content: { type: "text"; text: string }[] };

function parseSseDataLine(
	line: string,
): { kind: "result"; result: DexToolResult } | { kind: "error"; message: string } | null {
	const trimmed = line.replace(/\r$/, "");
	if (!trimmed.startsWith("data:")) return null;
	const payload = trimmed.slice(5).trimStart();
	if (!payload) return null;
	let event: {
		error?: { message?: string };
		result?: { content?: { type: "text"; text: string }[] };
	};
	try {
		event = JSON.parse(payload);
	} catch (err) {
		throw new Error(
			`Dex MCP returned malformed SSE JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (event.error) {
		return {
			kind: "error",
			message: `Dex: ${event.error.message ?? JSON.stringify(event.error)}`,
		};
	}
	if (event.result?.content) {
		return {
			kind: "result",
			result: { content: event.result.content },
		};
	}
	return null;
}

async function readSseRpcResponse(res: Response): Promise<DexToolResult> {
	if (typeof res.body?.getReader === "function") {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value) {
					buffer += decoder.decode(value, { stream: !done });
				}
				if (done) {
					buffer += decoder.decode();
				}
				const lines = buffer.split("\n");
				buffer = done ? "" : (lines.pop() ?? "");
				for (const line of lines) {
					const parsed = parseSseDataLine(line);
					if (parsed?.kind === "error") {
						throw new Error(parsed.message);
					}
					if (parsed?.kind === "result") {
						return parsed.result;
					}
				}
				if (done) break;
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		throw new Error("Dex MCP returned an empty SSE stream");
	}

	const text = await res.text();
	let result: DexToolResult | null = null;
	for (const line of text.split("\n")) {
		const parsed = parseSseDataLine(line);
		if (parsed?.kind === "error") {
			throw new Error(parsed.message);
		}
		if (parsed?.kind === "result") {
			result = parsed.result;
		}
	}
	if (!result) throw new Error("Dex MCP returned an empty SSE stream");
	return result;
}

async function callDexToolWith(
	options: DexPassthroughAdapterOptions,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpPassthroughCallResult> {
	const apiKey = options.apiKey();
	if (!apiKey) {
		throw new Error(
			"DEX_API_KEY is not set. Add it to packages/mcp-server/.env to enable Dex CRM tools.",
		);
	}

	const res = await (options.fetchFn ?? fetch)(options.url ?? DEX_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: toolName, arguments: args },
			id: "1",
		}),
		signal: AbortSignal.timeout(DEX_TIMEOUT_MS),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Dex MCP error ${res.status}: ${body || res.statusText}`);
	}

	const contentType = res.headers.get("content-type") ?? "";

	if (contentType.includes("text/event-stream")) {
		return readSseRpcResponse(res);
	}

	const data = (await res.json()) as {
		error?: { message?: string };
		result: DexToolResult;
	};
	if (data.error) throw new Error(`Dex: ${data.error.message ?? JSON.stringify(data.error)}`);
	return data.result;
}

export function createDexPassthroughAdapter(
	options: DexPassthroughAdapterOptions,
): McpPassthroughPort {
	return {
		async listTools(): Promise<McpPassthroughToolSummary[]> {
			return DEX_TOOLS.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: z.toJSONSchema(z.object(t.input), {
					target: "draft-7",
					io: "input",
				}) as Record<string, unknown>,
				annotations: t.annotations,
			}));
		},
		callTool: (name, args) => callDexToolWith(options, name, args),
	};
}
