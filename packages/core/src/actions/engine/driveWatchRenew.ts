import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { DriveWatchPorts } from "../../ports/driveWatch.js";

export const DEFAULT_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export const driveWatchRenewInputSchema = z.object({
	webhookBaseUrl: z
		.string()
		.optional()
		.describe("Public base URL for /webhooks/drive"),
	webhook_base_url: z
		.string()
		.optional()
		.describe("Public base URL for /webhooks/drive (snake_case)"),
	webhookToken: z
		.string()
		.optional()
		.describe("Shared secret token for Drive webhook verification"),
	webhook_token: z
		.string()
		.optional()
		.describe("Shared secret token for Drive webhook verification (snake_case)"),
	renewalWindowMs: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Renewal window in milliseconds before channel expiration"),
	renewal_window_ms: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Renewal window in milliseconds before channel expiration (snake_case)"),
});

export type DriveWatchRenewInput = z.infer<typeof driveWatchRenewInputSchema>;

export interface DriveWatchRenewDefaults {
	webhookBaseUrl?: string;
	webhookToken?: string;
	renewalWindowMs?: number;
}

/**
 * Builds the worker-only `drive_watch_renew` action that checks and renews
 * Google Drive `changes.watch` push notification channels across configured
 * accounts (ADR-048, ADR-101 §2, ADR-105 R5 #1554).
 */
export function createDriveWatchRenewAction(
	ports: DriveWatchPorts,
	defaults?: DriveWatchRenewDefaults,
) {
	return defineAction({
		id: "drive_watch_renew",
		domain: "integrations",
		description:
			"Checks and renews Google Drive changes.watch push notification channels across configured accounts.",
		schema: driveWatchRenewInputSchema,
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
			cli: false,
			a2a: false,
			reason: "app_internal",
			note: "Scheduled engine cadence action that renews Drive changes.watch channels (ADR-048, ADR-101 §2, ADR-105 R5)",
		},
		async run(input): Promise<Record<string, unknown>> {
			const rawBaseUrl =
				input.webhookBaseUrl ?? input.webhook_base_url ?? defaults?.webhookBaseUrl ?? "";
			const rawToken =
				input.webhookToken ?? input.webhook_token ?? defaults?.webhookToken ?? "";
			const renewalWindowMs =
				input.renewalWindowMs ??
				input.renewal_window_ms ??
				defaults?.renewalWindowMs ??
				DEFAULT_RENEWAL_WINDOW_MS;

			const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
			const token = rawToken.trim();

			if (!baseUrl || !token) {
				console.warn(
					"[drive-watch cadence] Skipping drive watch check: webhookBaseUrl or webhookToken is not set",
				);
				return {
					skipped: true,
					reason: "webhookBaseUrl or webhookToken not configured",
				};
			}

			const accounts = await ports.listAccounts();
			if (accounts.length === 0) {
				return { accounts: 0, message: "no google accounts configured" };
			}

			const totals = {
				accounts: accounts.length,
				registered: 0,
				renewed: 0,
				active: 0,
				errors: 0,
			};

			const targetAddress = `${baseUrl}/webhooks/drive`;

			for (const account of accounts) {
				try {
					const existing = await ports.getStoredChannel(account);

					let needsRenewal = false;
					let isRenewal = false;

					if (!existing) {
						needsRenewal = true;
						isRenewal = false;
					} else {
						const exp = Number(existing.expiration) || new Date(existing.expiration).getTime();
						const now = Date.now();
						if (isNaN(exp) || exp <= now + renewalWindowMs) {
							needsRenewal = true;
							isRenewal = true;
						} else {
							totals.active++;
						}
					}

					if (needsRenewal) {
						const channelId = `ahos-drive-${account}-${Date.now()}`;
						const reg = await ports.registerWatch({
							account,
							channelId,
							address: targetAddress,
							token,
						});

						const pageToken = existing?.pageToken ?? reg.pageToken;
						await ports.saveChannel({
							id: reg.id,
							resourceId: reg.resourceId,
							expiration: reg.expiration,
							address: targetAddress,
							account,
							updatedAt: new Date().toISOString(),
							...(pageToken !== undefined ? { pageToken } : {}),
						});

						if (existing?.id && existing?.resourceId) {
							try {
								await ports.stopWatch({
									account,
									channelId: existing.id,
									resourceId: existing.resourceId,
								});
							} catch (stopErr) {
								console.warn(
									`[drive-watch cadence] Could not stop previous channel '${existing.id}' for '${account}':`,
									stopErr,
								);
							}
						}

						if (isRenewal) {
							totals.renewed++;
						} else {
							totals.registered++;
						}
					}
				} catch (err) {
					totals.errors++;
					console.error(
						`[drive-watch cadence] Error managing watch channel for account '${account}':`,
						err,
					);
				}
			}

			return totals;
		},
	});
}
