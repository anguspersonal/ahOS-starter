import { describe, expect, it, vi } from "vitest";
import { createSupabaseDriveWatchPersistence } from "./driveWatch.js";

describe("supabase/driveWatch", () => {
	const userId = "test-user-uuid";

	it("returns null when no user_integrations row exists", async () => {
		const mockClient = {
			from: vi.fn().mockReturnValue({
				select: vi.fn().mockReturnValue({
					eq: vi.fn().mockReturnValue({
						eq: vi.fn().mockReturnValue({
							maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
						}),
					}),
				}),
			}),
		};

		const persistence = createSupabaseDriveWatchPersistence(mockClient as any, userId);
		const chan = await persistence.getStoredChannel("personal");
		expect(chan).toBeNull();
	});

	it("returns stored channel when present in config", async () => {
		const stored = {
			id: "chan-abc",
			resourceId: "res-xyz",
			expiration: "1728345600000",
			address: "https://your-app.up.railway.app/webhooks/drive",
			account: "personal",
			updatedAt: "2026-10-06T12:00:00.000Z",
		};

		const mockClient = {
			from: vi.fn().mockReturnValue({
				select: vi.fn().mockReturnValue({
					eq: vi.fn().mockReturnValue({
						eq: vi.fn().mockReturnValue({
							maybeSingle: vi.fn().mockResolvedValue({
								data: {
									config: {
										default_folder_id: "folder-123",
										watch_channels: {
											personal: stored,
										},
									},
								},
								error: null,
							}),
						}),
					}),
				}),
			}),
		};

		const persistence = createSupabaseDriveWatchPersistence(mockClient as any, userId);
		const chan = await persistence.getStoredChannel("personal");
		expect(chan).toEqual(stored);
	});

	it("saves channel into existing user_integrations config preserving other keys", async () => {
		let updatedConfig: any = null;

		const mockClient = {
			from: vi.fn().mockImplementation((table: string) => {
				if (table !== "user_integrations") throw new Error("Unexpected table");
				return {
					select: vi.fn().mockReturnValue({
						eq: vi.fn().mockReturnValue({
							eq: vi.fn().mockReturnValue({
								maybeSingle: vi.fn().mockResolvedValue({
									data: {
										config: {
											default_folder_id: "folder-123",
											watch_channels: {
												work: { id: "old-work" },
											},
										},
									},
									error: null,
								}),
							}),
						}),
					}),
					update: vi.fn().mockImplementation((payload) => {
						updatedConfig = payload.config;
						return {
							eq: vi.fn().mockReturnValue({
								eq: vi.fn().mockResolvedValue({ error: null }),
							}),
						};
					}),
				};
			}),
		};

		const persistence = createSupabaseDriveWatchPersistence(mockClient as any, userId);
		await persistence.saveChannel({
			id: "chan-new",
			resourceId: "res-new",
			expiration: "1728345600000",
			address: "https://your-app.up.railway.app/webhooks/drive",
			account: "personal",
			updatedAt: "2026-10-06T12:00:00.000Z",
		});

		expect(updatedConfig).toEqual({
			default_folder_id: "folder-123",
			watch_channels: {
				work: { id: "old-work" },
				personal: {
					id: "chan-new",
					resourceId: "res-new",
					expiration: "1728345600000",
					address: "https://your-app.up.railway.app/webhooks/drive",
					account: "personal",
					updatedAt: "2026-10-06T12:00:00.000Z",
				},
			},
		});
	});

	it("inserts user_integrations row if none exists", async () => {
		let insertedRow: any = null;

		const mockClient = {
			from: vi.fn().mockReturnValue({
				select: vi.fn().mockReturnValue({
					eq: vi.fn().mockReturnValue({
						eq: vi.fn().mockReturnValue({
							maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
						}),
					}),
				}),
				insert: vi.fn().mockImplementation((payload) => {
					insertedRow = payload;
					return Promise.resolve({ error: null });
				}),
			}),
		};

		const persistence = createSupabaseDriveWatchPersistence(mockClient as any, userId);
		await persistence.saveChannel({
			id: "chan-first",
			resourceId: "res-first",
			expiration: "1728345600000",
			address: "https://your-app.up.railway.app/webhooks/drive",
			account: "personal",
			updatedAt: "2026-10-06T12:00:00.000Z",
			pageToken: "start-page-tok-1",
		});

		expect(insertedRow).toEqual({
			user_id: userId,
			provider: "google_drive",
			enabled: true,
			config: {
				watch_channels: {
					personal: {
						id: "chan-first",
						resourceId: "res-first",
						expiration: "1728345600000",
						address: "https://your-app.up.railway.app/webhooks/drive",
						account: "personal",
						updatedAt: "2026-10-06T12:00:00.000Z",
						pageToken: "start-page-tok-1",
					},
				},
			},
		});
	});
});
