import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ManifestError,
	type RepoSkillManifest,
	declaredPaths,
	enrolledSkills,
	parseManifest,
	serialiseManifest,
	travellingPaths,
} from "./repoManifest.js";

// The manifest is the committed registration receipt (#689), so its reader has
// to be strict: a field it quietly ignores is a field the live push silently
// drops the first time it re-serialises the file.

const ENROLLED = {
	version: 1,
	skills: {
		"dos-hl": {
			register: true,
			why: "the skill #689 is about",
			surface: ["claude-code", "cowork", "chat"],
			supporting_files: [{ path: "references/notion.example.json", travels: false, why: "an example config shape, never a step" }],
			body_sha256: "abc123",
			registered_at: null,
		},
	},
};

describe("parseManifest", () => {
	it("parses an enrolled entry, defaulting a missing registered_at to null", () => {
		const manifest = parseManifest(JSON.stringify(ENROLLED));
		expect(manifest.skills["dos-hl"]).toEqual({
			register: true,
			why: "the skill #689 is about",
			surface: ["claude-code", "cowork", "chat"],
			supporting_files: [{ path: "references/notion.example.json", travels: false, why: "an example config shape, never a step" }],
			body_sha256: "abc123",
			registered_at: null,
		});
	});

	it("parses a not-enrolled entry as register + why only", () => {
		const manifest = parseManifest(JSON.stringify({ version: 1, skills: { dogfood: { register: false, why: "forked" } } }));
		expect(manifest.skills.dogfood).toEqual({ register: false, why: "forked" });
	});

	it("rejects an unknown key rather than dropping it on the next write", () => {
		const withExtra = { version: 1, skills: { "dos-hl": { ...ENROLLED.skills["dos-hl"], note: "keep me" } } };
		expect(() => parseManifest(JSON.stringify(withExtra))).toThrow(/unknown key\(s\) note/);
	});

	it("rejects surface on a not-enrolled entry (it has no meaning there)", () => {
		const bad = { version: 1, skills: { dogfood: { register: false, why: "forked", surface: ["chat"] } } };
		expect(() => parseManifest(JSON.stringify(bad))).toThrow(/unknown key\(s\) surface/);
	});

	it.each([
		["a missing why", { version: 1, skills: { x: { register: false } } }, /`why` must be a non-empty string/],
		["an empty why", { version: 1, skills: { x: { register: false, why: "  " } } }, /`why` must be a non-empty string/],
		["a non-boolean register", { version: 1, skills: { x: { register: "yes", why: "w" } } }, /`register` must be a boolean/],
		[
			"an enrolled entry with no hash",
			{ version: 1, skills: { x: { register: true, why: "w", surface: ["chat"], supporting_files: [] } } },
			/`body_sha256` must be a hash string/,
		],
		[
			"an enrolled entry with an empty surface",
			{ version: 1, skills: { x: { register: true, why: "w", surface: [], supporting_files: [], body_sha256: "h" } } },
			/`surface` must be a non-empty string array/,
		],
		["a wrong version", { version: 2, skills: {} }, /unsupported version/],
		["no skills map", { version: 1 }, /missing `skills` object/],
	])("rejects %s", (_label, value, pattern) => {
		expect(() => parseManifest(JSON.stringify(value))).toThrow(pattern as RegExp);
	});

	// #697. `supporting_files` went from a bare path list to a per-file travel
	// decision. Both shapes must never be accepted at once: the default the reader
	// would have to pick for `travels` is exactly the decision this file records.
	describe("supporting_files travel decisions", () => {
		const withFiles = (files: unknown[]) => ({
			version: 1,
			skills: { x: { register: true, why: "w", surface: ["chat"], supporting_files: files, body_sha256: "h" } },
		});

		it("rejects the pre-#697 bare path, naming the shape it should have", () => {
			expect(() => parseManifest(JSON.stringify(withFiles(["references/REFERENCE.md"])))).toThrow(/bare paths are no longer accepted/);
		});

		it.each([
			["a missing travels flag", { path: "r.md", why: "w" }, /`travels` must be a boolean/],
			["a missing why", { path: "r.md", travels: true }, /`why` must explain the travel decision/],
			["an empty path", { path: "  ", travels: true, why: "w" }, /`path` must be a non-empty string/],
			["an unknown key", { path: "r.md", travels: true, why: "w", note: "x" }, /unknown key\(s\) note/],
		])("rejects %s", (_label, file, pattern) => {
			expect(() => parseManifest(JSON.stringify(withFiles([file])))).toThrow(pattern as RegExp);
		});

		it("splits the declared inventory from the travelling subset", () => {
			const entry = parseManifest(
				JSON.stringify(
					withFiles([
						{ path: "z/travels.md", travels: true, why: "step 1 reads it" },
						{ path: "a/stays.json", travels: false, why: "an example, never a step" },
					]),
				),
			).skills.x;

			expect(declaredPaths(entry)).toEqual(["a/stays.json", "z/travels.md"]);
			expect(travellingPaths(entry)).toEqual(["z/travels.md"]);
		});
	});

	it("reports invalid JSON as a ManifestError, not a raw SyntaxError", () => {
		expect(() => parseManifest("{not json")).toThrow(ManifestError);
	});
});

describe("serialiseManifest", () => {
	it("round-trips without loss and sorts skills by name", () => {
		const manifest: RepoSkillManifest = {
			version: 1,
			skills: {
				route: { register: false, why: "b" },
				afk: { register: false, why: "a" },
			},
		};
		const text = serialiseManifest(manifest);
		expect(Object.keys(parseManifest(text).skills)).toEqual(["afk", "route"]);
		expect(text.endsWith("\n")).toBe(true);
		expect(text).toContain("\t");
	});
});

describe("enrolledSkills", () => {
	it("returns only register: true entries, in name order", () => {
		const manifest = parseManifest(
			JSON.stringify({
				version: 1,
				skills: {
					route: { register: true, why: "w", surface: ["chat"], supporting_files: [], body_sha256: "h" },
					dogfood: { register: false, why: "forked" },
					afk: { register: true, why: "w", surface: ["chat"], supporting_files: [], body_sha256: "h" },
				},
			}),
		);
		expect(enrolledSkills(manifest).map((entry) => entry.name)).toEqual(["afk", "route"]);
	});
});

// #713: `repo push` used to reformat the whole file on every write, because the
// committed copy carried compact arrays while the writer expands them one element per
// line. An eight-line semantic change came out as a 45-insertion / 19-deletion diff,
// and the guard's own credential-free recovery ("edit body_sha256 by hand") produced
// the compact form again, so the formatting flip-flopped depending on who wrote last.
//
// Asserting the writer reproduces the committed bytes exactly is the durable form of
// the fix: it holds whichever style the file is in, and it fails the moment the two
// diverge again, rather than the divergence being discovered as diff noise in review.
describe("the committed manifest round-trips through the writer (#713)", () => {
	// `import.meta.url` rather than `__dirname`: this package is ESM, and the CJS
	// global is not in the eslint node globals, so it fails `no-undef` even though
	// tsc and the vitest runtime both tolerate it (round-1 QA on #959).
	const here = dirname(fileURLToPath(import.meta.url));
	const manifestPath = join(here, "..", "..", "..", "..", ".claude", "skill-registry.json");

	it("serialises the real committed file back to itself, byte for byte", () => {
		const onDisk = readFileSync(manifestPath, "utf8");
		expect(serialiseManifest(parseManifest(onDisk))).toBe(onDisk);
	});

	// The property the byte comparison rests on. Without this a future writer change
	// could satisfy the test above by being wrong in both directions at once.
	it("is idempotent: serialising twice changes nothing", () => {
		const once = serialiseManifest(parseManifest(readFileSync(manifestPath, "utf8")));
		expect(serialiseManifest(parseManifest(once))).toBe(once);
	});
});
