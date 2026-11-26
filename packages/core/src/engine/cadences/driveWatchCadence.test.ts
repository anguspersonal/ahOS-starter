import { describe, expect, it, vi } from "vitest";
import { createDriveWatchCadence } from "./driveWatchCadence.js";
import type { DriveWatchPorts, StoredDriveWatchChannel } from "../../ports/driveWatch.js";

describe("driveWatchCadence", () => {
	const createMockPorts = (overrides: Partial<DriveWatchPorts> = {}): DriveWatchPorts => {
		const channels = new Map<string, StoredDriveWatchChannel>();
		return {
			listAccounts: vi.fn().mockResolvedValue(["personal"]),
			getStoredChannel: vi.fn().mockImplementation(async (account: string) => channels.get(account) ?? null),
			saveChannel: vi.fn().mockImplementation(async (chan: StoredDriveWatchChannel) => {
				channels.set(chan.account, chan);
			}),
			registerWatch: vi.fn().mockImplementation(async ({ account, channelId }) => ({
				id: channelId,
				resourceId: `res-${account}`,
				expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days ahead
				pageToken: `seed-tok-${account}`,
			})),
			stopWatch: vi.fn().mockResolvedValue(undefined),
			...overrides,
		};
	};

	it("skips run if webhookBaseUrl or webhookToken is missing", async () => {
		const ports = createMockPorts();
		const cadence = createDriveWatchCadence({
			ports,
			webhookBaseUrl: "",
			webhookToken: "test-token",
		});

		const result = (await cadence.run()) as any;
		expect(result.skipped).toBe(true);
		expect(ports.listAccounts).not.toHaveBeenCalled();
	});

	it("registers new channel when none exists", async () => {
		const ports = createMockPorts();
		const cadence = createDriveWatchCadence({
			ports,
			webhookBaseUrl: "https://your-app.up.railway.app",
			webhookToken: "secret-token",
		});

		const result = (await cadence.run()) as any;
		expect(result).toEqual({
			accounts: 1,
			registered: 1,
			renewed: 0,
			active: 0,
			errors: 0,
		});

		expect(ports.registerWatch).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "personal",
				address: "https://your-app.up.railway.app/webhooks/drive",
				token: "secret-token",
			}),
		);
		expect(ports.saveChannel).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "personal",
				address: "https://your-app.up.railway.app/webhooks/drive",
				pageToken: "seed-tok-personal",
			}),
		);
		expect(ports.stopWatch).not.toHaveBeenCalled();
	});

	it("keeps active channel when expiration is outside renewal window", async () => {
		const ports = createMockPorts();
		// Stored channel expiring in 5 days
		const existing: StoredDriveWatchChannel = {
			id: "active-chan",
			resourceId: "res-123",
			expiration: String(Date.now() + 5 * 24 * 60 * 60 * 1000),
			address: "https://your-app.up.railway.app/webhooks/drive",
			account: "personal",
			updatedAt: new Date().toISOString(),
			pageToken: "tok-active",
		};
		vi.mocked(ports.getStoredChannel).mockResolvedValue(existing);

		const cadence = createDriveWatchCadence({
			ports,
			webhookBaseUrl: "https://your-app.up.railway.app",
			webhookToken: "secret-token",
		});

		const result = (await cadence.run()) as any;
		expect(result).toEqual({
			accounts: 1,
			registered: 0,
			renewed: 0,
			active: 1,
			errors: 0,
		});

		expect(ports.registerWatch).not.toHaveBeenCalled();
		expect(ports.stopWatch).not.toHaveBeenCalled();
	});

	it("renews channel when expiring within renewal window, preserves existing pageToken, and stops old channel", async () => {
		const ports = createMockPorts();
		// Stored channel expiring in 2 hours (within default 24h renewal window)
		const expiringSoon: StoredDriveWatchChannel = {
			id: "expiring-chan",
			resourceId: "old-res",
			expiration: String(Date.now() + 2 * 60 * 60 * 1000),
			address: "https://your-app.up.railway.app/webhooks/drive",
			account: "personal",
			updatedAt: new Date().toISOString(),
			pageToken: "preserved-tok-77",
		};
		vi.mocked(ports.getStoredChannel).mockResolvedValue(expiringSoon);

		const cadence = createDriveWatchCadence({
			ports,
			webhookBaseUrl: "https://your-app.up.railway.app",
			webhookToken: "secret-token",
		});

		const result = (await cadence.run()) as any;
		expect(result).toEqual({
			accounts: 1,
			registered: 0,
			renewed: 1,
			active: 0,
			errors: 0,
		});

		expect(ports.registerWatch).toHaveBeenCalled();
		expect(ports.saveChannel).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "personal",
				pageToken: "preserved-tok-77",
			}),
		);
		expect(ports.stopWatch).toHaveBeenCalledWith({
			account: "personal",
			channelId: "expiring-chan",
			resourceId: "old-res",
		});
	});
});
