import { describe, it, expect, vi } from "vitest";
import { createEntityDeriveAction, executeEntityDerive } from "./entityDerive.js";
import { createActionContext } from "../defineAction.js";
import type { CandidateArtifact, ExtractedEntity } from "../domain/derive.js";
import type { DerivationRecord, EntityDerivePorts } from "../domain/derivePorts.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEXT = "Jane Doe works at Acme Corp in London and leads Project Apollo with the team.";

function art(id: string, over: Partial<CandidateArtifact> = {}): CandidateArtifact {
	return { id, title: `T ${id}`, plain_text: TEXT, processing_metadata: {}, ...over };
}

const LLM_OK = JSON.stringify({
	entities: [
		{ entity_type: "people", title: "Jane Doe", confidence: 0.95, email: "jane@example.com" },
		{ entity_type: "organization", title: "Acme Corp", confidence: 0.9 },
	],
	relationships: [
		{ source_title: "Jane Doe", target_title: "Acme Corp", relationship_type: "employed_by", confidence: 0.9 },
	],
});

/**
 * Stateful fake that enforces what the real database enforces: owner scoping on
 * every read and write, and failure of writes for unknown owners (FK emulation).
 * Unlike a permissive mock it can therefore fail.
 */
function createFakePorts(opts: { artifacts: CandidateArtifact[]; llmText?: string }) {
	const entities: Array<{ id: string; userId: string; entity: ExtractedEntity }> = [];
	const links: Array<{ userId: string; artifactId: string; entityId: string }> = [];
	const rels: Array<{ userId: string; from: string; to: string; type: string }> = [];
	const saved = new Map<string, DerivationRecord>();
	const decisions: unknown[] = [];
	const calls = { generate: 0 };
	const ownerOf = (a: CandidateArtifact) => (a as CandidateArtifact & { owner?: string }).owner ?? OWNER;

	const ports: EntityDerivePorts = {
		fetchCandidatePage: vi.fn(async ({ userId, offset, pageSize }) =>
			opts.artifacts
				.filter((a) => ownerOf(a) === userId)
				.filter((a) => {
					const st = (a.processing_metadata as any)?.derivation?.status;
					return st !== "completed" && st !== "skipped";
				})
				.slice(offset, offset + pageSize),
		),
		fetchArtifactsByIds: vi.fn(async (userId, ids) =>
			opts.artifacts.filter((a) => ownerOf(a) === userId && ids.includes(a.id)),
		),
		countUnderived: vi.fn(async () => 7),
		generate: vi.fn(async () => {
			calls.generate++;
			return { text: opts.llmText ?? LLM_OK, provider: "gemini" as const, model: "m" };
		}),
		findEntity: vi.fn(async (userId, type, title) =>
			entities.find((e) => e.userId === userId && e.entity.entity_type === type && e.entity.title === title)?.id ?? null,
		),
		createEntity: vi.fn(async (userId, entity) => {
			if (userId !== OWNER) throw new Error("entities_user_id_fkey violation");
			const id = `ent-${entities.length + 1}`;
			entities.push({ id, userId, entity });
			return id;
		}),
		linkArtifactEntity: vi.fn(async (userId, artifactId, entityId) => {
			links.push({ userId, artifactId, entityId });
		}),
		createRelationship: vi.fn(async (userId, rel) => {
			rels.push({ userId, from: rel.fromEntityId, to: rel.toEntityId, type: rel.relationshipType });
		}),
		saveDerivation: vi.fn(async (userId, artifactId, derivation) => {
			const a = opts.artifacts.find((x) => x.id === artifactId && ownerOf(x) === userId);
			if (!a) throw new Error("no artifact row updated");
			saved.set(artifactId, derivation);
			a.processing_metadata = { ...(a.processing_metadata ?? {}), derivation };
		}),
		recordDecision: vi.fn(async (d) => {
			decisions.push(d);
		}),
	};
	return { ports, entities, links, rels, saved, decisions, calls };
}

const ctx = (userId?: string) => createActionContext({ userId, caller: "worker" });

describe("executeEntityDerive", () => {
	it("refuses to run without an owner userId (no nil-UUID fallback, #1306 C1)", async () => {
		const fake = createFakePorts({ artifacts: [art("a1")] });
		await expect(executeEntityDerive({ limit: 5, force: false }, ctx(undefined), fake.ports)).rejects.toThrow(
			/requires an owner userId/,
		);
		expect(fake.ports.fetchCandidatePage).not.toHaveBeenCalled();
		expect(fake.calls.generate).toBe(0);
	});

	it("derives entities, links and relationships scoped to the owner, then marks completed", async () => {
		const fake = createFakePorts({ artifacts: [art("a1")] });
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);

		expect(out).toMatchObject({
			processed: 1,
			entities_created: 2,
			entities_linked: 2,
			relationships_created: 1,
			remaining_underived: 7,
			failed: 0,
		});
		expect(fake.links.every((l) => l.userId === OWNER && l.artifactId === "a1")).toBe(true);
		expect(fake.saved.get("a1")).toMatchObject({ status: "completed", attempts: 1, entities_count: 2 });
		expect(fake.decisions).toHaveLength(1);
		expect(fake.ports.recordDecision).toHaveBeenCalledWith(
			expect.objectContaining({ userId: OWNER, artifactId: "a1", provider: "gemini" }),
		);
	});

	it("does not see another owner's artifacts", async () => {
		const other = { ...art("x1"), owner: OTHER } as CandidateArtifact;
		const fake = createFakePorts({ artifacts: [other] });
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.processed).toBe(0);
		expect(fake.calls.generate).toBe(0);
	});

	it("does not stamp completed when every entity write fails; records failed with attempts (#1306 M1)", async () => {
		const fake = createFakePorts({ artifacts: [{ ...art("a1"), owner: OTHER } as CandidateArtifact] });
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OTHER), fake.ports);

		expect(out.entities_linked).toBe(0);
		expect(out.failed).toBe(1);
		expect(fake.saved.get("a1")).toMatchObject({ status: "failed", attempts: 1 });
		expect(fake.saved.get("a1")?.status).not.toBe("completed");
		expect(fake.decisions).toHaveLength(0);
	});

	it("a failed relationship write is not counted as created and blocks completion", async () => {
		const fake = createFakePorts({ artifacts: [art("a1")] });
		(fake.ports.createRelationship as any).mockRejectedValueOnce(new Error("HTTP 500"));
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.relationships_created).toBe(0);
		expect(out.failed).toBe(1);
		expect(fake.saved.get("a1")?.status).toBe("failed");
		expect(out.notes.join("\n")).toContain("failed: HTTP 500");
	});

	it("a failed entity lookup never falls through to creating a duplicate", async () => {
		const fake = createFakePorts({ artifacts: [art("a1")] });
		(fake.ports.findEntity as any).mockRejectedValue(new Error("lookup 500"));
		await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(fake.ports.createEntity).not.toHaveBeenCalled();
		expect(fake.saved.get("a1")?.status).toBe("failed");
	});

	it("reports (rather than hides) a failed derivation-status write", async () => {
		const fake = createFakePorts({ artifacts: [art("a1")] });
		(fake.ports.saveDerivation as any).mockRejectedValue(new Error("rpc down"));
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.failed).toBe(1);
		expect(out.notes.join("\n")).toContain("Could not persist derivation status: rpc down");
	});

	it("LLM errors are recorded as failed with an incremented attempt counter", async () => {
		const fake = createFakePorts({
			artifacts: [art("a1", { processing_metadata: { derivation: { status: "failed", attempts: 1, derived_at: "2020-01-01T00:00:00Z" } } })],
		});
		(fake.ports.generate as any).mockRejectedValue(new Error("404 model retired"));
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.failed).toBe(1);
		expect(fake.saved.get("a1")).toMatchObject({ status: "failed", attempts: 2, error: "404 model retired" });
	});

	it("does not re-send completed, terminally skipped or exhausted artifacts to the LLM", async () => {
		const fake = createFakePorts({
			artifacts: [
				art("done", { processing_metadata: { derivation: { status: "completed", derived_at: "2026-01-01T00:00:00Z" } } }),
				art("skip", { processing_metadata: { derivation: { status: "skipped", derived_at: "2026-01-01T00:00:00Z" } } }),
				art("dead", { processing_metadata: { derivation: { status: "failed", attempts: 3, derived_at: "2020-01-01T00:00:00Z" } } }),
			],
		});
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.processed).toBe(0);
		expect(fake.calls.generate).toBe(0);
	});

	it("pages past already-derived rows so the backlog is reached (#1306 H3)", async () => {
		const derived = Array.from({ length: 50 }, (_, i) =>
			art(`d${i}`, { processing_metadata: { derivation: { status: "failed", attempts: 3, derived_at: "2020-01-01T00:00:00Z" } } }),
		);
		const fake = createFakePorts({ artifacts: [...derived, art("backlog")] });
		// SQL excludes completed/skipped only; the 50 exhausted rows fill page 1.
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.processed).toBe(1);
		expect(fake.saved.has("backlog")).toBe(true);
		expect(fake.ports.fetchCandidatePage).toHaveBeenCalledTimes(2);
	});

	it("explicit artifact_ids honour candidate rules, owner scope and the limit", async () => {
		const fake = createFakePorts({
			artifacts: [
				art("1111aaaa-1111-4111-8111-111111111111"),
				art("2222aaaa-2222-4222-8222-222222222222"),
				art("3333aaaa-3333-4333-8333-333333333333", { plain_text: "short" }),
			],
		});
		const ids = fake.ports.fetchArtifactsByIds;
		const out = await executeEntityDerive(
			{
				limit: 1,
				force: false,
				artifact_ids: [
					"1111aaaa-1111-4111-8111-111111111111",
					"2222aaaa-2222-4222-8222-222222222222",
					"3333aaaa-3333-4333-8333-333333333333",
				],
			},
			ctx(OWNER),
			fake.ports,
		);
		expect(ids).toHaveBeenCalledWith(OWNER, expect.any(Array));
		expect(out.processed).toBe(1);
		expect(fake.calls.generate).toBe(1);
		expect(out.remaining_underived).toBeNull();
	});

	it("skips too-short and binary text without calling the LLM", async () => {
		const fake = createFakePorts({
			artifacts: [art("bin", { plain_text: "%PDF-1.4 " + "x".repeat(80) })],
		});
		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(fake.calls.generate).toBe(0);
		expect(fake.saved.get("bin")).toMatchObject({ status: "skipped" });
		expect(out.notes[0]).toContain("Skipped");
	});

	it("hostile LLM output cannot reach a wildcard lookup or unbounded write", async () => {
		const hostile = JSON.stringify({
			entities: [
				{ entity_type: "people", title: "*", confidence: 0.99 },
				{ entity_type: "people", title: "%", confidence: 0.99 },
				{ entity_type: "people", title: "Real Person", confidence: 0.99, properties: { user_id: OTHER, admin: true } },
			],
		});
		const fake = createFakePorts({ artifacts: [art("a1")], llmText: hostile });
		await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		const titles = (fake.ports.findEntity as any).mock.calls.map((c: unknown[]) => c[2]);
		expect(titles).toEqual(["Real Person"]);
		expect(fake.entities[0].entity.properties).toEqual({ confidence: 0.99 });
	});

	it("applies ADR-026 source trust modifier (low: 0.75) so confidence 0.8 is filtered out and 0.95 survives at 0.71", async () => {
		const llmResponse = JSON.stringify({
			entities: [
				{ entity_type: "people", title: "Marginal Person", confidence: 0.8, ego_salience: 0.85 },
				{ entity_type: "people", title: "High-Confidence Person", confidence: 0.95, ego_salience: 0.9 },
				{ entity_type: "organization", title: "Acme Corp", confidence: 0.95, ego_salience: 0.85 },
			],
			relationships: [
				{
					source_title: "High-Confidence Person",
					target_title: "Acme Corp",
					relationship_type: "employed_by",
					confidence: 0.8,
				},
				{
					source_title: "High-Confidence Person",
					target_title: "Acme Corp",
					relationship_type: "leads",
					confidence: 0.95,
				},
			],
		});
		const fake = createFakePorts({
			artifacts: [art("low-trust-1", { surface: "whatsapp", trust_override: "low" })],
			llmText: llmResponse,
		});

		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out).toMatchObject({
			processed: 1,
			entities_created: 2,
			entities_linked: 2,
			relationships_created: 1,
			failed: 0,
		});
		expect(fake.ports.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("Source Trust Tier: low"),
			}),
		);
		expect(fake.entities.map((e) => ({ title: e.entity.title, confidence: e.entity.confidence }))).toEqual([
			{ title: "High-Confidence Person", confidence: 0.71 },
			{ title: "Acme Corp", confidence: 0.71 },
		]);
		expect(fake.ports.linkArtifactEntity).toHaveBeenCalledWith(OWNER, "low-trust-1", "ent-1", 0.71);
		expect(fake.ports.linkArtifactEntity).toHaveBeenCalledWith(OWNER, "low-trust-1", "ent-2", 0.71);
		expect(fake.ports.createRelationship).toHaveBeenCalledTimes(1);
		expect(fake.ports.createRelationship).toHaveBeenCalledWith(OWNER, {
			fromEntityId: "ent-1",
			toEntityId: "ent-2",
			relationshipType: "leads",
			confidence: 0.71,
			artifactId: "low-trust-1",
		});
	});

	it("skips artifact before calling ports.generate when ports.judge noul pre-filter returns < 0.30 (#2121)", async () => {
		const fake = createFakePorts({ artifacts: [art("ephemeral-1")] });
		fake.ports.judge = {
			evaluate: vi.fn().mockResolvedValue({
				id: "contains_durable_entities",
				kind: "noul" as const,
				choice: "no",
				confidence: 0.88,
				distribution: { yes: 0.12, no: 0.88 },
				model: "gemini-2.5-flash-lite",
				latency_ms: 10,
			}),
		};

		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(fake.calls.generate).toBe(0);
		expect(fake.saved.get("ephemeral-1")).toMatchObject({ status: "skipped" });
		expect(out.notes.join("\n")).toContain("contains_durable_entities below threshold");
	});

	it("filters out < 0.55 judge-calibrated entities and records pending clarification decision for 0.55..0.89 confidence (#2121)", async () => {
		const fake = createFakePorts({ artifacts: [art("calib-1")] });
		fake.ports.judge = {
			evaluate: vi.fn().mockImplementation(async (q) => {
				if (q.id === "contains_durable_entities") {
					return {
						id: q.id,
						kind: "noul" as const,
						choice: "yes",
						confidence: 0.91,
						distribution: { yes: 0.91, no: 0.09 },
						model: "gemini-2.5-flash-lite",
						latency_ms: 10,
					};
				}
				if (String(q.prompt).includes('"Acme Corp"')) {
					return {
						id: q.id,
						kind: "noul" as const,
						choice: "no",
						confidence: 0.7,
						distribution: { yes: 0.3, no: 0.7 },
						model: "gemini-2.5-flash-lite",
						latency_ms: 10,
					};
				}
				return {
					id: q.id,
					kind: "noul" as const,
					choice: "yes",
					confidence: 0.72,
					distribution: { yes: 0.72, no: 0.28 },
					model: "gemini-2.5-flash-lite",
					latency_ms: 10,
				};
			}),
		};

		const out = await executeEntityDerive({ limit: 5, force: false }, ctx(OWNER), fake.ports);
		expect(out.processed).toBe(1);
		expect(out.entities_created).toBe(1);
		expect(fake.entities.map((e) => e.entity.title)).toEqual(["Jane Doe"]);
		expect(fake.ports.recordDecision).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: OWNER,
				artifactId: "calib-1",
				confidence: 0.72,
				status: "pending",
				requires_user_action: true,
				user_visible: true,
				review_type: "clarification",
				confidence_band: "pending",
			}),
		);
	});
});

describe("createEntityDeriveAction", () => {
	it("takes ports as a parameter and runs through the action wrapper", async () => {
		const fake = createFakePorts({ artifacts: [art("a1")] });
		const action = createEntityDeriveAction(fake.ports);
		expect(action.id).toBe("entity_derive");
		const out = await action.run({ limit: 5, force: false }, ctx(OWNER));
		expect(out.processed).toBe(1);
	});
});
