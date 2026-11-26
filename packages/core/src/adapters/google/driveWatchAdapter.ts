/**
 * @ahkms/core/adapters/google - driveWatchAdapter.ts
 *
 * REST adapter for Google Drive API v3 changes.watch and channels.stop
 * push notification endpoints (ADR-048, ADR-101, Issue #1348).
 */

import type {
	DriveChangesPageResult,
	DriveChangesPort,
	ListDriveChangesParams,
	RawDriveChange,
} from "../../ports/driveWatch.js";

export interface GoogleDriveWatchAdapterConfig {
	clientId?: string;
	clientSecret?: string;
	refreshTokens?: Record<string, string | undefined | null>;
	getRefreshToken?: (account: string) => Promise<string | undefined | null> | string | undefined | null;
	fetchFn?: typeof fetch;
}

export interface GoogleDriveWatchAdapter extends DriveChangesPort {
	listAccounts(): Promise<string[]>;
	getStartPageToken(account: string): Promise<string>;
	registerWatch(params: {
		account: string;
		channelId: string;
		address: string;
		token: string;
	}): Promise<{ id: string; resourceId: string; expiration: string; pageToken: string }>;
	stopWatch(params: {
		account: string;
		channelId: string;
		resourceId: string;
	}): Promise<void>;
}

export function createGoogleDriveWatchAdapter(
	config: GoogleDriveWatchAdapterConfig,
): GoogleDriveWatchAdapter {
	const fetchImpl = config.fetchFn ?? fetch;
	const tokens = config.refreshTokens ?? {};

	async function getAccessToken(account: string): Promise<string> {
		const refreshToken = tokens[account] ?? (await config.getRefreshToken?.(account));
		if (!refreshToken) {
			throw new Error(`Google refresh token for account '${account}' is not configured`);
		}
		if (!config.clientId || !config.clientSecret) {
			throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Drive watch operations");
		}

		const params = new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		});

		const res = await fetchImpl("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			throw new Error(
				`Google OAuth token exchange failed for account '${account}' (HTTP ${res.status}): ${errText}`,
			);
		}

		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			throw new Error(`Google OAuth response for account '${account}' did not contain access_token`);
		}

		return data.access_token;
	}

	async function fetchStartPageTokenWithAccessToken(account: string, accessToken: string): Promise<string> {
		const startTokenUrl =
			"https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true";
		const startTokenRes = await fetchImpl(startTokenUrl, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		});

		if (!startTokenRes.ok) {
			const errText = await startTokenRes.text().catch(() => "");
			throw new Error(
				`Drive changes.getStartPageToken failed for '${account}' (HTTP ${startTokenRes.status}): ${errText}`,
			);
		}

		const startTokenData = (await startTokenRes.json()) as { startPageToken?: string };
		const pageToken = startTokenData.startPageToken;
		if (!pageToken) {
			throw new Error(`Drive startPageToken response for '${account}' was missing startPageToken`);
		}
		return pageToken;
	}

	return {
		async listAccounts(): Promise<string[]> {
			return Object.entries(tokens)
				.filter(([, token]) => Boolean(token && token.trim().length > 0))
				.map(([account]) => account);
		},

		async getStartPageToken(account: string): Promise<string> {
			const accessToken = await getAccessToken(account);
			return fetchStartPageTokenWithAccessToken(account, accessToken);
		},

		async listChanges(params: ListDriveChangesParams): Promise<DriveChangesPageResult> {
			const accessToken = await getAccessToken(params.account);
			const qs = new URLSearchParams({
				pageToken: params.pageToken,
				pageSize: String(params.pageSize ?? 200),
				includeRemoved: String(params.includeRemoved ?? true),
				includeItemsFromAllDrives: String(params.includeItemsFromAllDrives ?? true),
				supportsAllDrives: "true",
				fields:
					"nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,trashed,size,parents,modifiedTime,createdTime,owners(displayName,emailAddress),webViewLink,md5Checksum))",
			});
			const res = await fetchImpl(`https://www.googleapis.com/drive/v3/changes?${qs.toString()}`, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
				},
			});

			if (res.status === 400 || res.status === 404) {
				return { expired: true };
			}

			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(
					`Drive changes.list failed for '${params.account}' (HTTP ${res.status}): ${errText}`,
				);
			}

			const data = (await res.json()) as {
				nextPageToken?: string | null;
				newStartPageToken?: string | null;
				changes?: RawDriveChange[] | null;
			};

			return {
				changes: data.changes ?? [],
				nextPageToken: data.nextPageToken ?? null,
				newStartPageToken: data.newStartPageToken ?? null,
			};
		},

		async registerWatch(params: {
			account: string;
			channelId: string;
			address: string;
			token: string;
		}): Promise<{ id: string; resourceId: string; expiration: string; pageToken: string }> {
			const accessToken = await getAccessToken(params.account);

			// 1. Fetch startPageToken
			const pageToken = await fetchStartPageTokenWithAccessToken(params.account, accessToken);

			// 2. Call changes.watch
			const watchUrl = `https://www.googleapis.com/drive/v3/changes/watch?pageToken=${encodeURIComponent(pageToken)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
			const watchRes = await fetchImpl(watchUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					id: params.channelId,
					type: "web_hook",
					address: params.address,
					token: params.token,
				}),
			});

			if (!watchRes.ok) {
				const errText = await watchRes.text().catch(() => "");
				throw new Error(
					`Drive changes.watch failed for '${params.account}' (HTTP ${watchRes.status}): ${errText}`,
				);
			}

			const watchData = (await watchRes.json()) as {
				id?: string;
				resourceId?: string;
				expiration?: string | number;
			};

			if (!watchData.id || !watchData.resourceId) {
				throw new Error(
					`Drive changes.watch response for '${params.account}' did not return id and resourceId`,
				);
			}

			return {
				id: watchData.id,
				resourceId: watchData.resourceId,
				expiration: watchData.expiration ? String(watchData.expiration) : "",
				pageToken,
			};
		},

		async stopWatch(params: {
			account: string;
			channelId: string;
			resourceId: string;
		}): Promise<void> {
			let accessToken: string;
			try {
				accessToken = await getAccessToken(params.account);
			} catch (err) {
				console.warn(
					`[driveWatchAdapter] Could not get access token to stop channel '${params.channelId}' for '${params.account}':`,
					err,
				);
				return;
			}

			const stopUrl = "https://www.googleapis.com/drive/v3/channels/stop";
			const stopRes = await fetchImpl(stopUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					id: params.channelId,
					resourceId: params.resourceId,
				}),
			});

			if (!stopRes.ok && stopRes.status !== 404) {
				const errText = await stopRes.text().catch(() => "");
				console.warn(
					`[driveWatchAdapter] Drive channels.stop returned HTTP ${stopRes.status} for '${params.channelId}': ${errText}`,
				);
			}
		},
	};
}
