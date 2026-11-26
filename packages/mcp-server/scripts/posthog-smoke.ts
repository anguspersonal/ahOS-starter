/**
 * Prove a PostHog connection is actually wired, against the live API.
 *
 * Run this BEFORE building any PostHog tool. It answers the questions a green unit-test
 * suite cannot, and one that the Gmail equivalent had no way to ask:
 *
 *   1. WHICH account and organisation does this key belong to? The --connection flag
 *      only picks an env var. A key pasted from the wrong account authenticates
 *      perfectly against the wrong organisation and every number it returns is real,
 *      correct, and about something else.
 *   2. WHICH region? A key minted in EU cloud 401s against the US host, and the error
 *      reads as a bad credential rather than a wrong region.
 *   3. WHICH projects can it reach? Enumerated from PostHog, so connection rows get
 *      written from evidence. (Gmail could not do this — the Gemini sender took three
 *      guesses because a mailbox cannot list "senders that exist".)
 *   4. What does the project's OWN test-account filter actually contain? This is the
 *      half of the #742 contract that metrics.yml says lives outside the repo.
 *   5. Can a raw HogQL query apply that filter at all? This decides what enforcement
 *      can look like, and it is the difference between the 7% and the 1-2%.
 *
 * Usage (from repo root):
 *   node --env-file=packages/mcp-server/.env --import tsx \
 *     packages/mcp-server/scripts/posthog-smoke.ts [--connection work] \
 *     [--host auto|us|eu|<origin>] [--project <id>] [--days 7]
 *
 * Read-only. It queries and prints; it writes nothing, anywhere.
 */
import {
	getIdentity,
	getProject,
	listProjects,
	runQuery,
	type PostHogTarget,
} from "../src/posthog/client.js";
import type { ConnectionRef } from "../src/credentials.js";

function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
	try {
		log(`\n[${name}]`);
		log(await fn());
		return true;
	} catch (err) {
		log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/** First number out of a query result, whatever shape the row came back in. */
function firstNumber(result: { results?: unknown[][] }): number | null {
	const cell = result.results?.[0]?.[0];
	return typeof cell === "number" ? cell : null;
}

/**
 * Find the region that answers, rather than making the operator guess.
 *
 * A wrong-region key fails as 401, which is indistinguishable from a wrong key. Probing
 * both and naming the winner converts a plausible dead end into one printed line.
 */
async function detectHost(ref: ConnectionRef, requested: string): Promise<string> {
	if (requested !== "auto") {
		await getIdentity({ ref, host: requested });
		return requested;
	}
	const errors: string[] = [];
	for (const candidate of ["us", "eu"]) {
		try {
			await getIdentity({ ref, host: candidate });
			return candidate;
		} catch (err) {
			errors.push(`  ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	throw new Error(`Neither region accepted this key.\n${errors.join("\n")}`);
}

async function main(): Promise<void> {
	const slug = argValue("--connection") ?? "work";
	const ref = `posthog:${slug}` as ConnectionRef;
	const days = Number(argValue("--days") ?? 7);
	const requestedHost = argValue("--host") ?? "auto";

	log(`Smoke-testing the '${ref}' PostHog connection.`);

	const host = await detectHost(ref, requestedHost);
	const target: PostHogTarget = { ref, host };
	log(`  region: ${host}${requestedHost === "auto" ? " (auto-detected)" : ""}`);

	const results: boolean[] = [];

	results.push(
		await step("identity", async () => {
			const id = await getIdentity(target);
			return `  user: ${id.email}\n  org:  ${id.organizationName ?? "(none)"} [${id.organizationId ?? "?"}]\n  >>> Confirm this is the account you expected. If not, re-mint the key signed in as the right user.`;
		}),
	);

	// Enumerated first, because everything below needs a project id and hand-typing one
	// is how you end up querying a real project that is not the one you meant.
	let projects: { id: number; name: string }[] = [];
	results.push(
		await step("projects this key can reach", async () => {
			projects = await listProjects(target);
			// Zero projects is a FAILURE, not an empty pass. The call succeeded, so
			// without this the script reports "all checks passed" over a key that can
			// see nothing — the same false negative the Gmail sweep had.
			if (projects.length === 0) {
				throw new Error(
					"This key reaches no projects. Check its scopes (project:read) and its organisation.",
				);
			}
			return projects.map((p) => `    • [${p.id}] ${p.name}`).join("\n");
		}),
	);

	const requestedProject = argValue("--project");
	const projectId = requestedProject
		? Number(requestedProject)
		: projects.length === 1
			? projects[0].id
			: null;

	if (projectId === null) {
		log(
			`\nThis key reaches ${projects.length} projects. Re-run with --project <id> to check one.`,
		);
		process.exitCode = results.every(Boolean) ? 0 : 1;
		return;
	}
	if (projects.length && !projects.some((p) => p.id === projectId)) {
		log(
			`\n[project ${projectId}]\n  FAILED: not in the list above, so this key cannot read it. Refusing to continue against a project the key does not reach.`,
		);
		process.exitCode = 1;
		return;
	}

	results.push(
		await step(`project ${projectId} test-account filter (the #742 contract, from source)`, async () => {
			const p = await getProject(target, projectId);
			const filters = p.testAccountFilters;
			const rendered = filters.length
				? filters.map((f) => `    ${JSON.stringify(f)}`).join("\n")
				: "    (none configured)";
			return [
				`  project: ${p.name}`,
				`  default-checked: ${p.testAccountFiltersDefaultChecked}`,
				`  filters (${filters.length}):`,
				rendered,
				"  >>> This is what PostHog enforces. The connection's contract is written against THIS,",
				"  >>> not against a description of it that drifts when someone edits the UI.",
			].join("\n");
		}),
	);

	// The decisive probe. Same window, same event count, two ways: once as plain HogQL,
	// once with the {filters} placeholder plus filterTestAccounts. If the second is
	// rejected, no raw-SQL surface can ever be made safe and the tool must expose
	// structured queries only. If it is accepted and the numbers differ, that difference
	// IS the 7%-vs-1-2% error, printed rather than inferred.
	results.push(
		await step(`event count over ${days}d, unfiltered vs filtered`, async () => {
			const since = `now() - interval ${days} day`;
			const unfiltered = await runQuery(target, projectId, {
				kind: "HogQLQuery",
				query: `select count() from events where timestamp >= ${since}`,
			});
			const a = firstNumber(unfiltered);

			let b: number | null = null;
			let filteredNote = "";
			try {
				const filtered = await runQuery(target, projectId, {
					kind: "HogQLQuery",
					query: `select count() from events where timestamp >= ${since} and {filters}`,
					filters: { filterTestAccounts: true },
				});
				b = firstNumber(filtered);
			} catch (err) {
				filteredNote = `\n  filtered query REJECTED: ${err instanceof Error ? err.message : String(err)}`;
			}

			const lines = [
				`  unfiltered (plain HogQL):        ${a ?? "(no number returned)"}`,
				`  filtered  ({filters} + flag):    ${b ?? "(not obtained)"}${filteredNote}`,
			];

			if (a !== null && b !== null) {
				const delta = a - b;
				const pct = a > 0 ? ((delta / a) * 100).toFixed(1) : "0.0";
				lines.push(
					`  excluded by the filter:          ${delta} (${pct}% of the unfiltered total)`,
					delta === 0
						? "  >>> Identical. Either no test-account traffic in this window, or the placeholder did nothing. Widen --days before concluding."
						: "  >>> The filter is live and the placeholder works. A raw query WITHOUT {filters} returns the larger number, silently. That is the enforcement hook.",
				);
			}
			return lines.join("\n");
		}),
	);

	const failed = results.filter((r) => !r).length;
	log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}`);
	process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
	log(`Smoke test aborted: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
});
