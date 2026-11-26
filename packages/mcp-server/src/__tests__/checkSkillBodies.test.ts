/**
 * Unit tests for the repo-skill body drift guard (#689).
 *
 * The script is plain CommonJS at the repo root (matches its siblings, e.g.
 * scripts/check-artifact-surface-writes.js), so it is loaded via createRequire.
 * Every test but the last two drives the pure core with synthetic inputs.
 *
 * Four load-bearing pins:
 *   1. The guard's hash MUST equal skill-sync's canonical hash. They are
 *      separate implementations — one CommonJS with no build step, one TypeScript
 *      — and if they ever disagree, every skill reads as drifted forever (or,
 *      worse, real drift reads as clean).
 *   2. The guard's BODY ASSEMBLY must equal skill-sync's, for the same reason
 *      (#697): the receipt hashes the assembled body, so two bundlers that
 *      disagree by one byte make every multi-file skill read as drifted.
 *   3. An edited SKILL.md — or an edited travelling supporting file — with an
 *      unchanged receipt must FAIL. That is the whole reason the guard exists; a
 *      guard that cannot fail reports success for behaviour it never checked.
 *   4. The REAL committed tree and manifest must pass — the same bar CI runs.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { hashBody as canonicalHashBody } from "../skill-sync/hash.js";
import { assembleSkillBody as canonicalAssemble, unterminatedOpener as canonicalUnterminatedOpener } from "../skill-sync/skillBody.js";

const require = createRequire(import.meta.url);
const {
	hashBody,
	assembleSkillBody,
	unterminatedOpener: guardUnterminatedOpener,
	analyze,
	buildResult,
	formatReport,
	readManifest,
	readSkillsTree,
	MANIFEST_PATH,
	SKILLS_DIR,
} = require("../../../../scripts/check-skill-bodies.js");

const BODY = "---\nname: dos-hl\n---\n\nDraft and stop.\n";
const HASH = canonicalHashBody(BODY);
const REFERENCE = "# reference\n\n- `Bug`\n";

type TreeSkill = { name: string; skillMd: string; supportingFiles: string[]; fileContents: Record<string, Buffer> };

const skill = (name = "dos-hl", files: Record<string, string> = {}): TreeSkill => ({
	name,
	skillMd: BODY,
	supportingFiles: Object.keys(files).sort(),
	fileContents: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content, "utf8")])),
});

/** `supporting_files` entry — a path plus its reviewed travel decision (#697). */
const decl = (path: string, travels: boolean) => ({ path, travels, why: "reviewed in the test" });

/** The receipt a skill carrying these files would need. */
const receiptFor = (files: Record<string, string>) => {
	const result = canonicalAssemble(
		BODY,
		Object.entries(files).map(([path, content]) => ({ path, content })),
	);
	if (!result.ok) throw new Error(result.reason);
	return result.hash;
};

const enrolled = (overrides: Record<string, unknown> = {}) => ({
	register: true,
	why: "portable ritual",
	surface: ["claude-code", "cowork", "chat"],
	supporting_files: [],
	body_sha256: HASH,
	registered_at: "2026-08-21T12:00:00.000Z",
	...overrides,
});

const manifest = (skills: Record<string, unknown>) => ({ version: 1, skills });

const kinds = (result: { violations: { kind: string }[] }) => result.violations.map((violation) => violation.kind);

describe("hash parity with skill-sync", () => {
	it.each([
		["a plain body", "hello\n"],
		["CRLF line endings", "a\r\nb\r\n"],
		["trailing whitespace and blank lines", "a   \nb\t\n\n\n"],
		["an empty file", ""],
		["a real-shaped SKILL.md", BODY],
	])("agrees with hash.ts on %s", (_label, text) => {
		expect(hashBody(text)).toBe(canonicalHashBody(text));
	});
});

// #697: the receipt hashes the ASSEMBLED body, so the two bundlers must produce
// identical bytes. A one-character divergence in the preamble would make every
// multi-file skill read as permanently drifted.
describe("bundle parity with skill-sync", () => {
	const assembleBoth = (skillMd: string, carried: { path: string; content: string }[], siblings: string[] = []) => ({
		guard: assembleSkillBody(skillMd, carried, siblings),
		canonical: canonicalAssemble(skillMd, carried, siblings),
	});

	it.each([
		["nothing carried — the identity case", [] as { path: string; content: string }[], [] as string[]],
		["one carried file", [{ path: "references/REFERENCE.md", content: REFERENCE }], []],
		[
			"several carried files, given out of order, all travelling (no siblings)",
			[
				{ path: "b/second.md", content: "two\n" },
				{ path: "a/first.md", content: "one\n" },
			],
			[],
		],
		["content containing a fence", [{ path: "r.md", content: "```json\n{}\n```\n" }], []],
		["content with CRLF and trailing whitespace", [{ path: "r.md", content: "one\r\ntwo   \r\n\r\n" }], []],
		// #728: the new surface this PR adds — a mixed skill carrying one file while
		// naming another as a reviewed, non-travelling sibling in the appendix's
		// "present but not carried" block. This is the exact case the round-1 review
		// flagged as unpinned: both bundlers' hand-copied prose for that block must
		// stay byte-identical, not just agree by manual inspection.
		[
			"one carried file plus a non-travelling sibling (mixed carried+siblings)",
			[{ path: "references/REFERENCE.md", content: REFERENCE }],
			["references/example.json"],
		],
	])("agrees with skillBody.ts on %s", (_label, carried, siblings) => {
		const { guard, canonical } = assembleBoth(BODY, carried, siblings);
		expect(guard.ok).toBe(true);
		expect(canonical.ok).toBe(true);
		if (!guard.ok || !canonical.ok) return;
		expect(guard.body).toBe(canonical.body);
		expect(guard.hash).toBe(canonical.hash);
	});

	it("agrees on the size budget, so neither side accepts a body the other refuses", () => {
		const huge = [{ path: "big.md", content: "x".repeat(300 * 1024) }];
		const { guard, canonical } = assembleBoth(BODY, huge);
		expect(guard.ok).toBe(false);
		expect(canonical.ok).toBe(false);
	});

	// The unterminated-opener refusal is a second place the two bundlers must
	// agree: one side refusing a skill the other assembles would be a red CI on a
	// body the live push happily registers, or the reverse.
	it.each([
		["a backtick fence", "---\nname: x\n---\n\n```json\n{}\n"],
		["a tilde fence", "---\nname: x\n---\n\n~~~\nexample\n"],
		["an HTML comment", "---\nname: x\n---\n\n<!-- note\n"],
		["balanced markdown", "---\nname: x\n---\n\n```json\n{}\n```\n"],
		["an inline code span at line start", "---\nname: x\n---\n\n``` `x` ``` is a span\n"],
	])("agrees with skillBody.ts on whether SKILL.md ends inside %s", (_label, skillMd) => {
		expect(guardUnterminatedOpener(skillMd)).toBe(canonicalUnterminatedOpener(skillMd));

		const carried = [{ path: "references/REFERENCE.md", content: REFERENCE }];
		const { guard, canonical } = assembleBoth(skillMd, carried);
		expect(guard.ok).toBe(canonical.ok);
		if (!guard.ok && !canonical.ok) expect(guard.reason).toBe(canonical.reason);
	});
});

describe("analyze", () => {
	it("passes a clean, fully registered manifest", () => {
		const result = buildResult(manifest({ "dos-hl": enrolled() }), [skill()]);
		expect(result.ok).toBe(true);
		expect(result.pending).toEqual([]);
		expect(result.enrolled).toBe(1);
	});

	it("FAILS when SKILL.md changed but the receipt did not — the rot the guard exists for", () => {
		const result = buildResult(manifest({ "dos-hl": enrolled({ body_sha256: canonicalHashBody("last month\n") }) }), [skill()]);
		expect(result.ok).toBe(false);
		expect(kinds(result)).toEqual(["body-drift"]);
		expect(result.violations[0].detail).toContain(HASH);
	});

	it("FAILS when a skill grows a supporting file it never affirmed", () => {
		const result = buildResult(manifest({ "dos-hl": enrolled() }), [skill("dos-hl", { "references/new.md": "x\n" })]);
		expect(kinds(result)).toEqual(["supporting-files-changed"]);
	});

	it("FAILS on a skill directory the manifest never declares, surfacing the Two-Bucket check", () => {
		const result = buildResult(manifest({}), [skill("newcomer")]);
		expect(kinds(result)).toEqual(["undeclared-skill"]);
		expect(result.violations[0].detail).toContain("Two-Bucket check");
		expect(result.violations[0].detail).toContain("Bucket 2");
		expect(formatReport(result).join("\n")).toContain('capability_get({ name: "writing-for-agents" })');
	});

	it("FAILS on a manifest entry whose skill directory is gone", () => {
		const result = buildResult(manifest({ ghost: enrolled() }), []);
		expect(kinds(result)).toEqual(["stale-entry"]);
	});

	it("FAILS on an unknown key rather than letting the live push silently drop it", () => {
		const result = buildResult(manifest({ "dos-hl": enrolled({ note: "keep me" }) }), [skill()]);
		expect(kinds(result)).toEqual(["malformed-entry"]);
		expect(result.violations[0].detail).toContain("note");
	});

	it.each([
		["a missing why", { register: true }],
		["an empty surface", enrolled({ surface: [] })],
		["a missing hash", { register: true, why: "w", surface: ["chat"], supporting_files: [] }],
	])("FAILS on %s", (_label, entry) => {
		expect(buildResult(manifest({ "dos-hl": entry }), [skill()]).ok).toBe(false);
	});

	it("accepts register: false with a why, and never compares its body", () => {
		const result = buildResult(manifest({ dogfood: { register: false, why: "forked against the home tree" } }), [
			skill("dogfood", { "whatever.md": "anything\n" }),
		]);
		expect(result.ok).toBe(true);
		expect(result.enrolled).toBe(0);
	});

	it("reports a null registered_at as pending — visible debt, not a violation", () => {
		const result = buildResult(manifest({ "dos-hl": enrolled({ registered_at: null }) }), [skill()]);
		expect(result.ok).toBe(true);
		expect(result.pending).toEqual(["dos-hl"]);
		expect(formatReport(result).join("\n")).toContain("PENDING REGISTRATION");
	});

	it("warns rather than failing when body drifts while registered_at is null (#706)", () => {
		const driftedBody = "---\nname: dos-hl\n---\n\nChanged content.\n";
		const editedSkill: TreeSkill = {
			name: "dos-hl",
			skillMd: driftedBody,
			supportingFiles: [],
			fileContents: {},
		};
		const result = buildResult(manifest({ "dos-hl": enrolled({ registered_at: null }) }), [editedSkill]);
		expect(result.ok).toBe(true);
		expect(result.violations).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].kind).toBe("unregistered-body-drift");
		expect(result.pending).toEqual(["dos-hl"]);
		expect(formatReport(result).join("\n")).toContain("WARNING: 1 unregistered skill body drift(s)");
	});

	it("FAILS when body drifts while registered_at is set (#706)", () => {
		const driftedBody = "---\nname: dos-hl\n---\n\nChanged content.\n";
		const editedSkill: TreeSkill = {
			name: "dos-hl",
			skillMd: driftedBody,
			supportingFiles: [],
			fileContents: {},
		};
		const result = buildResult(manifest({ "dos-hl": enrolled({ registered_at: "2026-08-21T12:00:00.000Z" }) }), [editedSkill]);
		expect(result.ok).toBe(false);
		expect(kinds(result)).toEqual(["body-drift"]);
	});

	it("reports an unreadable manifest rather than passing with nothing to check", () => {
		expect(kinds(buildResult(null, [skill()]))).toEqual(["manifest-unreadable"]);
		expect(kinds(buildResult({ version: 2, skills: {} }, []))).toEqual(["manifest-unreadable"]);
	});

	it("collects every undeclared skill rather than stopping at the first", () => {
		const result = buildResult(manifest({}), [skill("a"), skill("b")]);
		expect(result.violations).toHaveLength(2);
	});
});

// #697. The guard's whole new job: a travelling supporting file is part of the
// body, so editing it must red the build exactly as editing SKILL.md does.
describe("analyze with travelling supporting files", () => {
	const files = { "references/REFERENCE.md": REFERENCE };
	const travelling = (overrides: Record<string, unknown> = {}) =>
		enrolled({ supporting_files: [decl("references/REFERENCE.md", true)], body_sha256: receiptFor(files), ...overrides });

	it("passes when the receipt matches the assembled body", () => {
		expect(buildResult(manifest({ "dos-infra": travelling() }), [skill("dos-infra", files)]).ok).toBe(true);
	});

	it("FAILS when the travelling file changed but the receipt did not — caught as body-drift, like SKILL.md", () => {
		const edited = skill("dos-infra", { "references/REFERENCE.md": `${REFERENCE}- \`New type\`\n` });
		const result = buildResult(manifest({ "dos-infra": travelling() }), [edited]);

		expect(kinds(result)).toEqual(["body-drift"]);
		expect(result.violations[0].detail).toContain("references/REFERENCE.md");
	});

	it("does NOT change the receipt when a NON-travelling file changes — it is not part of the body", () => {
		const entry = enrolled({ supporting_files: [decl("references/example.json", false)] });
		const edited = skill("dos-hl", { "references/example.json": '{"changed": true}\n' });
		expect(buildResult(manifest({ "dos-hl": entry }), [edited]).ok).toBe(true);
	});

	it("FAILS by name when a travelling file is not text, rather than carrying mojibake", () => {
		const binary = {
			name: "dos-infra",
			skillMd: BODY,
			supportingFiles: ["logo.png"],
			fileContents: { "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]) },
		};
		const result = buildResult(manifest({ "dos-infra": enrolled({ supporting_files: [decl("logo.png", true)] }) }), [binary]);

		expect(kinds(result)).toEqual(["body-unbuildable"]);
		expect(result.violations[0].skill).toBe("dos-infra");
		expect(result.violations[0].detail).toContain("logo.png");
	});

	it("FAILS by name, never truncating, when the assembled body is over the size budget", () => {
		const huge = skill("dos-infra", { "big.md": "x".repeat(300 * 1024) });
		const result = buildResult(manifest({ "dos-infra": enrolled({ supporting_files: [decl("big.md", true)] }) }), [huge]);

		expect(kinds(result)).toEqual(["body-unbuildable"]);
		expect(result.violations[0].detail).toContain("never truncated");
	});

	it("FAILS on the pre-#697 bare-path shape rather than guessing whether it travels", () => {
		const legacy = enrolled({ supporting_files: ["references/REFERENCE.md"] });
		const result = buildResult(manifest({ "dos-infra": legacy }), [skill("dos-infra", files)]);

		expect(kinds(result)).toEqual(["malformed-entry"]);
		expect(result.violations[0].detail).toContain("bare paths are no longer accepted");
	});

	it.each([
		["a missing travels flag", { path: "references/REFERENCE.md", why: "w" }],
		["a missing why", { path: "references/REFERENCE.md", travels: true }],
		["an unknown key", { path: "references/REFERENCE.md", travels: true, why: "w", note: "keep me" }],
	])("FAILS on %s in supporting_files", (_label, file) => {
		const result = buildResult(manifest({ "dos-infra": enrolled({ supporting_files: [file] }) }), [skill("dos-infra", files)]);
		expect(kinds(result)).toEqual(["malformed-entry"]);
	});
});

describe("the committed tree", () => {
	it("declares every skill under .claude/skills/ and matches every receipt", () => {
		const result = buildResult(readManifest(MANIFEST_PATH), readSkillsTree(SKILLS_DIR));
		expect(formatReport(result).join("\n")).toContain("OK:");
		expect(result.ok).toBe(true);
	});

	// The acceptance criterion of #689, carried by the ritual that replaced dos-hl
	// (ADR-054 §7): the body served cross-surface is the exact SKILL.md on disk.
	it("enrols dos for a cross-surface kms-db body", () => {
		const entry = readManifest(MANIFEST_PATH).skills["dos"];
		expect(entry.register).toBe(true);
		expect(entry.surface).toEqual(expect.arrayContaining(["claude-code", "cowork", "chat"]));
		// dos carries nothing (its one supporting file is declared travels: false),
		// so its body is SKILL.md verbatim.
		expect(entry.supporting_files).toContainEqual(
			expect.objectContaining({ path: "references/notion-integration.example.json", travels: false }),
		);
		const onDisk = readSkillsTree(SKILLS_DIR).find((s: TreeSkill) => s.name === "dos");
		expect(entry.body_sha256).toBe(canonicalHashBody(onDisk.skillMd));
	});

	// ADR-054 §7 / ADR-050 §1: one ritual per name. The three the unified ritual
	// replaced are gone from the tree AND the manifest, so no surface can resolve
	// a retired body by name from this repo.
	it.each(["dos-hl", "dos-infra", "dos-personal"])("no longer enrols %s", (name) => {
		expect(readManifest(MANIFEST_PATH).skills[name]).toBeUndefined();
		expect(readSkillsTree(SKILLS_DIR).find((s: TreeSkill) => s.name === name)).toBeUndefined();
	});
});
