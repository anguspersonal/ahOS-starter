import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { InClientAnswer, InClientApprover } from "@ahkms/core";
import type { McpToolHandlerExtra } from "./adapters/mcp.js";

export type ElicitationServer = Pick<Server, "getClientCapabilities" | "elicitInput">;

const MAX_INPUT_CHARS = 4_000;
const ELICITATION_TIMEOUT_MS = 60_000;

export function createInClientApprover(
	server: ElicitationServer | undefined,
	extra: McpToolHandlerExtra | undefined,
): InClientApprover | undefined {
	const clientId = extra?.authInfo?.clientId;
	if (!clientId || !server?.getClientCapabilities()?.elicitation?.form) return undefined;
	return {
		clientId,
		async ask({ decisionId, actionId, input, caller }): Promise<InClientAnswer> {
			const json = JSON.stringify(input, null, 2) ?? String(input);
			const shown =
				json.length > MAX_INPUT_CHARS
					? `${json.slice(0, MAX_INPUT_CHARS)}\n… (${json.length - MAX_INPUT_CHARS} characters hidden; cancelling leaves the call in the Approvals inbox)`
					: json;
			const message = `Approve ${actionId} (decision ${decisionId}, caller ${caller}, client ${clientId})?\n${shown}`;
			try {
				const res = await server.elicitInput(
					{
						mode: "form",
						message,
						requestedSchema: {
							type: "object",
							properties: { decision: { type: "string", enum: ["reject", "approve"] } },
							required: ["decision"],
						},
					},
					{ relatedRequestId: extra?.requestId as any, timeout: ELICITATION_TIMEOUT_MS, signal: extra?.signal },
				);
				if (res.action === "accept") {
					if (res.content?.decision === "approve") return "approve";
					if (res.content?.decision === "reject") return "reject";
					return "unanswered";
				}
				return res.action === "decline" ? "reject" : "unanswered";
			} catch {
				return "unanswered";
			}
		},
	};
}
