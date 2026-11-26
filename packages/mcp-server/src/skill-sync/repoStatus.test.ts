import { describe, expect, it } from "vitest";
import type { AhkmsCapability } from "./ahkmsSource.js";
import { hashBody } from "./hash.js";
import type { RepoSkillEntry } from "./repoManifest.js";
import type { RepoSkill } from "./repoSkills.js";
import { statusForRepoSkill } from "./repoStatus.js";
import { type SkillBodyResult, assembleSkillBody } from "./skillBody.js";

// The live half of the #689 guard: only a credentialed read can tell whether the
// registry actually serves the bytes this repo committed. `no-body` is the exact
// state dos-hl was in on 2026-08-21, and `registry-stale` is the rot the issue
// warns is "worse than a pointer, because it looks authoritative".
//
// `body-unbuildable` is #697's addition: a skill whose declared travelling files
// cannot be assembled cannot travel at all, and must be reported by name rather
// than quietly compared against whatever the registry happens to hold.

const BODY = "---\nname: dos-hl\n---\nDraft and stop.\n";
const RESOLVED = assembleSkillBody(BODY, []) as Extract<SkillBodyResult, { ok: true }>;

const skill = (overrides: Partial<RepoSkill> = {}): RepoSkill => ({
	name: "dos-hl",
	dir: "/repo/.claude/skills/dos-hl",
	skillMd: BODY,
	description: null,
	skillMdHash: hashBody(BODY),
	supportingFiles: [],
	...overrides,
});

const entry = (overrides: Partial<RepoSkillEntry> = {}): RepoSkillEntry => ({
	register: true,
	why: "portable ritual",
	surface: ["claude-code", "cowork", "chat"],
	supporting_files: [],
	body_sha256: hashBody(BODY),
	registered_at: "2026-08-21T12:00:00.000Z",
	...overrides,
});

const cap = (overrides: Partial<AhkmsCapability> = {}): AhkmsCapability => ({
	name: "dos-hl",
	kind: "skill",
	storageLocation: "kms-db",
	storageUrl: null,
	surface: ["claude-code", "cowork", "chat"],
	body: BODY,
	bodySyncedAt: "2026-08-21T12:00:00.000Z",
	...overrides,
});

describe("statusForRepoSkill", () => {
	it("is in-sync when the registry body hashes equal to the body this repo would serve", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap(), RESOLVED);
		expect(result).toEqual({ name: "dos-hl", status: "in-sync", detail: undefined });
	});

	it("does not flag drift for a row migration 114 rewrote (cowork -> claude-synced, chat -> clients)", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap({ surface: ["claude-code", "claude-synced"] }), RESOLVED);
		expect(result).toEqual({ name: "dos-hl", status: "in-sync", detail: undefined });
	});

	it("still reports in-sync but flags a surface list that has diverged from the manifest", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap({ surface: ["claude-code"] }), RESOLVED);
		expect(result.status).toBe("in-sync");
		expect(result.detail).toMatch(/surface differs \(registry: claude-code\)/);
	});

	it("reports no-body for the exact state dos-hl was in — hosted, empty, description only", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap({ storageLocation: "kms-repo", body: null }), RESOLVED);
		expect(result.status).toBe("no-body");
		expect(result.detail).toContain("#689");
	});

	it("reports registry-stale when the registry serves different bytes", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap({ body: "last month's ritual\n" }), RESOLVED);
		expect(result.status).toBe("registry-stale");
		expect(result.detail).toContain("2026-08-21T12:00:00.000Z");
	});

	it("ignores whitespace-only differences, matching the canonical hash", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap({ body: BODY.replace(/\n$/, "   \n\n\n") }), RESOLVED);
		expect(result.status).toBe("in-sync");
	});

	it("reports unregistered when the name is absent from the registry", () => {
		expect(statusForRepoSkill("dos-hl", entry(), skill(), undefined, RESOLVED).status).toBe("unregistered");
	});

	it("reports other-kind rather than clobbering an agent or command of the same name", () => {
		const result = statusForRepoSkill("dos-hl", entry(), skill(), cap({ kind: "agent" }), RESOLVED);
		expect(result).toEqual({ name: "dos-hl", status: "other-kind", detail: "registered as agent" });
	});

	it("reports missing-file when the manifest names a skill the repo no longer has", () => {
		expect(statusForRepoSkill("gone", entry(), undefined, cap(), RESOLVED).status).toBe("missing-file");
	});

	it("never compares a not-enrolled skill, and surfaces its recorded reason instead", () => {
		const notEnrolled = { register: false, why: "forked against the home tree" };
		const result = statusForRepoSkill("dogfood", notEnrolled, skill(), undefined, undefined);
		expect(result).toEqual({ name: "dogfood", status: "not-enrolled", detail: "forked against the home tree" });
	});

	// #697. Without this branch a skill that cannot travel would fall through to
	// the registry comparison and report `registry-stale` — an actionable-looking
	// status whose suggested fix (re-push) cannot succeed.
	it("reports body-unbuildable by name when a declared travelling file cannot be carried", () => {
		const unbuildable = { ok: false as const, reason: "`references/REFERENCE.md` is not text (contains a NUL byte)" };
		const result = statusForRepoSkill("dos-infra", entry(), skill(), cap(), unbuildable);
		expect(result.status).toBe("body-unbuildable");
		expect(result.detail).toContain("references/REFERENCE.md");
	});

	it("compares against the bundled body, so a stale registry copy of SKILL.md alone is caught", () => {
		const bundled = assembleSkillBody(BODY, [{ path: "references/REFERENCE.md", content: "taxonomies\n" }]);
		const result = statusForRepoSkill("dos-infra", entry(), skill(), cap({ body: BODY }), bundled);
		expect(result.status).toBe("registry-stale");
		expect(result.detail).toContain("SKILL.md + references/REFERENCE.md");
	});
});
