import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AhkmsCapability } from "./ahkmsSource.js";
import { hashBody } from "./hash.js";
import type { LocalSkill } from "./localSkills.js";
import { resolveMultiFileBody } from "./push.js";
import { computeStatus, formatStatus, type SkillStatus, statusForSkill } from "./status.js";

// computeStatus is the orchestrator: it wires the real fs seam (listLocalSkills +
// readSyncState over a tmpdir tree) to the ahkms read side. Only that network edge
// is stubbed — fetchAllCapabilities is partially mocked so no credentials/network
// are needed; everything else runs for real. statusForSkill/formatStatus below
// stay pure (plain objects), so the mock never touches them.
const fetchAllCapabilities = vi.fn<() => Promise<Map<string, AhkmsCapability>>>();
vi.mock("./ahkmsSource.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ahkmsSource.js")>();
	return { ...actual, fetchAllCapabilities: () => fetchAllCapabilities() };
});

// statusForSkill is the pure classifier (no fs/network/env), so these cases run
// with plain objects — no supabase mock needed.

function local(name: string, over: Partial<LocalSkill> = {}): LocalSkill {
	return {
		name,
		dir: `/home/${name}`,
		realDir: `/home/${name}`,
		isSymlink: false,
		tier: "single",
		fileCount: 1,
		skillMd: "body\n",
		...over,
	};
}
function cap(over: Partial<AhkmsCapability> = {}): AhkmsCapability {
	return {
		name: "x",
		kind: "skill",
		storageLocation: "kms-db",
		storageUrl: null,
		surface: ["claude-code"],
		body: null,
		bodySyncedAt: null,
		...over,
	};
}

describe("statusForSkill", () => {
	it("labels an agent-backed skill-dir as other-kind, not local-only (#381)", () => {
		const s = statusForSkill(local("archiver"), cap({ name: "archiver", kind: "agent" }), null);
		expect(s.status).toBe("other-kind");
		expect(s.detail).toContain("registered as agent");
	});

	it("treats a same-named command capability the same way", () => {
		const s = statusForSkill(local("triage"), cap({ name: "triage", kind: "command" }), null);
		expect(s.status).toBe("other-kind");
		expect(s.detail).toContain("registered as command");
	});

	it("still reports a genuinely unregistered local skill as local-only", () => {
		const s = statusForSkill(local("orphan"), undefined, null);
		expect(s.status).toBe("local-only");
		expect(s.detail).toBeUndefined();
	});

	it("runs the reconcile classifier for a same-named skill capability", () => {
		const body = "shared\n";
		const s = statusForSkill(local("qa", { skillMd: body }), cap({ name: "qa", kind: "skill", body }), hashBody(body));
		expect(s.status).toBe("in-sync");
	});

	it("keeps the symlink compare-only note alongside the agent-backed label", () => {
		const s = statusForSkill(local("ui-ux", { isSymlink: true }), cap({ name: "ui-ux", kind: "agent" }), null);
		expect(s.detail).toContain("compare-only (symlink)");
		expect(s.detail).toContain("registered as agent");
	});

	it("reports a multi-file skill as multi-file regardless of any same-named cap", () => {
		const s = statusForSkill(local("big", { tier: "multi", fileCount: 3 }), cap({ kind: "agent" }), null);
		expect(s.status).toBe("multi-file");
	});
});

// Round 1 QA High finding: statusForSkill used to classify EVERY tier==="multi"
// skill into the blanket "multi-file" bucket, even once push.ts started pushing
// manifest-declared ones to kms-db — making drift on those skills undetectable.
// These need real files on disk (resolveMultiFileBody reads the manifest and the
// declared supporting file), so they get their own tmpdir, unlike the fixture-only
// cases above.
describe("statusForSkill (manifest-declared multi-file — #758)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "skill-status-multi-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeBundle(skillMdBody: string, supportingBody: string): LocalSkill {
		writeFileSync(join(dir, "SKILL.md"), skillMdBody, "utf8");
		writeFileSync(join(dir, "extra.md"), supportingBody, "utf8");
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({ supporting_files: [{ path: "extra.md", travels: true }] }),
			"utf8",
		);
		return { name: "bundle", dir, realDir: dir, isSymlink: false, tier: "multi", fileCount: 3, skillMd: skillMdBody };
	}

	it("runs the reconcile classifier against the ASSEMBLED body instead of the blanket bucket", () => {
		const skill = writeBundle("---\nname: bundle\n---\nmain\n", "extra\n");
		const resolved = resolveMultiFileBody(skill);
		if (!resolved.ok) throw new Error(`expected assembly to succeed: ${resolved.reason}`);

		const s = statusForSkill(skill, cap({ name: "bundle", kind: "skill", body: resolved.body }), hashBody(resolved.body));

		expect(s.tier).toBe("multi");
		expect(s.status).toBe("in-sync");
	});

	it("flags ahkms-moved when the pushed kms-db body diverges from the assembled local body", () => {
		const skill = writeBundle("---\nname: bundle\n---\nmain\n", "extra\n");
		const resolved = resolveMultiFileBody(skill);
		if (!resolved.ok) throw new Error(`expected assembly to succeed: ${resolved.reason}`);

		const s = statusForSkill(skill, cap({ name: "bundle", kind: "skill", body: "some other assembled body\n" }), hashBody(resolved.body));

		expect(s.status).toBe("ahkms-moved");
	});

	it("stays in the blanket multi-file bucket when no manifest is declared (unchanged)", () => {
		writeFileSync(join(dir, "SKILL.md"), "no manifest here\n", "utf8");
		writeFileSync(join(dir, "extra.md"), "extra\n", "utf8");
		const skill: LocalSkill = {
			name: "bundle",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 2,
			skillMd: "no manifest here\n",
		};

		const s = statusForSkill(skill, cap({ kind: "agent" }), null);
		expect(s.status).toBe("multi-file");
		expect(s.detail).toBeUndefined();
	});
});

describe("formatStatus", () => {
	it("files agent-backed dirs under their own label, not 'unregistered' (#381)", () => {
		const skills: SkillStatus[] = [
			{ name: "archiver", tier: "single", isSymlink: false, status: "other-kind", detail: "registered as agent" },
			{ name: "orphan", tier: "single", isSymlink: false, status: "local-only" },
		];
		const out = formatStatus({ skillsHome: "/home", skills });

		// archiver renders under the agent/command bucket...
		expect(out).toMatch(/registered as agent\/command \(not a skill\) \(1\):\n {2}• archiver/);
		// ...and the unregistered bucket holds only the genuine orphan (count proves it).
		expect(out).toMatch(/local only \(unregistered\) \(1\):\n {2}• orphan/);
	});
});

describe("computeStatus (fs + ahkms orchestration)", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "skill-status-"));
		fetchAllCapabilities.mockReset();
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** Write a single-file skill directory under home. */
	function writeSkill(name: string, body: string): void {
		const dir = join(home, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	}
	/** Record a merge base in the tmpdir's .sync-state.json. */
	function writeBase(bases: Record<string, string>): void {
		const skills: Record<string, { hash: string; syncedAt: string }> = {};
		for (const [name, hash] of Object.entries(bases)) skills[name] = { hash, syncedAt: "2026-07-15T00:00:00Z" };
		writeFileSync(join(home, ".sync-state.json"), JSON.stringify({ version: 1, skills }), "utf8");
	}
	function caps(list: AhkmsCapability[]): Map<string, AhkmsCapability> {
		return new Map(list.map((c) => [c.name.toLowerCase(), c]));
	}
	function statusOf(report: Awaited<ReturnType<typeof computeStatus>>, name: string): string | undefined {
		return report.skills.find((s) => s.name === name)?.status;
	}

	it("carries the tmpdir path through as skillsHome", async () => {
		fetchAllCapabilities.mockResolvedValue(caps([]));
		const report = await computeStatus(home);
		expect(report.skillsHome).toBe(home);
		expect(report.skills).toEqual([]);
	});

	it("reports a single-file skill with no matching cap as local-only", async () => {
		writeSkill("orphan", "body\n");
		fetchAllCapabilities.mockResolvedValue(caps([]));
		const report = await computeStatus(home);
		expect(statusOf(report, "orphan")).toBe("local-only");
	});

	it("reports in-sync when local body, ahkms body, and base all agree", async () => {
		const body = "shared\n";
		writeSkill("qa", body);
		writeBase({ qa: hashBody(body) });
		fetchAllCapabilities.mockResolvedValue(caps([cap({ name: "qa", kind: "skill", body })]));
		const report = await computeStatus(home);
		expect(statusOf(report, "qa")).toBe("in-sync");
	});

	it("reports ahkms-moved when only the ahkms body diverged from the base", async () => {
		const localBody = "old\n";
		writeSkill("drift", localBody);
		writeBase({ drift: hashBody(localBody) });
		fetchAllCapabilities.mockResolvedValue(caps([cap({ name: "drift", kind: "skill", body: "new\n" })]));
		const report = await computeStatus(home);
		expect(statusOf(report, "drift")).toBe("ahkms-moved");
	});

	it("reports conflict when local and ahkms both diverged differently with a base", async () => {
		writeSkill("both", "local-change\n");
		writeBase({ both: hashBody("base\n") });
		fetchAllCapabilities.mockResolvedValue(caps([cap({ name: "both", kind: "skill", body: "ahkms-change\n" })]));
		const report = await computeStatus(home);
		expect(statusOf(report, "both")).toBe("conflict");
	});

	it("matches caps case-insensitively against the local dir name", async () => {
		const body = "same\n";
		writeSkill("MixedCase", body);
		writeBase({ MixedCase: hashBody(body) });
		fetchAllCapabilities.mockResolvedValue(caps([cap({ name: "mixedcase", kind: "skill", body })]));
		const report = await computeStatus(home);
		expect(statusOf(report, "MixedCase")).toBe("in-sync");
	});

	it("labels an agent-backed name other-kind and a multi-file dir multi-file", async () => {
		writeSkill("agentish", "x\n");
		const multiDir = join(home, "bundle");
		mkdirSync(multiDir, { recursive: true });
		writeFileSync(join(multiDir, "SKILL.md"), "y\n", "utf8");
		writeFileSync(join(multiDir, "extra.md"), "z\n", "utf8");
		fetchAllCapabilities.mockResolvedValue(caps([cap({ name: "agentish", kind: "agent" })]));
		const report = await computeStatus(home);
		expect(statusOf(report, "agentish")).toBe("other-kind");
		expect(statusOf(report, "bundle")).toBe("multi-file");
	});
});
