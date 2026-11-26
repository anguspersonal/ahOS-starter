import { importUpstreamSkill } from "./import.js";
import type { InitResult } from "./init.js";
import { mapFork, suggestForkMappings } from "./mapping.js";
import type { PullResult } from "./pull.js";
import type { PushResult } from "./push.js";
import type { ResolveChoice } from "./resolve.js";
import { cloneOrFetch, listUpstreams, listUpstreamSkills, registerUpstream, type Upstream, upstreamHead } from "./upstream.js";
import { walkFork } from "./walk.js";

// The ahkms-touching commands (status/push/pull/init/resolve) are imported LAZILY
// inside their cases. Importing them eagerly would load src/env.ts, which throws
// without SUPABASE_* — so `--help` and the git-only `upstream` commands would
// break offline.

// skill-sync CLI (ADR: ahkms as source of truth for single-file skills). This one
// binary is the single shared entry point for BOTH the `/skill-sync` skill and the
// SessionStart hook, so neither needs MCP access. `status` is read-only (#370);
// `push`/`pull`/`init` reconcile local <-> ahkms (#371); `reconcile` is the
// SessionStart auto-reconcile that drives those primitives every boot (#373);
// `resolve` walks the both-changed conflicts `reconcile` defers (#374);
// `upstream` manages forked upstream skill sources (#375/#376).

const USAGE = `skill-sync <command>

Commands:
  status         Report the reconcile state of every single-file skill (read-only)
  reconcile      Auto-reconcile all skills (SessionStart hook): auto-push/pull, defer conflicts, fail-open
  push --all     Push every single-file skill to ahkms (kms-db) and stamp its base
  push <name>    Push one single-file skill by name
  pull <name>    Overwrite one local skill from its ahkms body (backs up local first)
  init           Stamp merge bases where local == ahkms; leave mismatches unbased
  resolve                            List every both-changed conflict with a 3-way diff (read-only)
  resolve --skill <name> --keep local|ahkms   Resolve one conflict (pushes/pulls, advances base)
  resolve --all --keep local|ahkms            Resolve every conflict the same way
  resolve --skill <name> --merge     Write a conflict-marked SKILL.md for hand editing
  resolve --skill <name> --skip      Log the conflict as explicitly left deferred
  upstream add <url>                Register + clone an external skills upstream
  upstream list                     List registered upstreams
  upstream suggest [name]           Suggest fork mappings + new-import candidates
  upstream import <name> <skill>    Import a new upstream skill (strips agents/, stamps x-upstream)
  upstream map <name> <up> <local>  Confirm a fork mapping (stamps x-upstream on the local skill)
  upstream fetch [name]             Re-fetch an upstream clone to its latest HEAD
  upstream walk <local> [--apply]   3-way diff-walk a mapped fork vs upstream (--apply writes + advances base)

Repo-resident skills (this repo's .claude/skills tree, one-way git -> ahkms):
  repo status                       Compare each enrolled repo skill against its ahkms body (read-only)
  repo push [<name>] [--dry-run]    Register enrolled repo skills as kms-db bodies and stamp the manifest
        [--allow-behind]            Push even though this checkout is behind its upstream (#724)
        [--no-fetch]                Skip the currency fetch; compare against the last fetch's result
  audit                             List registered capabilities that serve no body (read-only)
`;

function summarisePush(results: PushResult[]): string {
	const by = (o: PushResult["outcome"]) => results.filter((r) => r.outcome === o);
	const lines: string[] = [];
	for (const outcome of ["created", "updated", "skipped"] as const) {
		const bucket = by(outcome);
		if (bucket.length === 0) continue;
		lines.push(`${outcome} (${bucket.length}):`);
		for (const r of bucket.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`  • ${r.name}${r.reason ? `  — ${r.reason}` : ""}`);
		}
	}
	lines.push(`${results.length} skills processed.`);
	return lines.join("\n");
}

function summarisePull(results: PullResult[]): string {
	return results
		.map((r) => {
			const verb = r.outcome === "pulled" ? "pulled" : r.outcome === "warned" ? "warn  " : "skip  ";
			const tail = [r.reason, r.backupPath ? `backup: ${r.backupPath}` : null].filter(Boolean).join(" — ");
			return `  ${verb} ${r.name}${tail ? `  (${tail})` : ""}`;
		})
		.join("\n");
}

function summariseInit(results: InitResult[]): string {
	const by = (o: InitResult["outcome"]) => results.filter((r) => r.outcome === o);
	const lines: string[] = [];
	for (const outcome of ["based", "unbased", "skipped"] as const) {
		const bucket = by(outcome);
		if (bucket.length === 0) continue;
		lines.push(`${outcome} (${bucket.length}):`);
		for (const r of bucket.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`  • ${r.name}${r.reason ? `  — ${r.reason}` : ""}`);
		}
	}
	lines.push(`${results.length} single-file skills processed.`);
	return lines.join("\n");
}

function isoDay(): string {
	return new Date().toISOString().slice(0, 10);
}

function requireUpstream(name: string | undefined): Upstream {
	const ups = listUpstreams();
	if (ups.length === 0) throw new Error("no upstreams registered — run: skill-sync upstream add <url>");
	if (!name) {
		if (ups.length === 1) return ups[0];
		throw new Error(`name an upstream (have: ${ups.map((u) => u.name).join(", ")})`);
	}
	const up = ups.find((u) => u.name === name);
	if (!up) throw new Error(`no upstream '${name}' — have: ${ups.map((u) => u.name).join(", ")}`);
	return up;
}

async function runUpstream(argv: string[]): Promise<number> {
	const sub = argv[0];
	switch (sub) {
		case "add": {
			const url = argv[1];
			if (!url) {
				process.stderr.write("skill-sync upstream add <url>\n");
				return 2;
			}
			const up = registerUpstream(url);
			process.stdout.write(`registered ${up.name} -> ${up.dir}\n`);
			return 0;
		}
		case "list": {
			const ups = listUpstreams();
			process.stdout.write(ups.length ? ups.map((u) => `  ${u.name}  ${u.url}`).join("\n") + "\n" : "no upstreams registered\n");
			return 0;
		}
		case "suggest": {
			const up = requireUpstream(argv[1]);
			const lines = suggestForkMappings(up).map((s) => {
				if (s.local === null) return `  import  ${s.upstream}  (no local match — new skill)`;
				// A name match can sit on a low body %, so say why rather than show a bare, confusing number.
				const why = s.matchedBy === "name" ? `name match, ${Math.round(s.score * 100)}% body` : `${Math.round(s.score * 100)}%`;
				return `  map     ${s.upstream} -> ${s.local}  (${why})`;
			});
			process.stdout.write(`# ${up.name} @ ${upstreamHead(up.dir).slice(0, 10)}\n${lines.join("\n")}\n`);
			return 0;
		}
		case "import": {
			const up = requireUpstream(argv[1]);
			const name = argv[2];
			const uSkill = name ? listUpstreamSkills(up.dir).find((s) => s.name === name) : undefined;
			if (!uSkill) {
				process.stderr.write(`skill-sync upstream import <name> <skill>: no upstream skill '${name ?? ""}'\n`);
				return 2;
			}
			const res = importUpstreamSkill(up, uSkill, upstreamHead(up.dir), isoDay());
			process.stdout.write(`imported ${res.name} (${res.tier}) -> ${res.dir}\n`);
			return 0;
		}
		case "map": {
			const up = requireUpstream(argv[1]);
			const uName = argv[2];
			const lName = argv[3];
			if (!uName || !lName) {
				process.stderr.write("skill-sync upstream map <name> <upstream-skill> <local-skill>\n");
				return 2;
			}
			const res = mapFork(up, uName, lName, upstreamHead(up.dir), isoDay());
			process.stdout.write(`mapped ${res.upstream} -> ${res.local}  base ${res.baseCommit.slice(0, 10)}/${res.baseBlob.slice(0, 10)}\n`);
			return 0;
		}
		case "fetch": {
			const up = requireUpstream(argv[1]);
			cloneOrFetch(up.url, up.dir);
			process.stdout.write(`fetched ${up.name} @ ${upstreamHead(up.dir).slice(0, 10)}\n`);
			return 0;
		}
		case "walk": {
			const name = argv[1];
			if (!name || name.startsWith("-")) {
				process.stderr.write("skill-sync upstream walk <local-skill> [--apply]\n");
				return 2;
			}
			const res = walkFork(name, isoDay(), { apply: argv.includes("--apply") });
			const bits = [
				res.outcome,
				res.conflicts ? `${res.conflicts} conflict(s)` : null,
				res.baseCommit ? `base->${res.baseCommit.slice(0, 10)}` : null,
				res.reason,
			].filter(Boolean);
			process.stdout.write(`walk ${res.name}: ${bits.join(" — ")}\n`);
			return res.outcome === "conflict" ? 3 : res.outcome === "no-mapping" || res.outcome === "no-base" ? 1 : 0;
		}
		default:
			process.stderr.write(`skill-sync upstream: unknown subcommand '${sub ?? ""}'\n`);
			return 2;
	}
}

// Repo-resident skills (#689). Same lazy-import rule as the ahkms commands above:
// both subcommands talk to ahkms, so neither may be imported at module scope.
async function runRepo(argv: string[]): Promise<number> {
	switch (argv[0]) {
		case "status": {
			const { computeRepoStatus, formatRepoStatus, repoStatusHasProblems } = await import("./repoStatus.js");
			const report = await computeRepoStatus();
			process.stdout.write(formatRepoStatus(report) + "\n");
			return repoStatusHasProblems(report) ? 1 : 0;
		}
		case "push": {
			const { pushRepoSkills, formatRepoPush, repoManifestFile } = await import("./repoPush.js");
			const dryRun = argv.includes("--dry-run");
			const allowBehind = argv.includes("--allow-behind");
			const noFetch = argv.includes("--no-fetch");
			const name = argv.slice(1).find((arg) => !arg.startsWith("-"));
			const results = await pushRepoSkills(name, { dryRun, allowBehind, noFetch });
			process.stdout.write(formatRepoPush(results, repoManifestFile()) + "\n");
			return results.some((result) => result.outcome === "skipped" || result.outcome === "refused") ? 1 : 0;
		}
		default:
			process.stderr.write(`skill-sync repo: unknown subcommand '${argv[0] ?? ""}'\n\n${USAGE}`);
			return 2;
	}
}

// `resolve` (#374). Flags-only: none of the other subcommands prompt (no
// readline/TTY check anywhere in this CLI, `main`/`runUpstream`/`runRepo` above
// are all argv-driven), so this follows the same convention rather than adding
// the CLI's first interactive prompt for one command.
async function runResolve(argv: string[]): Promise<number> {
	const { findConflicts, formatConflict, resolveConflict } = await import("./resolve.js");

	const skillName = argv.includes("--skill") ? argv[argv.indexOf("--skill") + 1] : undefined;
	const allFlag = argv.includes("--all");
	const keepValue = argv.includes("--keep") ? argv[argv.indexOf("--keep") + 1] : undefined;
	const mergeFlag = argv.includes("--merge");
	const skipFlag = argv.includes("--skip");

	if (skillName && allFlag) {
		process.stderr.write("skill-sync resolve: pass --skill <name> OR --all, not both\n");
		return 2;
	}
	if (keepValue !== undefined && keepValue !== "local" && keepValue !== "ahkms") {
		process.stderr.write("skill-sync resolve: --keep takes 'local' or 'ahkms'\n");
		return 2;
	}
	const chosen = [keepValue ? (`keep-${keepValue}` as const) : null, mergeFlag ? "merge" : null, skipFlag ? "skip" : null].filter(
		(x): x is ResolveChoice => x !== null,
	);
	if (chosen.length > 1) {
		process.stderr.write("skill-sync resolve: pass only one of --keep/--merge/--skip\n");
		return 2;
	}
	const choice = chosen[0];
	if (choice && !skillName && !allFlag) {
		process.stderr.write("skill-sync resolve: a choice (--keep/--merge/--skip) needs --skill <name> or --all\n");
		return 2;
	}

	const all = await findConflicts();
	const targets = skillName ? all.filter((c) => c.name === skillName) : all;

	if (all.length === 0) {
		process.stdout.write("skill-sync resolve: no conflicts — nothing to resolve.\n");
		return 0;
	}
	if (skillName && targets.length === 0) {
		process.stderr.write(`skill-sync resolve: '${skillName}' is not one of the deferred conflicts\n`);
		return 1;
	}

	if (!choice) {
		// No choice given: read-only listing (declining a conflict leaves it deferred).
		for (const c of targets) process.stdout.write(formatConflict(c) + "\n\n");
		process.stdout.write(`${targets.length} conflict(s) — pass --keep local|ahkms, --merge, or --skip to resolve.\n`);
		return 0;
	}

	let failed = 0;
	for (const c of targets) {
		process.stdout.write(formatConflict(c) + "\n");
		const res = await resolveConflict(c, choice);
		if (res.outcome === "failed") failed++;
		const tail = [res.reason, res.backupPath ? `backup: ${res.backupPath}` : null].filter(Boolean).join(" — ");
		process.stdout.write(`  ${res.outcome} ${res.name}${tail ? `  (${tail})` : ""}\n\n`);
	}
	return failed > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0];
	switch (command) {
		case "status": {
			const { computeStatus, formatStatus } = await import("./status.js");
			const report = await computeStatus();
			process.stdout.write(formatStatus(report) + "\n");
			return 0;
		}
		case "reconcile": {
			// The SessionStart hook entry point. Fails open: it returns 0 on ANY error
			// (including a missing SUPABASE_* env that throws at import) so a boot-time
			// reconcile can never block or hang the session.
			try {
				const { reconcileAll, formatReconcile } = await import("./hook.js");
				const result = await reconcileAll();
				process.stdout.write(formatReconcile(result) + "\n");
			} catch (err) {
				process.stderr.write(`skill-sync reconcile: skipped (${err instanceof Error ? err.message : String(err)})\n`);
			}
			return 0;
		}
		case "push": {
			const { pushAllSingleFile, pushByName } = await import("./push.js");
			const target = argv[1];
			if (target === "--all") {
				const results = await pushAllSingleFile();
				process.stdout.write(summarisePush(results) + "\n");
				return 0;
			}
			if (target && !target.startsWith("-")) {
				const result = await pushByName(target);
				process.stdout.write(summarisePush([result]) + "\n");
				return result.outcome === "skipped" ? 1 : 0;
			}
			process.stderr.write(`skill-sync push: pass --all or a skill name\n\n${USAGE}`);
			return 2;
		}
		case "pull": {
			const { pullByName } = await import("./pull.js");
			const target = argv[1];
			if (!target || target.startsWith("-")) {
				process.stderr.write(`skill-sync pull: pass a skill name\n\n${USAGE}`);
				return 2;
			}
			const result = await pullByName(target);
			process.stdout.write(summarisePull([result]) + "\n");
			return result.reason === "no such local skill" ? 1 : 0;
		}
		case "init": {
			const { initBases } = await import("./init.js");
			const results = await initBases();
			process.stdout.write(summariseInit(results) + "\n");
			return 0;
		}
		case "repo":
			return runRepo(argv.slice(1));
		case "resolve":
			return runResolve(argv.slice(1));
		case "audit": {
			const { auditBodies, formatAudit } = await import("./audit.js");
			const report = await auditBodies();
			process.stdout.write(formatAudit(report) + "\n");
			// Read-only reporting, but a hosted-and-empty row IS the #689 defect, so
			// exit non-zero: this is usable as a check, not just as a listing.
			return report.rows.some((row) => row.gap === "broken") ? 1 : 0;
		}
		case "upstream":
			return runUpstream(argv.slice(1));
		case undefined:
		case "-h":
		case "--help":
			process.stdout.write(USAGE);
			return 0;
		default:
			process.stderr.write(`skill-sync: unknown command '${command}'\n\n${USAGE}`);
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err) => {
		process.stderr.write(`skill-sync: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
