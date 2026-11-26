import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { sha256Hex } from "../inputHash.js";
import type { ActionDefinition } from "../types.js";

export const mcpResultProbeInputSchema = z.object({
	nonce: z
		.string()
		.min(1)
		.max(64)
		.describe(
			"Caller-chosen nonce (1-64 characters) used to derive deterministic probe markers.",
		),
});

export type McpResultProbeInput = z.infer<typeof mcpResultProbeInputSchema>;

export interface McpResultProbeOutput {
	nonce: string;
	text_marker: string;
	data_marker: string;
	note: string;
}

async function deriveMarker(
	prefix: "TEXT-" | "DATA-",
	nonce: string,
	suffix: ":text" | ":data",
): Promise<string> {
	const digest = await sha256Hex(`${nonce}${suffix}`);
	return `${prefix}${digest.slice(0, 8)}`;
}

export function createMcpResultProbeAction(): ActionDefinition<
	typeof mcpResultProbeInputSchema,
	McpResultProbeOutput
> {
	return defineAction<typeof mcpResultProbeInputSchema, McpResultProbeOutput>({
		id: "mcp_result_probe",
		name: "mcp_result_probe",
		description:
			"Diagnostic probe with no side effects for checking what an MCP client shows the model (text content, structured result, or both).",
		domain: "ops",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: mcpResultProbeInputSchema,
		run: async (input: McpResultProbeInput): Promise<McpResultProbeOutput> => {
			const [text_marker, data_marker] = await Promise.all([
				deriveMarker("TEXT-", input.nonce, ":text"),
				deriveMarker("DATA-", input.nonce, ":data"),
			]);
			return {
				nonce: input.nonce,
				text_marker,
				data_marker,
				note: "The data marker is only present in the structured result.",
			};
		},
		formatMcp: (result) =>
			`Probe nonce=${result.nonce} text_marker=${result.text_marker}\nReport every marker visible to you from this tool result.`,
	});
}
