import { describe, it, expect, vi } from "vitest";
import { createDeriveCadence } from "./deriveCadence.js";
import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";
import type { ActionAuditRecord, ActionAuditSink } from "../../actions/types.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const TEXT = "Valid content string longer than 50 characters for the derivation test.";

function ownerEnforcingPorts(): EntityDerivePorts {
	const requireOwner = (userId: string) => {
		if (userId !== OWNER) throw new Error("entities_user_id_fkey violation");
	};
	return {
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

describe("createDeriveCadence ledger recording (#1415)", () => {
	it("6. records (OWNER, success) then (other-user, error) in order and preserves counts", async () => {
		const records: ActionAuditRecord[] = [];
		const auditSink: ActionAuditSink = (record) => {
			records.push(record);
		};

		const cadence = createDeriveCadence({
			ports: ownerEnforcingPorts(),
			resolveUserIds: async () => [OWNER, "other-user"],
			auditSink,
		});

		const counts = await cadence.run();

		expect(counts.users).toBe(2);
		expect(counts.errors).toBeGreaterThanOrEqual(1);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			actionId: "entity_derive",
			caller: "worker",
			seam: "action",
			userId: OWNER,
			outcome: "success",
		});
		expect(records[1]).toMatchObject({
			actionId: "entity_derive",
			caller: "worker",
			seam: "action",
			userId: "other-user",
			outcome: "error",
		});
	});
});
