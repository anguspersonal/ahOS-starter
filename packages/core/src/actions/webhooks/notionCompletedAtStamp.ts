import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type {
	NotionAutomationPort,
	NotionCompletedAtOutcome,
} from "../../ports/webhookWork.js";

export const notionCompletedAtStampInputSchema = z.object({
	type: z.string().optional(),
	timestamp: z.string().optional(),
	entity: z
		.object({
			id: z.string().optional(),
			type: z.string().optional(),
		})
		.optional(),
	data: z
		.object({
			updated_properties: z.array(z.string()).optional(),
		})
		.optional(),
});

export type NotionCompletedAtStampInput = z.infer<
	typeof notionCompletedAtStampInputSchema
>;

export function createNotionCompletedAtStampAction(port: NotionAutomationPort) {
	return defineAction({
		id: "notion_completed_at_stamp",
		domain: "integrations",
		description:
			"Evaluates a Notion page.properties_updated webhook event against the completed_at_stamp automation rule and stamps or clears the Completed at property when status changes.",
		schema: notionCompletedAtStampInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		expose: {
			mcp: false,
			http: false,
			ui_agent: false,
			worker: true,
			reason: "app_internal",
			note: "Dispatched internally by the /webhooks/notion receiver after HMAC verification (ADR-104 L1, ADR-105 L4)",
		},
		async run(input) {
			return port.handlePagePropertiesUpdated(input);
		},
	});
}
