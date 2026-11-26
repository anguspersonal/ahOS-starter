import { describe, it, expect, vi } from "vitest";
import { createDeriveCadence } from "./deriveCadence.js";
import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const TEXT = "Valid content string longer than 50 characters for the derivation test.";

/** Owner-enforcing ports: any call without a known owner fails like the FK would. */
function ownerEnforcingPorts(): EntityDerivePorts & { seenUsers: string[] } {
	const seenUsers: string[] = [];
	const requireOwner = (userId: string) => {
		seenUsers.push(userId);
		if (userId !== OWNER) throw new Error("entities_user_id_fkey violation");
	};
	return {
		seenUsers,
		fetchCandidatePage: vi.fn(async ({ userId }) => {
			requireOwner(userId);
			return [{ id: "art-1", plain_text: TEXT }];
		}),
		fetchArtifactsByIds: vi.fn(async () => []),
		countUnderived: vi.fn(async () => 4),
		generate: vi.fn(async () => ({
			text: JSON.stringify({ entities: [{ entity_type: "people", title: "Alice", confidence: 0.9 }] }),
			provider: "gemini" as const,
			model: "m",
		})),
		findEntity: vi.fn(async () => null),
		createEntity: vi.fn(async (userId) => {
			requireOwner(userId);
			return "e-1";
		}),
		linkArtifactEntity: vi.fn(async () => undefined),
		createRelationship: vi.fn(async () => undefined),
		saveDerivation: vi.fn(async () => undefined),
		recordDecision: vi.fn(async () => undefined),
	};
}

describe("createDeriveCadence", () => {
	it("creates a 'derive' cadence with the supplied interval and enablement", () => {
		const cadence = createDeriveCadence({
			ports: ownerEnforcingPorts(),
			resolveUserIds: async () => [OWNER],
			intervalMs: 45 * 60 * 1000,
			enabled: () => true,
		});
		expect(cadence.name).toBe("derive");
		expect(cadence.intervalMs).toBe(45 * 60 * 1000);
		expect(cadence.enabled?.()).toBe(true);
	});

	it("runs scoped to the resolved owner and returns counts incl. remaining_underived", async () => {
		const ports = ownerEnforcingPorts();
		const cadence = createDeriveCadence({ ports, resolveUserIds: async () => [OWNER], batchLimit: 5 });
		const counts = await cadence.run();
		expect(counts).toEqual({
			users: 1,
			processed: 1,
			entities_created: 1,
			entities_linked: 1,
			relationships_created: 0,
			remaining_underived: 4,
			errors: 0,
		});
		expect(ports.seenUsers.every((u) => u === OWNER)).toBe(true);
		expect(ports.fetchCandidatePage).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER }));
	});

	it("fails loudly with no owner configured: no nil-UUID fallback, no LLM call (#1306 C1)", async () => {
		const ports = ownerEnforcingPorts();
		const cadence = createDeriveCadence({ ports, resolveUserIds: async () => [] });
		await expect(cadence.run()).rejects.toThrow(/no owner user id/);
		expect(ports.generate).not.toHaveBeenCalled();
		expect(ports.seenUsers).toEqual([]);
	});

	it("an unknown owner produces counted errors and no 'completed' marks", async () => {
		const ports = ownerEnforcingPorts();
		const cadence = createDeriveCadence({ ports, resolveUserIds: async () => ["00000000-0000-0000-0000-000000000000"] });
		const counts = await cadence.run();
		expect(counts.errors).toBeGreaterThan(0);
		expect(counts.entities_linked).toBe(0);
		expect(ports.saveDerivation).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ status: "completed" }),
		);
	});

	it("iterates every resolved user", async () => {
		const ports = ownerEnforcingPorts();
		const cadence = createDeriveCadence({ ports, resolveUserIds: async () => [OWNER, OWNER, "other-user"] });
		const counts = await cadence.run();
		expect(counts.users).toBe(2);
		expect(ports.seenUsers).toContain("other-user");
	});
});
