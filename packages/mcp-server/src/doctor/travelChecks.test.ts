import { describe, expect, it } from "vitest";
import type { AhkmsCapability } from "../skill-sync/ahkmsSource.js";
import { hashBody } from "../skill-sync/hash.js";
import type { RepoSkillManifest } from "../skill-sync/repoManifest.js";
import type { HotTierRow } from "../hotTier.js";
import { classifyTravel, classifyInstructionTravel, classifyHotTier } from "./travelChecks.js";

const BODY = "---\nname: dos\n---\nthe ritual\n";

const cap = (over: Partial<AhkmsCapability>): AhkmsCapability => ({
	name: "dos",
	kind: "skill",
	storageLocation: "kms-db",
	storageUrl: null,
	surface: ["claude-code"],
	body: BODY,
	bodySyncedAt: "2026-09-24T20:31:13Z",
	...over,
});

const manifest = (skills: RepoSkillManifest["skills"]): RepoSkillManifest => ({ version: 1, skills });

const entry = (over: Partial<RepoSkillManifest["skills"][string]> = {}) => ({
	register: true,
	why: "w",
	surface: ["claude-code"],
	supporting_files: [],
	body_sha256: hashBody(BODY),
	registered_at: "2026-09-24T20:31:13Z",
	...over,
});

const find = (checks: ReturnType<typeof classifyTravel>, name: string) => checks.find((c) => c.name === name);

describe("classifyTravel: repo receipts against the live registry", () => {
	it("is ok when the registry body hashes to the receipt", () => {
		const checks = classifyTravel(manifest({ dos: entry() }), [cap({})]);
		expect(checks.every((c) => c.status === "ok")).toBe(true);
		expect(checks.map((c) => c.detail).join(" ")).toContain("1 repo skill");
	});

	it("warns 'push owed' when registered_at is null and the registry does not hold the bytes yet", () => {
		const checks = classifyTravel(
			manifest({ dos: entry({ registered_at: null, body_sha256: hashBody("newer") }) }),
			[cap({})],
		);
		const c = find(checks, "skill dos");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("push owed");
		expect(c?.fix).toContain("repo push dos");
	});

	it("does not nag about an unstamped receipt whose bytes the registry already serves", () => {
		const checks = classifyTravel(manifest({ dos: entry({ registered_at: null }) }), [cap({})]);
		expect(find(checks, "skill dos")).toBeUndefined();
	});

	it("fails a stamped receipt the registry no longer matches (an out-of-band edit, or a lost push)", () => {
		const checks = classifyTravel(manifest({ dos: entry() }), [cap({ body: "edited by hand" })]);
		const c = find(checks, "skill dos");
		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("differs");
	});

	it("fails a hosted row with no body — the #689 class", () => {
		const checks = classifyTravel(manifest({ dos: entry() }), [cap({ body: null })]);
		expect(find(checks, "skill dos")?.status).toBe("fail");
	});

	it("fails a stamped receipt with no registry row at all", () => {
		const checks = classifyTravel(manifest({ dos: entry() }), []);
		expect(find(checks, "skill dos")?.status).toBe("fail");
	});

	it("ignores register:false skills", () => {
		const checks = classifyTravel(manifest({ dogfood: { register: false, why: "forked" } }), []);
		expect(find(checks, "skill dogfood")).toBeUndefined();
	});

	it("fails a registry-only hosted capability that serves no body, and ignores external pointers", () => {
		const checks = classifyTravel(manifest({}), [
			cap({ name: "usage-pace", body: null }),
			cap({ name: "pdf", storageLocation: "claude", body: null }),
		]);
		expect(find(checks, "capability usage-pace")?.status).toBe("fail");
		expect(find(checks, "capability pdf")).toBeUndefined();
	});

	it("checks claude custom instructions freshness (#1025)", async () => {
		const canonical = "a".repeat(64);
		const now = new Date("2026-09-26T12:00:00Z");

		// When never pasted
		const unpasted = classifyTravel(manifest({}), [], null);
		const cUnpasted = find(unpasted, "claude instructions freshness");
		expect(cUnpasted?.status).toBe("warn");
		expect(cUnpasted?.detail).toContain("never recorded as pasted");
		expect(cUnpasted?.fix).toContain("instructions_mark_pasted");

		// A pasted hash matching this fake canonical does NOT match the real one:
		// classifyTravel defaults to the real getCanonicalInstructionsHash(), so this
		// case is drifted, not ok.
		const match = classifyTravel(
			manifest({}),
			[],
			{ sha256: canonical, pasted_at: "2026-09-25T12:00:00Z" },
		);
		const cMatch = find(match, "claude instructions freshness");
		expect(cMatch?.status).toBe("warn");
		expect(cMatch?.detail).toContain("pasted copy is behind");

		// Now test with the real canonical hash, where it should resolve "ok"
		const { getCanonicalInstructionsHash } = await import("../canonicalInstructions.js");
		const realCanonical = getCanonicalInstructionsHash();
		const matching = classifyTravel(
			manifest({}),
			[],
			{ sha256: realCanonical, pasted_at: "2026-09-25T12:00:00Z" },
		);
		const cMatching = find(matching, "claude instructions freshness");
		expect(cMatching?.status).toBe("ok");
		expect(cMatching?.detail).toContain("up-to-date");

		// When drifted (pasted 14 days ago)
		const driftedCheck = classifyInstructionTravel(
			{ sha256: "b".repeat(64), pasted_at: "2026-09-12T12:00:00Z" },
			canonical,
			now,
		);
		expect(driftedCheck.status).toBe("warn");
		expect(driftedCheck.detail).toContain("pasted copy is behind, last pasted 2 weeks ago");

		// Also verify classifyTravel passes through pasted instructions
		const drifted = classifyTravel(
			manifest({}),
			[],
			{ sha256: "b".repeat(64), pasted_at: "2026-09-12T12:00:00Z" },
		);
		const cDrifted = find(drifted, "claude instructions freshness");
		expect(cDrifted?.status).toBe("warn");
		expect(cDrifted?.detail).toContain("pasted copy is behind");
	});

	describe("classifyHotTier: hot tier line cap (#1023, #1155)", () => {
		const makeRow = (id: string, entity_type: "people" | "term", title: string): HotTierRow => ({
			id,
			entity_type,
			title,
			description: `Desc for ${title}`,
			properties: entity_type === "term" ? { expansion: `${title} Exp`, context: "Context" } : { role: "Engineer" },
			aliases: [`${title}_alias`],
		});

		it("is ok with 0 hot rows", () => {
			const check = classifyHotTier([]);
			expect(check.status).toBe("ok");
			expect(check.name).toBe("hot tier line cap");
			expect(check.family).toBe("travels");
			expect(check.detail).toContain("0 hot rows (0 lines rendered, 0 omitted)");
			expect(check.detail).toContain("fits under the 100-line cap");
			expect(check.fix).toBe("");
		});

		it("is ok when hot rows fit comfortably under the 100-line cap", () => {
			const rows: HotTierRow[] = [
				makeRow("1", "people", "Alice"),
				makeRow("2", "people", "Bob"),
				makeRow("3", "term", "PSR"),
			];
			const check = classifyHotTier(rows);
			expect(check.status).toBe("ok");
			expect(check.detail).toContain("3 hot rows");
			expect(check.detail).toContain("0 omitted");
			expect(check.detail).toContain("fits under the 100-line cap");
			expect(check.fix).toBe("");
		});

		it("warns when hot rows exceed the cap and names how many were omitted (#1155 acceptance)", () => {
			// Generate 120 rows (more than can fit under the 100-line cap)
			const rows: HotTierRow[] = [];
			for (let i = 0; i < 60; i++) {
				rows.push(makeRow(`p-${i}`, "people", `Person ${i}`));
			}
			for (let i = 0; i < 60; i++) {
				rows.push(makeRow(`t-${i}`, "term", `Term ${i}`));
			}

			const check = classifyHotTier(rows);
			expect(check.status).toBe("warn");
			expect(check.name).toBe("hot tier line cap");
			expect(check.detail).toContain("120 hot rows");
			// Check names how many were omitted
			expect(check.detail).toMatch(/\d+ hot rows omitted to stay within the 100-line cap/);
			expect(check.fix).toMatch(/unmark \d+ rows with entity_update or person_update \(\{ hot: false \}\)/);
		});

		it("respects a custom maxLines cap", () => {
			const rows: HotTierRow[] = [
				makeRow("1", "people", "Alice"),
				makeRow("2", "people", "Bob"),
				makeRow("3", "term", "PSR"),
				makeRow("4", "term", "WIP"),
			];
			// With maxLines = 8, 4 rows + preamble + 2 headers will exceed
			const check = classifyHotTier(rows, 8);
			expect(check.status).toBe("warn");
			expect(check.detail).toContain("4 hot rows");
			expect(check.detail).toContain("omitted to stay within the 8-line cap");
		});

		it("is included in classifyTravel when hotRows is provided", () => {
			const rows: HotTierRow[] = [makeRow("1", "people", "Alice")];
			const checks = classifyTravel(manifest({}), [], null, rows);
			const c = find(checks, "hot tier line cap");
			expect(c).toBeDefined();
			expect(c?.status).toBe("ok");
			expect(c?.detail).toContain("1 hot row");
			expect(c?.detail).toContain("0 omitted");
		});

		it("is excluded from classifyTravel when hotRows is omitted (backward compatibility)", () => {
			const checks = classifyTravel(manifest({}), [], null);
			expect(find(checks, "hot tier line cap")).toBeUndefined();
		});
	});
});
