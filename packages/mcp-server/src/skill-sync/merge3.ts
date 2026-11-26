import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 3-way merge via `git merge-file` (#376): fold the base->upstream changes into the
// local fork. Non-overlapping upstream changes apply automatically; regions where
// both the fork and upstream moved come back as conflict-marked hunks for a human to
// resolve. Battle-tested merge logic, so we don't hand-roll diff3.

export interface Merge3Result {
	/** Merged text (with conflict markers where local and upstream overlap). */
	merged: string;
	/** Number of conflicting hunks (0 = clean). */
	conflicts: number;
	clean: boolean;
}

interface ExecError {
	status?: number;
	stdout?: string;
}

/** Merge base->upstream changes into `local`. Order mirrors `git merge-file <current> <base> <other>`. */
export function merge3(base: string, local: string, upstream: string): Merge3Result {
	const dir = mkdtempSync(join(tmpdir(), "skill-merge-"));
	try {
		const bf = join(dir, "base");
		const lf = join(dir, "local");
		const uf = join(dir, "upstream");
		writeFileSync(bf, base);
		writeFileSync(lf, local);
		writeFileSync(uf, upstream);

		const args = ["merge-file", "-p", "-L", "local", "-L", "base", "-L", "upstream", lf, bf, uf];
		try {
			const merged = execFileSync("git", args, { encoding: "utf8" });
			return { merged, conflicts: 0, clean: true };
		} catch (err) {
			// git merge-file exits with the conflict count (>0) and still prints the
			// merged-with-markers result on stdout; a negative status is a real error.
			const e = err as ExecError;
			if (typeof e.status === "number" && e.status > 0 && typeof e.stdout === "string") {
				return { merged: e.stdout, conflicts: e.status, clean: false };
			}
			throw err;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
