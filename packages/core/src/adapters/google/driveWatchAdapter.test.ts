import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveWatchAdapter } from "./driveWatchAdapter.js";

describe("driveWatchAdapter", () => {
	const validConfig = {
		clientId: "test-client-id",
		clientSecret: "test-client-secret",
		refreshTokens: {
			personal: "refresh-token-personal",
			work: "refresh-token-work",
		},
	};

	it("lists configured accounts with valid refresh tokens", async () => {
		const adapter = createGoogleDriveWatchAdapter({
			...validConfig,
			refreshTokens: {
				personal: "token-p",
				empty: "",
				work: "token-h",
			},
		});

		const accounts = await adapter.listAccounts();
		expect(accounts).toEqual(["personal", "work"]);
	});

	it("exchanges refresh token and successfully registers watch channel", async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("oauth2.googleapis.com/token")) {
				return {
					ok: true,
					json: async () => ({ access_token: "mock-access-token" }),
				};
			}
			if (url.includes("changes/startPageToken")) {
				return {
					ok: true,
					json: async () => ({ startPageToken: "token-12345" }),
				};
			}
			if (url.includes("changes/watch")) {
				return {
					ok: true,
					json: async () => ({
						kind: "api#channel",
						id: "test-chan-id",
						resourceId: "res-id-999",
						expiration: "1728345600000",
					}),
				};
			}
			return { ok: false, status: 404, text: async () => "Not Found" };
		});

		const adapter = createGoogleDriveWatchAdapter({
			...validConfig,
			fetchFn: mockFetch as unknown as typeof fetch,
		});

		const res = await adapter.registerWatch({
			account: "personal",
			channelId: "test-chan-id",
			address: "https://your-app.up.railway.app/webhooks/drive",
			token: "webhook-secret-token",
		});

		expect(res).toEqual({
			id: "test-chan-id",
			resourceId: "res-id-999",
			expiration: "1728345600000",
			pageToken: "token-12345",
		});

		expect(mockFetch).toHaveBeenCalledTimes(3);
		// Check changes/watch payload
		const watchCall = mockFetch.mock.calls[2];
		expect(watchCall[0]).toContain("pageToken=token-12345");
		expect(JSON.parse(watchCall[1].body)).toEqual({
			id: "test-chan-id",
			type: "web_hook",
			address: "https://your-app.up.railway.app/webhooks/drive",
			token: "webhook-secret-token",
		});
	});

	it("throws helpful error when oauth token exchange fails", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => "invalid_grant",
		});

		const adapter = createGoogleDriveWatchAdapter({
			...validConfig,
			fetchFn: mockFetch as unknown as typeof fetch,
		});

		await expect(
			adapter.registerWatch({
				account: "personal",
				channelId: "chan-1",
				address: "https://your-app.up.railway.app/webhooks/drive",
				token: "tok",
			}),
		).rejects.toThrow("Google OAuth token exchange failed for account 'personal' (HTTP 401): invalid_grant");
	});

	it("stops channel and gracefully handles 404/not found", async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("oauth2.googleapis.com/token")) {
				return {
					ok: true,
					json: async () => ({ access_token: "mock-access-token" }),
				};
			}
			if (url.includes("channels/stop")) {
				return {
					ok: false,
					status: 404,
					text: async () => "Channel not found or already expired",
				};
			}
			return { ok: false, status: 500 };
		});

		const adapter = createGoogleDriveWatchAdapter({
			...validConfig,
			fetchFn: mockFetch as unknown as typeof fetch,
		});

		// Should not throw on 404
		await expect(
			adapter.stopWatch({
				account: "personal",
				channelId: "old-chan",
				resourceId: "old-res",
			}),
		).resolves.toBeUndefined();
	});

	it("lists changes with includeRemoved, includeItemsFromAllDrives, and supportsAllDrives", async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("oauth2.googleapis.com/token")) {
				return {
					ok: true,
					json: async () => ({ access_token: "mock-access-token" }),
				};
			}
			if (url.includes("drive/v3/changes?")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						changes: [{ fileId: "f1", removed: true, time: "2026-10-11T00:00:00Z" }],
						newStartPageToken: "tok-99",
					}),
				};
			}
			return { ok: false, status: 500, text: async () => "Err" };
		});

		const adapter = createGoogleDriveWatchAdapter({
			...validConfig,
			fetchFn: mockFetch as unknown as typeof fetch,
		});

		const page = await adapter.listChanges({
			account: "personal",
			pageToken: "tok-1",
		});

		expect(page).toEqual({
			changes: [{ fileId: "f1", removed: true, time: "2026-10-11T00:00:00Z" }],
			nextPageToken: null,
			newStartPageToken: "tok-99",
		});
		const changesCallUrl = String(mockFetch.mock.calls[1][0]);
		expect(changesCallUrl).toContain("pageToken=tok-1");
		expect(changesCallUrl).toContain("includeRemoved=true");
		expect(changesCallUrl).toContain("includeItemsFromAllDrives=true");
		expect(changesCallUrl).toContain("supportsAllDrives=true");
	});
});
