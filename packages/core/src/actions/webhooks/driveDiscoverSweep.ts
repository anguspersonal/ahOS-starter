import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { defineAction } from "../defineAction.js";
import {
	createDriveChangesListAction,
	type DriveChangeEntry,
	type DriveChangesListOutput,
} from "../drive/changesList.js";
import { LEGACY_DOMAIN_VALUE } from "../../domain/domains.js";
import type { DriveWatchPorts } from "../../ports/driveWatch.js";
import type { DriveDiscoverPort } from "../../ports/webhookWork.js";

export const driveDiscoverSweepInputSchema = z.object({
	channelId: z
		.string()
		.optional()
		.describe(
			"Optional X-Goog-Channel-ID from a Drive push notification. Routes the notification to the matching account's stored watch channel and reads drive_changes_list.",
		),
	channel_id: z
		.string()
		.optional()
		.describe("Alias for channelId."),
});

export type DriveDiscoverSweepInput = z.infer<typeof driveDiscoverSweepInputSchema>;

export interface DriveDiscoverSweepDeps {
	driveWatch?: DriveWatchPorts;
	onAccountChanges?: (params: {
		account: string;
		changes: DriveChangeEntry[];
	}) => Promise<void>;
	onAccountFallbackSweep?: (account: string) => Promise<void>;
}

export function createDriveDiscoverSweepAction(
	port: DriveDiscoverPort,
	deps?: DriveDiscoverSweepDeps,
) {
	return defineAction({
		id: "drive_discover_sweep",
		domain: "integrations",
		description:
			"Runs a Google Drive discovery sweep across configured accounts in response to a coalesced Drive push notification.",
		schema: driveDiscoverSweepInputSchema,
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
			note: "Dispatched internally by the /webhooks/drive receiver after channel token verification and debounce coalescing (ADR-104 L1, ADR-105 L4)",
		},
		async run(input) {
			const channelId = input.channelId ?? input.channel_id;
			if (!channelId) {
				await port.runDiscoverSweep();
				return;
			}

			if (!deps?.driveWatch) {
				await port.runDiscoverSweep({ channelId });
				return;
			}

			const driveWatch = deps.driveWatch;
			const accounts = await driveWatch.listAccounts();
			let matchedAccount: string | null = null;
			let storedChannel = null;
			for (const account of accounts) {
				const ch = await driveWatch.getStoredChannel(account);
				if (ch && ch.id === channelId) {
					matchedAccount = account;
					storedChannel = ch;
					break;
				}
			}

			if (!matchedAccount || !storedChannel) {
				console.log(
					`[drive-discover] Dropping notification for unknown channelId=${channelId}`,
				);
				return;
			}

			if (!storedChannel.pageToken || !driveWatch.listChanges) {
				const newToken = driveWatch.getStartPageToken
					? await driveWatch.getStartPageToken(matchedAccount)
					: undefined;
				if (deps.onAccountFallbackSweep) {
					await deps.onAccountFallbackSweep(matchedAccount);
				} else {
					await port.runDiscoverSweep({ channelId });
				}
				if (newToken) {
					await driveWatch.saveChannel({
						...storedChannel,
						pageToken: newToken,
						updatedAt: new Date().toISOString(),
					});
				}
				return;
			}

			const changesListAction = createDriveChangesListAction({
				listChanges: driveWatch.listChanges.bind(driveWatch),
			});
			const domain =
				LEGACY_DOMAIN_VALUE[
					matchedAccount as keyof typeof LEGACY_DOMAIN_VALUE
				] ?? "angus";

			const allChanges: DriveChangeEntry[] = [];
			let cursor: string | null = storedChannel.pageToken;
			let newStartPageToken: string | null = null;

			while (cursor) {
				const out: DriveChangesListOutput = await executeAction(
					changesListAction,
					{
						domain,
						cursor,
					},
				);
				if ("expired" in out) {
					const reseededToken = driveWatch.getStartPageToken
						? await driveWatch.getStartPageToken(matchedAccount)
						: undefined;
					if (deps.onAccountFallbackSweep) {
						await deps.onAccountFallbackSweep(matchedAccount);
					} else {
						await port.runDiscoverSweep({ channelId });
					}
					if (reseededToken) {
						await driveWatch.saveChannel({
							...storedChannel,
							pageToken: reseededToken,
							updatedAt: new Date().toISOString(),
						});
					}
					return;
				}

				allChanges.push(...out.changes);
				if (out.new_start_page_token) {
					newStartPageToken = out.new_start_page_token;
				}
				cursor = out.next_cursor;
			}

			if (deps.onAccountChanges) {
				await deps.onAccountChanges({
					account: matchedAccount,
					changes: allChanges,
				});
			} else {
				await port.runDiscoverSweep({ channelId });
			}

			if (newStartPageToken) {
				await driveWatch.saveChannel({
					...storedChannel,
					pageToken: newStartPageToken,
					updatedAt: new Date().toISOString(),
				});
			}
		},
	});
}
