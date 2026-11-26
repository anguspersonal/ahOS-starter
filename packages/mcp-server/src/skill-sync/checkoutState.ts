import { execFileSync } from "node:child_process";

// Is this checkout current with its upstream? (#724)
//
// WHY THIS EXISTS:
//   On 2026-08-21 `skill-sync repo push` ran from a tree whose `main` was four
//   commits behind `origin/main` and so did not contain #680. It registered the
//   PRE-flip `dos-hl` body into production. `repo status` then reported "in sync
//   (8)" and `npm run check:skill-bodies` reported OK. Both were telling the
//   truth about the wrong thing: a stale file agrees with a stale registration,
//   and every existing check compares two things that move together.
//
//   For roughly eighty minutes, `dos-hl` on any surface without a local file
//   followed the pre-#680 ritual. Nothing in the system could see it.
//
//   This module answers the one question none of those checks ask: is the tree
//   these bytes came from the tree everyone else is on?
//
// WHY IT FETCHES FIRST:
//   `git rev-list --count @..@{u}` compares against the LOCAL remote-tracking
//   ref, which is itself only as fresh as the last fetch. A tree that has not
//   fetched in a week reports "0 behind" with total confidence — the same
//   reads-as-working-while-doing-nothing failure in a new place. So the check
//   fetches before comparing.
//
//   A failed fetch (offline, no credentials) does NOT become a refusal. It
//   yields `unknown`, which warns and lets the push proceed: refusing to
//   register anything without a network round-trip would be a worse tool than
//   the one that got this wrong, and the operator can still read the warning.
//
// WHAT IT CANNOT SEE:
//   Uncommitted local edits. Those are legitimate — testing a pending receipt
//   before committing it is exactly how a registration gets verified — and the
//   manifest-drift refusal in repoPush.ts already governs whether the BYTES were
//   reviewed. This module is only about the commit the tree sits on.

export type CheckoutCurrency = "current" | "behind" | "unknown";

export interface CheckoutState {
	currency: CheckoutCurrency;
	/** Commits the upstream has that this checkout does not. 0 unless `behind`. */
	behind: number;
	/** e.g. "origin/dev". Null when the branch tracks nothing. */
	upstream: string | null;
	/** Why the state is `unknown`, for the operator. Absent otherwise. */
	reason?: string;
}

function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

export interface CheckoutStateOptions {
	/** Skip the fetch. The comparison then uses whatever the last fetch left behind. */
	noFetch?: boolean;
	/** Injected for tests, so no test ever shells out to a network. */
	runGit?: (args: string[], cwd: string) => string | null;
}

/**
 * Describe how current `repoRoot` is relative to the branch it tracks.
 *
 * Never throws. Every git failure resolves to `unknown` with a reason, because
 * this runs in front of a command whose real job is elsewhere; taking that
 * command down over a git invocation would be the wrong trade.
 */
export function describeCheckoutState(repoRoot: string, options: CheckoutStateOptions = {}): CheckoutState {
	const run = options.runGit ?? git;

	if (run(["rev-parse", "--git-dir"], repoRoot) === null) {
		return { currency: "unknown", behind: 0, upstream: null, reason: "not a git repository" };
	}

	// Resolve the tracking branch first: no upstream means there is nothing to be
	// behind, and that is a legitimate state (a detached checkout, a branch never
	// pushed), not a fault to report as a fault.
	const upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoRoot);
	if (!upstream) {
		return {
			currency: "unknown",
			behind: 0,
			upstream: null,
			reason: "this branch tracks no upstream, so there is nothing to compare against",
		};
	}

	if (!options.noFetch) {
		// Fetch the tracked branch ONLY, not every ref: this is a currency check in
		// front of somebody's push, not a sync.
		const [remote, ...rest] = upstream.split("/");
		const branch = rest.join("/");
		if (remote && branch && run(["fetch", "--quiet", remote, branch], repoRoot) === null) {
			return {
				currency: "unknown",
				behind: 0,
				upstream,
				reason: `could not fetch ${upstream} (offline, or no access) — the comparison below would use a possibly-stale copy`,
			};
		}
	}

	const count = run(["rev-list", "--count", `HEAD..${upstream}`], repoRoot);
	const behind = count === null ? Number.NaN : Number.parseInt(count, 10);
	if (!Number.isFinite(behind)) {
		return { currency: "unknown", behind: 0, upstream, reason: `could not count commits behind ${upstream}` };
	}

	return behind > 0
		? { currency: "behind", behind, upstream }
		: { currency: "current", behind: 0, upstream };
}

/** One line for the operator, whichever state came back. */
export function describeCheckoutStateLine(state: CheckoutState): string {
	if (state.currency === "current") return `checkout is current with ${state.upstream}.`;
	if (state.currency === "behind") {
		return `checkout is ${state.behind} commit(s) BEHIND ${state.upstream} — the bodies here are not the bodies on ${state.upstream}.`;
	}
	return `checkout currency is UNKNOWN: ${state.reason ?? "no reason given"}.`;
}
