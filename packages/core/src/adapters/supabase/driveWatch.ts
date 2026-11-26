/**
 * @ahkms/core/adapters - Supabase persistence for Drive watch channels (ADR-101, Issue #1348).
 *
 * Persists and retrieves active Google Drive changes.watch channels
 * in the user_integrations table under provider='google_drive' config.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredDriveWatchChannel } from "../../ports/driveWatch.js";

export type DriveWatchSupabaseClient = Pick<SupabaseClient, "from">;

export interface SupabaseDriveWatchPersistence {
	getStoredChannel(account: string): Promise<StoredDriveWatchChannel | null>;
	saveChannel(channel: StoredDriveWatchChannel): Promise<void>;
}

export function createSupabaseDriveWatchPersistence(
	client: DriveWatchSupabaseClient,
	userId: string,
): SupabaseDriveWatchPersistence {
	return {
		async getStoredChannel(account: string): Promise<StoredDriveWatchChannel | null> {
			const { data, error } = await client
				.from("user_integrations")
				.select("config")
				.eq("user_id", userId)
				.eq("provider", "google_drive")
				.maybeSingle();

			if (error || !data) return null;

			const config = (data.config ?? {}) as Record<string, unknown>;
			const watchChannels = (config.watch_channels ?? {}) as Record<string, unknown>;
			const raw = watchChannels[account] as Record<string, unknown> | undefined;

			if (!raw || typeof raw !== "object") return null;

			if (
				typeof raw.id === "string" &&
				typeof raw.resourceId === "string" &&
				(typeof raw.expiration === "string" || typeof raw.expiration === "number")
			) {
				return {
					id: raw.id,
					resourceId: raw.resourceId,
					expiration: String(raw.expiration),
					address: typeof raw.address === "string" ? raw.address : "",
					account,
					updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
					...(typeof raw.pageToken === "string" ? { pageToken: raw.pageToken } : {}),
				};
			}

			return null;
		},

		async saveChannel(channel: StoredDriveWatchChannel): Promise<void> {
			const { data: existing, error: readError } = await client
				.from("user_integrations")
				.select("config")
				.eq("user_id", userId)
				.eq("provider", "google_drive")
				.maybeSingle();

			if (readError) {
				throw new Error(`Failed to read user_integrations for google_drive: ${readError.message}`);
			}

			const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
			const existingWatchChannels = (currentConfig.watch_channels ?? {}) as Record<string, unknown>;

			const mergedConfig = {
				...currentConfig,
				watch_channels: {
					...existingWatchChannels,
					[channel.account]: {
						id: channel.id,
						resourceId: channel.resourceId,
						expiration: channel.expiration,
						address: channel.address,
						account: channel.account,
						updatedAt: channel.updatedAt,
						...(channel.pageToken !== undefined ? { pageToken: channel.pageToken } : {}),
					},
				},
			};

			if (existing) {
				const { error: updateError } = await client
					.from("user_integrations")
					.update({ config: mergedConfig })
					.eq("user_id", userId)
					.eq("provider", "google_drive");

				if (updateError) {
					throw new Error(
						`Failed to update user_integrations watch channel for google_drive: ${updateError.message}`,
					);
				}
			} else {
				const { error: insertError } = await client
					.from("user_integrations")
					.insert({
						user_id: userId,
						provider: "google_drive",
						enabled: true,
						config: mergedConfig,
					});

				if (insertError) {
					throw new Error(
						`Failed to insert user_integrations watch channel for google_drive: ${insertError.message}`,
					);
				}
			}
		},
	};
}
