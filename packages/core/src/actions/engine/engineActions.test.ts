import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { EntityDerivePorts } from "../domain/derivePorts.js";
import { setActionScope } from "../scope.js";
import type { ActionAuditRecord, ActionContext } from "../types.js";
import { createEntityDeriveSweepAction } from "./deriveSweep.js";
import { createDriveWatchRenewAction } from "./driveWatchRenew.js";

describe("engine registry actions (#1554)", () => {
	describe("entity_derive_sweep", () => {
		it("derives picked artifacts via nested entity_derive action calls with linked traceId and parentRequestId", async () => {
			const storage = new AsyncLocalStorage<ActionContext>();
			setActionScope({
				current: () => storage.getStore(),
				run: (ctx, fn) => storage.run(ctx, fn),
			});

			const OWNER = "11111111-1111-4111-8111-111111111111";
			const ART_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
			const ART_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
			const TEXT_1 = "Artifact one valid content string longer than fifty characters for derivation.";
			const TEXT_2 = "Artifact two valid content string longer than fifty characters for derivation.";

			const candidateRows = [
				{ id: ART_1, plain_text: TEXT_1 },
				{ id: ART_2, plain_text: TEXT_2 },
			];

			const derivePorts: EntityDerivePorts = {
				fetchCandidatePage: vi.fn(async () => candidateRows),
				fetchArtifactsByIds: vi.fn(async (_userId: string, ids: string[]) =>
					candidateRows.filter((r) => ids.includes(r.id)),
				),
				countUnderived: vi.fn(async () => 3),
				generate: vi.fn(async () => ({
					text: JSON.stringify({
						entities: [{ entity_type: "people", title: "Alice", confidence: 0.9 }],
					}),
					provider: "gemini" as const,
					model: "m",
				})),
				findEntity: vi.fn(async () => null),
				createEntity: vi.fn(async () => "e-1"),
				linkArtifactEntity: vi.fn(async () => undefined),
				createRelationship: vi.fn(async () => undefined),
				saveDerivation: vi.fn(async () => undefined),
				recordDecision: vi.fn(async () => undefined),
			};

			const auditRecords: ActionAuditRecord[] = [];
			const auditSink = async (rec: ActionAuditRecord) => {
				auditRecords.push(rec);
			};

			const sweepAction = createEntityDeriveSweepAction(derivePorts, { auditSink });

			expect(sweepAction.expose).toMatchObject({
				mcp: false,
				http: false,
				ui_agent: false,
				worker: true,
				cli: false,
				a2a: false,
				reason: "app_internal",
			});

			const result = await executeAction(
				sweepAction,
				{
					user_ids: [OWNER],
					limit: 5,
					force: false,
				},
				{
					context: {
						caller: "worker",
						userId: OWNER,
					},
					auditSink,
				},
			);

			expect(result).toEqual({
				users: 1,
				processed: 2,
				entities_created: 2,
				entities_linked: 2,
				relationships_created: 0,
				remaining_underived: 3,
				errors: 0,
			});

			const deriveAudits = auditRecords.filter((r) => r.actionId === "entity_derive");
			const sweepAudits = auditRecords.filter((r) => r.actionId === "entity_derive_sweep");
			expect(deriveAudits).toHaveLength(2);
			expect(sweepAudits).toHaveLength(1);

			const sweepRecord = sweepAudits[0];
			expect(sweepRecord.outcome).toBe("success");
			expect(sweepRecord.caller).toBe("worker");

			for (const childRecord of deriveAudits) {
				expect(childRecord.outcome).toBe("success");
				expect(childRecord.parentRequestId).toBe(sweepRecord.requestId);
				expect(childRecord.traceId).toBe(sweepRecord.traceId);
			}
		});
	});

	describe("drive_watch_renew", () => {
		it("registers missing channels, renews expiring channels (stopping old channel), and leaves active channels outside window untouched", async () => {
			const now = Date.now();
			const storedChannels: Record<string, any> = {
				missing_acct: null,
				expiring_acct: {
					account: "expiring_acct",
					id: "old-chan",
					resourceId: "old-res",
					expiration: now + 60_000, // 1 min left (inside 24h window)
					address: "https://ahos.example.com/webhooks/drive",
					updatedAt: new Date(now - 3600_000).toISOString(),
					pageToken: "existing-page-token-42",
				},
				healthy_acct: {
					account: "healthy_acct",
					id: "healthy-chan",
					resourceId: "healthy-res",
					expiration: now + 72 * 60 * 60 * 1000, // 72h left (outside 24h window)
					address: "https://ahos.example.com/webhooks/drive",
					updatedAt: new Date(now - 3600_000).toISOString(),
					pageToken: "healthy-page-token",
				},
			};

			const saved: any[] = [];
			const registered: any[] = [];
			const stopped: any[] = [];

			const ports = {
				listAccounts: () => ["missing_acct", "expiring_acct", "healthy_acct"],
				getStoredChannel: vi.fn(async (account: string) => storedChannels[account] ?? null),
				saveChannel: vi.fn(async (channel: any) => {
					saved.push(channel);
				}),
				registerWatch: vi.fn(async (params: any) => {
					registered.push(params);
					return {
						id: `new-${params.account}`,
						resourceId: `res-${params.account}`,
						expiration: now + 7 * 24 * 60 * 60 * 1000,
						pageToken: `fresh-seed-${params.account}`,
					};
				}),
				stopWatch: vi.fn(async (params: any) => {
					stopped.push(params);
				}),
			};

			const renewAction = createDriveWatchRenewAction(ports);
			expect(renewAction.expose).toMatchObject({
				mcp: false,
				http: false,
				ui_agent: false,
				worker: true,
				cli: false,
				a2a: false,
				reason: "app_internal",
			});

			const auditRecords: ActionAuditRecord[] = [];
			const result = await executeAction(
				renewAction,
				{
					webhookBaseUrl: "https://ahos.example.com/",
					webhookToken: "sec-token",
					renewalWindowMs: 24 * 60 * 60 * 1000,
				},
				{
					context: { caller: "worker" },
					auditSink: async (rec) => {
						auditRecords.push(rec);
					},
				},
			);

			expect(result).toEqual({
				accounts: 3,
				registered: 1,
				renewed: 1,
				active: 1,
				errors: 0,
			});

			expect(registered).toHaveLength(2);
			expect(registered[0]).toMatchObject({
				account: "missing_acct",
				address: "https://ahos.example.com/webhooks/drive",
				token: "sec-token",
			});
			expect(registered[1]).toMatchObject({
				account: "expiring_acct",
				address: "https://ahos.example.com/webhooks/drive",
				token: "sec-token",
			});

			expect(stopped).toEqual([
				{
					account: "expiring_acct",
					channelId: "old-chan",
					resourceId: "old-res",
				},
			]);
			expect(saved).toHaveLength(2);
			// Initial registration seeds pageToken from registerWatch
			expect(saved[0].pageToken).toBe("fresh-seed-missing_acct");
			// Renewal preserves existing pageToken rather than re-seeding
			expect(saved[1].pageToken).toBe("existing-page-token-42");
			expect(auditRecords).toHaveLength(1);
			expect(auditRecords[0]).toMatchObject({
				actionId: "drive_watch_renew",
				caller: "worker",
				outcome: "success",
			});
		});
	});
});
