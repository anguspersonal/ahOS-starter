import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { recordActionAudit, type ActionAuditRecord, type ActionAuditSeam } from "@ahkms/core";
import { getCurrentUserId } from "../identity.js";

export function sdkRejectionPrefix(name: string): string {
	return `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: `;
}

export function recordSdkRejections(
	server: McpServer,
	lookup: (name: string) => { actionId: string; seam: ActionAuditSeam } | undefined,
): void {
	server.server.assertCanSetRequestHandler("tools/call");
	const origSetRequestHandler = server.server.setRequestHandler.bind(server.server);
	server.server.setRequestHandler = ((requestSchema: unknown, handler: (...args: any[]) => any) => {
		if (requestSchema !== CallToolRequestSchema) {
			return origSetRequestHandler(requestSchema as any, handler as any);
		}
		return origSetRequestHandler(
			requestSchema as any,
			async (
				request: { params: { name: string; arguments?: unknown } },
				extra?: { sessionId?: string; authInfo?: { clientId?: string } },
			) => {
				const startTime = Date.now();
				const result = await handler(request, extra);
				const firstContent = Array.isArray(result?.content) ? result.content[0] : undefined;
				const text =
					result?.isError === true &&
					firstContent?.type === "text" &&
					typeof firstContent.text === "string"
						? (firstContent.text as string)
						: undefined;
				const toolName = request.params.name;
				const target = text?.startsWith(sdkRejectionPrefix(toolName)) ? lookup(toolName) : undefined;
				if (text !== undefined && target) {
					let userId: string | null = null;
					try {
						userId = getCurrentUserId() ?? null;
					} catch {
						userId = null;
					}
					const rawClientId = extra?.authInfo?.clientId;
					const rawSessionId = extra?.sessionId;
					const rawArgs = request.params.arguments;
					const record: ActionAuditRecord = {
						actionId: target.actionId,
						seam: target.seam,
						caller: "mcp",
						requestId: randomUUID(),
						userId,
						clientId: rawClientId && rawClientId.length > 0 ? rawClientId : null,
						sessionId: rawSessionId && rawSessionId.length > 0 ? rawSessionId : null,
						outcome: "validation_error",
						durationMs: Date.now() - startTime,
						errorMessage: text.slice(0, 500),
						inputKeys: rawArgs && typeof rawArgs === "object" ? Object.keys(rawArgs) : [],
						inputSha256: null,
					};
					await recordActionAudit(record);
				}
				return result;
			},
		);
	}) as typeof server.server.setRequestHandler;
}
