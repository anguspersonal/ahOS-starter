import { z } from "zod";
import type { OneDrivePort, OneDriveQuota } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";

export const onedriveGetQuotaInputSchema = z.object({});

export type OnedriveGetQuotaInput = z.infer<typeof onedriveGetQuotaInputSchema>;

/**
 * Create the `onedrive_get_quota` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveGetQuotaAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveGetQuotaInputSchema, OneDriveQuota> {
	return defineAction({
		id: "onedrive_get_quota",
		name: "onedrive_get_quota",
		description:
			"Get personal OneDrive (owner@example.com) storage quota including total, used, remaining, deleted (Recycle Bin bytes), and quota state (normal, nearing, critical, exceeded).",
		domain: "integrations",
		schema: onedriveGetQuotaInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			_input: OnedriveGetQuotaInput,
			_context: ActionContext,
		): Promise<OneDriveQuota> {
			return port.getQuota();
		},
	});
}
