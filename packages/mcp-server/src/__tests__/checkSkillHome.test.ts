import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { AhkmsCapability } from "../skill-sync/ahkmsSource.js";
import {
	buildSkillHomesCache,
	writeSkillHomesCache,
} from "../skill-sync/skillHomes.js";

const require = createRequire(import.meta.url);
const {
	STANZA_812,
	extractBashWriteTargets,
	normalizePath,
	extractSkillName,
	parseOwnerRepoFromStorageUrl,
	repoMatchesCachedHome,
	checkSkillPath,
	evaluateEdit,
} = require("../../../../.claude/hooks/check-skill-home.js");

const cap = (
	name: string,
	storageLocation: string,
	storageUrl: string | null = null,
): AhkmsCapability => ({
	name,
	kind: "skill",
	storageLocation,
	storageUrl,
	surface: ["claude-code"],
	body: null,
	bodySyncedAt: null,
});

describe("skillHomes cache writer (#811)", () => {
	it("builds a lowercase mapping of skill homes", () => {
		const caps = [
			cap("AFK", "kms-repo", ".claude/skills/afk/SKILL.md"),
			cap("Capture", "kms-db", null),
			cap("External-Tool", "claude", "https://example.com"),
		];
		const map = buildSkillHomesCache(caps);
		expect(map).toEqual({
			afk: { storage_location: "kms-repo", storage_url: ".claude/skills/afk/SKILL.md" },
			capture: { storage_location: "kms-db", storage_url: null },
			"external-tool": { storage_location: "claude", storage_url: "https://example.com" },
		});
	});

	it("writeSkillHomesCache writes JSON file to disk safely", () => {
		const tmpPath = require("node:path").join(require("node:os").tmpdir(), `test-cache-${Date.now()}.json`);
		const mockCaps = [cap("afk", "kms-repo", ".claude/skills/afk")];
		try {
			const res = writeSkillHomesCache(mockCaps, tmpPath);
			expect(res).toBe(true);
			expect(require("node:fs").existsSync(tmpPath)).toBe(true);
		} finally {
			try {
				require("node:fs").unlinkSync(tmpPath);
			} catch {
				// ignore
			}
		}
	});
});

describe("check-skill-home hook unit tests (#811)", () => {
	describe("path parsing and normalization", () => {
		it("normalizes ~ to homedir with forward slashes", () => {
			const res = normalizePath("~/.claude/skills/afk/SKILL.md", "/repo", "/home/user");
			expect(res).toBe("/home/user/.claude/skills/afk/SKILL.md");
		});

		it("normalizes relative path to absolute with forward slashes", () => {
			const expectedPrefix = process.platform === "win32" ? "C:" : "";
			const res = normalizePath(".claude/skills/afk/SKILL.md", `${expectedPrefix}/repo`, `${expectedPrefix}/home/user`);
			expect(res).toBe(`${expectedPrefix}/repo/.claude/skills/afk/SKILL.md`);
		});

		it("normalizes $HOME and ${HOME} to homedir with forward slashes (#1201)", () => {
			expect(normalizePath("$HOME/.claude/skills/afk/SKILL.md", "/repo", "/home/user")).toBe(
				"/home/user/.claude/skills/afk/SKILL.md",
			);
			expect(normalizePath("${HOME}/.claude/skills/afk/SKILL.md", "/repo", "/home/user")).toBe(
				"/home/user/.claude/skills/afk/SKILL.md",
			);
		});

		it("extracts skill name from .claude/skills paths", () => {
			expect(extractSkillName("/repo/.claude/skills/afk/SKILL.md")).toBe("afk");
			expect(extractSkillName("/home/user/.claude/skills/DOS-HL/companion.md")).toBe("dos-hl");
			expect(extractSkillName("/repo/packages/mcp-server/src/index.ts")).toBeNull();
		});
	});

	describe("extractBashWriteTargets", () => {
		it("detects output redirections targeting skills", () => {
			const cmd1 = "echo 'foo' > ~/.claude/skills/afk/SKILL.md";
			expect(extractBashWriteTargets(cmd1).length).toBeGreaterThan(0);

			const cmd2 = "cat << 'EOF' >> .claude/skills/dos-hl/SKILL.md\nsome text\nEOF";
			expect(extractBashWriteTargets(cmd2).length).toBeGreaterThan(0);
		});

		it("detects write utilities targeting skills", () => {
			expect(extractBashWriteTargets("cp /tmp/a .claude/skills/afk/SKILL.md")).toContain(".claude/skills/afk/SKILL.md");
			expect(extractBashWriteTargets("cp -t .claude/skills/afk/ /tmp/a")).toContain(".claude/skills/afk/");
			expect(extractBashWriteTargets("mv /tmp/a .claude/skills/afk/SKILL.md")).toContain(".claude/skills/afk/SKILL.md");
			expect(extractBashWriteTargets("rm -rf ~/.claude/skills/afk")).toContain("~/.claude/skills/afk");
			expect(extractBashWriteTargets("sed -i 's/a/b/g' .claude/skills/afk/SKILL.md")).toContain(".claude/skills/afk/SKILL.md");
			expect(extractBashWriteTargets("echo 'hi' | tee ~/.claude/skills/afk/SKILL.md")).toContain("~/.claude/skills/afk/SKILL.md");
		});

		it("ignores read-only commands targeting skills", () => {
			expect(extractBashWriteTargets("cat .claude/skills/afk/SKILL.md")).toEqual([]);
			expect(extractBashWriteTargets("ls -la ~/.claude/skills/")).toEqual([]);
			expect(extractBashWriteTargets("git diff .claude/skills/afk/SKILL.md")).toEqual([]);
			expect(extractBashWriteTargets("grep -rn 'afk' .claude/skills/")).toEqual([]);
		});

		it("ignores commands not referencing skills", () => {
			expect(extractBashWriteTargets("echo 'hello' > src/index.ts")).toEqual([]);
			expect(extractBashWriteTargets("git status")).toEqual([]);
		});

		it("ignores commands that merely mention skills inside heredoc bodies (#1201)", () => {
			const heredoc1 =
				"cat << 'EOF' >> /path/outside/repo/scratch.txt\n## Notes\nMentions $HOME/.claude/skills/dogfood\nEOF";
			expect(extractBashWriteTargets(heredoc1)).toEqual([]);

			const heredocWin =
				"cat << 'EOF' >> /path/outside/repo/scratch.txt\nMentions $HOME\\.claude\\skills\\dogfood\nEOF";
			expect(extractBashWriteTargets(heredocWin)).toEqual([]);
		});

		it("ignores echo commands appending text mentioning skills to an outside file (#1201)", () => {
			expect(extractBashWriteTargets("echo 'see ~/.claude/skills/dogfood' >> /tmp/notes.txt")).toEqual([]);
			expect(extractBashWriteTargets('echo "review .claude/skills/afk" > /tmp/out.txt')).toEqual([]);
		});

		it("ignores commands redirecting skill read output to another file (#1201)", () => {
			expect(extractBashWriteTargets("cat .claude/skills/afk/SKILL.md > /tmp/afk.bak")).toEqual([]);
			expect(extractBashWriteTargets("grep -rn 'afk' .claude/skills/ > /tmp/grep.txt")).toEqual([]);
		});

		it("ignores cp/rsync commands copying FROM a skill to another file (#1201)", () => {
			expect(extractBashWriteTargets("cp .claude/skills/afk/SKILL.md /tmp/afk.bak")).toEqual([]);
			expect(extractBashWriteTargets("rsync -av .claude/skills/afk/ /tmp/backup/")).toEqual([]);
		});

		it("ignores comments mentioning skills followed by writes to other files (#1201)", () => {
			expect(
				extractBashWriteTargets("# Note about ~/.claude/skills/afk\necho 'done' > /tmp/out.txt"),
			).toEqual([]);
		});
	});

	describe("acceptance criteria evaluation", () => {
		const mockFs = (files: Record<string, string>) => ({
			existsSync: (p: string) => {
				const norm = p.replace(/\\/g, "/");
				return Object.prototype.hasOwnProperty.call(files, norm);
			},
			readFileSync: (p: string) => {
				const norm = p.replace(/\\/g, "/");
				if (Object.prototype.hasOwnProperty.call(files, norm)) {
					return files[norm];
				}
				throw new Error(`File not found: ${p}`);
			},
		});

		const rootPrefix = process.platform === "win32" ? "C:" : "";
		const repoRoot = `${rootPrefix}/work/ahOS`;
		const foreignRepo = `${rootPrefix}/work/work`;
		const homedir = `${rootPrefix}/home/user`;
		const cachePath = `${homedir}/.claude/cache/skill-homes.json`;

		const defaultFiles = {
			[`${repoRoot}/.claude/skill-registry.json`]: JSON.stringify({
				version: 1,
				skills: {
					afk: { register: true, surface: ["claude-code"] },
					"dos-hl": { register: true, surface: ["claude-code"] },
				},
			}),
			[`${foreignRepo}/.claude/skill-registry.json`]: JSON.stringify({
				version: 1,
				skills: {
					"work-tool": { register: true },
				},
			}),
			[cachePath]: JSON.stringify({
				updated_at: "2026-09-25T12:00:00Z",
				skills: {
					afk: { storage_location: "kms-repo", storage_url: "anguspersonal/ahOS (.claude/skills/afk/)" },
					"dos-hl": { storage_location: "kms-repo", storage_url: "anguspersonal/ahOS (.claude/skills/dos-hl/)" },
					capture: { storage_location: "kms-db", storage_url: null },
				},
			}),
		};

		it("Acceptance 1: An edit to a kms-repo skill from outside its home repo is refused with real path and #812 stanza", () => {
			const fsModule = mockFs(defaultFiles);

			// Case A: Editing from a foreign repo targeting foreign repo's copy (#809 exact incident)
			const resForeign = evaluateEdit(
				"Write",
				{ file_path: `${foreignRepo}/.claude/skills/afk/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(resForeign.allowed).toBe(false);
			expect(resForeign.message).toContain("anguspersonal/ahOS");
			expect(resForeign.message).toContain(STANZA_812);

			// Case B: Editing ~/.claude/skills/afk/SKILL.md from outside
			const resGlobal = evaluateEdit(
				"Edit",
				{ file_path: "~/.claude/skills/afk/SKILL.md" },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(resGlobal.allowed).toBe(false);
			expect(resGlobal.message).toContain("anguspersonal/ahOS");
			expect(resGlobal.message).toContain(STANZA_812);
		});

		it("Acceptance 2: Editing that same skill inside its home repo is unaffected", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Write",
				{ file_path: `${repoRoot}/.claude/skills/afk/SKILL.md` },
				{ cwd: repoRoot, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(true);

			const resRelative = evaluateEdit(
				"Edit",
				{ file_path: ".claude/skills/dos-hl/SKILL.md" },
				{ cwd: repoRoot, homedir, fsModule, cachePath },
			);
			expect(resRelative.allowed).toBe(true);
		});

		it("Refuses editing ~/.claude/skills/<name> even when run inside the home repo", () => {
			const fsModule = mockFs(defaultFiles);

			// The home repo owns it, so ~/.claude/skills/ is the wrong target
			const res = evaluateEdit(
				"Write",
				{ file_path: "~/.claude/skills/afk/SKILL.md" },
				{ cwd: repoRoot, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(false);
			expect(res.message).toContain(`${repoRoot}/.claude/skills/afk/`);
			expect(res.message).toContain(STANZA_812);
		});

		it("Acceptance 3: Editing a kms-db-homed skill under ~/.claude/skills/ is unaffected", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Write",
				{ file_path: "~/.claude/skills/capture/SKILL.md" },
				{ cwd: repoRoot, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(true);
		});

		it("Refuses editing a kms-db-homed skill inside a repository tree", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Write",
				{ file_path: `${foreignRepo}/.claude/skills/capture/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(false);
			expect(res.message).toContain("~/.claude/skills/capture/");
			expect(res.message).toContain("kms-db");
			expect(res.message).toContain(STANZA_812);
		});

		it("Acceptance 4: ahkms unreachable / missing cache / unknown skill fails open (allowed)", () => {
			// Cache missing
			const fsNoCache = mockFs({
				[`${foreignRepo}/.claude/skill-registry.json`]: JSON.stringify({ skills: {} }),
			});
			const resMissingCache = evaluateEdit(
				"Write",
				{ file_path: `${foreignRepo}/.claude/skills/unknown-skill/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule: fsNoCache, cachePath: "/non-existent/cache.json" },
			);
			expect(resMissingCache.allowed).toBe(true);

			// Skill unknown in cache
			const fsModule = mockFs(defaultFiles);
			const resUnknown = evaluateEdit(
				"Write",
				{ file_path: `${foreignRepo}/.claude/skills/totally-unknown/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(resUnknown.allowed).toBe(true);
		});

		it("blocks detectable Bash write targeting a foreign kms-repo skill", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Bash",
				{ command: `cat << 'EOF' > ${foreignRepo}/.claude/skills/afk/SKILL.md\nmalicious edit\nEOF` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(false);
			expect(res.message).toContain(STANZA_812);
		});

		it("allows Bash read targeting a foreign kms-repo skill", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Bash",
				{ command: `cat ${foreignRepo}/.claude/skills/afk/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(true);
		});

		it("allows Bash commands that merely mention a foreign kms-repo skill without writing to it (#1201)", () => {
			const fsModule = mockFs(defaultFiles);

			// Heredoc mentioning skill path appended to outside scratch file
			const resHeredoc = evaluateEdit(
				"Bash",
				{
					command: `cat << 'EOF' >> /path/outside/scratch.txt\n## Notes\nMentions $HOME/.claude/skills/afk\nEOF`,
				},
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(resHeredoc.allowed).toBe(true);

			// Echo mentioning skill path appended to outside notes file
			const resEcho = evaluateEdit(
				"Bash",
				{ command: `echo "see ${foreignRepo}/.claude/skills/afk" >> /tmp/notes.txt` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(resEcho.allowed).toBe(true);

			// cp reading FROM foreign skill to an outside file
			const resCpFrom = evaluateEdit(
				"Bash",
				{ command: `cp ${foreignRepo}/.claude/skills/afk/SKILL.md /tmp/copy.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(resCpFrom.allowed).toBe(true);
		});

		it("blocks cp writing TO a foreign kms-repo skill (#1201)", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Bash",
				{ command: `cp /tmp/a ${foreignRepo}/.claude/skills/afk/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(false);
			expect(res.message).toContain(STANZA_812);
		});

		it("allows non-skill file edits unconditionally", () => {
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Write",
				{ file_path: "src/tools/myTool.ts" },
				{ cwd: repoRoot, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(true);
		});

		it("round-1 QA High: a foreign repo's OWN registry self-claiming a skill does not defeat the guard when the cache attributes it elsewhere", () => {
			// foreignRepo's local registry now claims "afk" too (e.g. a stale/copied
			// manifest, or `/skill-sync register` run in the wrong repo) — but the
			// ahkms-sourced cache still correctly attributes "afk" to repoRoot (ahOS).
			// Trusting the local self-claim here is exactly the #809 incident class
			// #811 exists to close: a forked copy permanently and silently defeats
			// the guard for that skill.
			const filesWithForeignSelfClaim = {
				...defaultFiles,
				[`${foreignRepo}/.claude/skill-registry.json`]: JSON.stringify({
					version: 1,
					skills: {
						"work-tool": { register: true },
						afk: { register: true },
					},
				}),
			};
			const fsModule = mockFs(filesWithForeignSelfClaim);

			const res = evaluateEdit(
				"Write",
				{ file_path: `${foreignRepo}/.claude/skills/afk/SKILL.md` },
				{ cwd: foreignRepo, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(false);
			expect(res.message).toContain("anguspersonal/ahOS");
			expect(res.message).toContain(STANZA_812);
		});

		it("round-1 QA High: a repo self-claim IS trusted when the cache corroborates it as the canonical kms-repo home", () => {
			// Sanity check for the fix above: repoRoot's self-claim of "afk" must
			// keep working, since the cache's storage_url does reference repoRoot.
			const fsModule = mockFs(defaultFiles);

			const res = evaluateEdit(
				"Write",
				{ file_path: `${repoRoot}/.claude/skills/afk/SKILL.md` },
				{ cwd: repoRoot, homedir, fsModule, cachePath },
			);
			expect(res.allowed).toBe(true);
		});

		describe("round-2 QA High: repoMatchesCachedHome directory-name substring bypass", () => {
			// `storage_url` for a kms-repo skill embeds the fixed path segments
			// ".claude", "skills", and the skill name itself (e.g.
			// "anguspersonal/ahOS (.claude/skills/afk/)"). A plain substring test
			// against that whole string meant a foreign repo directory literally
			// named "afk", "claude", "os" (a fragment of "ahOS"), or "skills" was
			// wrongly corroborated as the canonical home. Reproduces the exact
			// four repros from the round-2 review against evaluateEdit, plus the
			// unit-level parser/corroboration checks directly.

			it.each(["afk", "claude", "os", "skills"])(
				"blocks a foreign repo directory literally named '%s' self-claiming the skill",
				(dirName) => {
					const collidingRepo = `${rootPrefix}/work/${dirName}`;
					const files = {
						...defaultFiles,
						[`${collidingRepo}/.claude/skill-registry.json`]: JSON.stringify({
							version: 1,
							skills: { afk: { register: true } },
						}),
					};
					const fsModule = mockFs(files);

					const res = evaluateEdit(
						"Write",
						{ file_path: `${collidingRepo}/.claude/skills/afk/SKILL.md` },
						{ cwd: collidingRepo, homedir, fsModule, cachePath },
					);
					expect(res.allowed).toBe(false);
					expect(res.message).toContain("anguspersonal/ahOS");
					expect(res.message).toContain(STANZA_812);
				},
			);

			it("control: the real home repo directory name ('ahOS') is still corroborated and allowed", () => {
				const fsModule = mockFs(defaultFiles);
				const res = evaluateEdit(
					"Write",
					{ file_path: `${repoRoot}/.claude/skills/afk/SKILL.md` },
					{ cwd: repoRoot, homedir, fsModule, cachePath },
				);
				expect(res.allowed).toBe(true);
			});

			it("parseOwnerRepoFromStorageUrl extracts an exact owner/repo pair, not a substring", () => {
				expect(parseOwnerRepoFromStorageUrl("anguspersonal/ahOS (.claude/skills/afk/)")).toEqual({
					owner: "anguspersonal",
					repo: "ahos",
				});
				// A bare repo-relative path (the real-world shape for at least one
				// registered kms-repo skill today) has no owner/repo pair to parse —
				// must come back null, not a mis-sliced guess.
				expect(parseOwnerRepoFromStorageUrl(".claude/skills/dogfood")).toBeNull();
				expect(parseOwnerRepoFromStorageUrl("not a url")).toBeNull();
			});

			it("repoMatchesCachedHome requires an exact repo-name match, not substring containment", () => {
				const cached = { storage_location: "kms-repo", storage_url: "anguspersonal/ahOS (.claude/skills/afk/)" };
				expect(repoMatchesCachedHome(`${rootPrefix}/work/ahOS`, cached)).toBe(true);
				expect(repoMatchesCachedHome(`${rootPrefix}/work/os`, cached)).toBe(false);
				expect(repoMatchesCachedHome(`${rootPrefix}/work/claude`, cached)).toBe(false);
				expect(repoMatchesCachedHome(`${rootPrefix}/work/skills`, cached)).toBe(false);
				expect(repoMatchesCachedHome(`${rootPrefix}/work/afk`, cached)).toBe(false);
				// No cache entry at all: fail-open (no ahkms opinion on this skill).
				expect(repoMatchesCachedHome(`${rootPrefix}/work/anything`, null)).toBe(true);
				// Cache entry with a bare relative path (no owner/repo asserted):
				// nothing to corroborate against, so the self-claim is not trusted.
				expect(
					repoMatchesCachedHome(`${rootPrefix}/work/ahOS`, {
						storage_location: "kms-repo",
						storage_url: ".claude/skills/dogfood",
					}),
				).toBe(false);
			});
		});
	});

	describe("end-to-end child process execution", () => {
		const { spawnSync } = require("node:child_process");
		const repoRoot = require("node:path").resolve(__dirname, "../../../../");
		const scriptPath = require("node:path").resolve(
			repoRoot,
			".claude/hooks/check-skill-home.js",
		);

		it("exits with 0 when editing a valid repo-resident skill from this repo", () => {
			const input = JSON.stringify({
				tool_name: "Write",
				tool_input: {
					file_path: ".claude/skills/afk/SKILL.md",
				},
			});
			const result = spawnSync("node", [scriptPath], {
				cwd: repoRoot,
				input,
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
		});

		it("exits with 0 for non-skill file edits", () => {
			const input = JSON.stringify({
				tool_name: "Write",
				tool_input: {
					file_path: "packages/mcp-server/src/index.ts",
				},
			});
			const result = spawnSync("node", [scriptPath], {
				cwd: repoRoot,
				input,
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
		});

		it("exits with 2 and prints #812 stanza when editing ~/.claude/skills/afk/SKILL.md from this repo", () => {
			const input = JSON.stringify({
				tool_name: "Write",
				tool_input: {
					file_path: "~/.claude/skills/afk/SKILL.md",
				},
			});
			const result = spawnSync("node", [scriptPath], {
				cwd: repoRoot,
				input,
				encoding: "utf8",
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("Skill home guard: refused edit");
			expect(result.stderr).toContain(STANZA_812);
		});
	});
});
