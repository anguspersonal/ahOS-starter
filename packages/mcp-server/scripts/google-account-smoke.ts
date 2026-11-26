/**
 * Prove a Google account is actually wired, against the live APIs.
 *
 * Run this straight after minting a refresh token, BEFORE trusting any agent output.
 * It answers the three questions that a green unit-test suite cannot:
 *
 *   1. WHICH mailbox did the consent screen actually authorise? The --account flag only
 *      picks an env var; the account is whoever you signed in as. Approving as the wrong
 *      user yields a token that works perfectly against the wrong mailbox, and the only
 *      symptom is empty search results.
 *   2. Does the token carry the Gmail scopes? A token minted before the Gmail scopes
 *      joined google/scopes.ts is accepted by Google and then refused by Gmail with a
 *      403 (ADR-045, #126). The fix is a re-consent, never a code change.
 *   3. Does the detection rule find real mail, and does a real Doc come back with all
 *      its tabs?
 *
 * Usage (from repo root):
 *   node --env-file=packages/mcp-server/.env --import tsx \
 *     packages/mcp-server/scripts/google-account-smoke.ts --account work [--doc <fileId>]
 *
 * Read-only. It labels nothing, captures nothing and sends nothing.
 */
import { getProfile, listLabels } from "../src/google/gmail.js";
import { readDocument } from "../src/google/docs.js";
import {
	buildDetectionQuery,
	DEFAULT_MEETING_NOTE_SOURCES,
	matchMeetingNoteEmail,
} from "@ahkms/core";
import { searchMessages } from "../src/google/gmail.js";
import { parseGoogleAccount, type GoogleAccount } from "../src/google/accounts.js";

function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

/** Report a step's outcome without aborting the run — later checks are still useful. */
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

/** Stored rules if Supabase is wired here, otherwise the shipped defaults. */
async function loadSources(): Promise<{
	sources: typeof DEFAULT_MEETING_NOTE_SOURCES;
	origin: string;
}> {
	if (!process.env.SUPABASE_URL) {
		return { sources: DEFAULT_MEETING_NOTE_SOURCES, origin: "shipped defaults (no SUPABASE_URL here)" };
	}
	const [{ createSupabaseConfigRepository }, { supabase }, { getCurrentUserId }] = await Promise.all([
		import("@ahkms/core/adapters"),
		import("../src/supabase.js"),
		import("../src/identity.js"),
	]);
	const repo = createSupabaseConfigRepository({
		client: supabase as any,
		ownerId: getCurrentUserId,
	});
	return repo.meetingNoteSources(getCurrentUserId());
}

async function main(): Promise<void> {
	const account: GoogleAccount = parseGoogleAccount(argValue("--account"));
	const docId = argValue("--doc");
	log(`Smoke-testing the '${account}' Google account.`);

	const results: boolean[] = [];

	results.push(
		await step("gmail profile", async () => {
			const p = await getProfile(account);
			return `  mailbox: ${p.emailAddress}\n  messages: ${p.messagesTotal}\n  >>> Confirm this is the address you expected. If it is not, re-mint signed in as the right user.`;
		}),
	);

	results.push(
		await step("gmail labels", async () => {
			const labels = await listLabels(account);
			const user = labels.filter((l) => l.type !== "system");
			return `  ${labels.length} labels (${user.length} user-created)\n  meeting_note present: ${
				user.some((l) => l.name.toLowerCase() === "meeting_note") ? "yes" : "no"
			}`;
		}),
	);

	results.push(
		await step("meeting-note detection", async () => {
			// Stored rules when a database is configured, shipped defaults otherwise: this
			// script must be runnable with Google credentials alone, right after a mint,
			// before anything else about the deployment is set up.
			const { sources, origin } = await loadSources();
			const query = buildDetectionQuery(sources, { newerThan: "14d" });
			const messages = await searchMessages(account, query, 10);
			const matched = messages
				.map((m) => ({ m, hit: matchMeetingNoteEmail(m, sources) }))
				.filter((r) => r.hit);
			const lines = matched.map(
				({ m, hit }) =>
					`    • ${hit?.meeting_title ?? "(no title)"} — ${m.subject}\n      docs: ${
						hit?.doc_urls.join(", ") || "(none)"
					}`,
			);
			const report = [
				`  rules: ${origin}`,
				`  query: ${query}`,
				`  examined ${messages.length}, matched ${matched.length}`,
				...lines,
			].join("\n");
			// A sweep that matches nothing is a FAILURE, not a pass. The API call
			// succeeded, so without this the script cheerfully reports "all checks
			// passed" over rules that find no mail at all — the exact false negative
			// this script exists to catch.
			if (matched.length === 0) {
				throw new Error(
					`${report}\n  Nothing matched. Re-run with --search to see what the real mail looks like.`,
				);
			}
			return report;
		}),
	);

	const probe = argValue("--search");
	if (probe) {
		// Diagnostic for the case above: when a rule matches nothing, the question is
		// always "what does the real mail look like?". Prints sender and subject verbatim
		// so the next rule is written from evidence rather than from another guess.
		results.push(
			await step(`search: ${probe}`, async () => {
				const found = await searchMessages(account, probe, 20);
				if (found.length === 0) return "  (nothing matched)";
				const withBody = process.argv.includes("--body");
				return found
					.map(
						(m) =>
							`    id:   ${m.id}\n    from: ${m.from}\n    subj: ${m.subject}\n    date: ${m.date}` +
							(withBody ? `\n    ---- body ----\n${m.body.slice(0, 2000)}\n    ---- end ----` : ""),
					)
					.join("\n\n");
			}),
		);
	}

	if (docId) {
		results.push(
			await step("doc read (all tabs)", async () => {
				const doc = await readDocument(docId, account);
				const tabs = doc.tabs
					.map((t) => `    - ${"  ".repeat(t.depth)}${t.title} (${t.text.length} chars)`)
					.join("\n");
				return `  title: ${doc.title}\n  tabs: ${doc.tabs.length}\n${tabs}\n  total: ${doc.text.length} chars`;
			}),
		);
	} else {
		log("\n[doc read] skipped — pass --doc <fileId> to check tab extraction.");
	}

	const failed = results.filter((r) => !r).length;
	log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}`);
	process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
	log(`Smoke test aborted: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
});
