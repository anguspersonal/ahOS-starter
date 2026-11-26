import { getCredential } from "./credentials.js";
import { peekDailyLogTarget } from "./dailyLogTarget.js";
import { DOMAINS, DOMAIN_PROVIDER, type Domain } from "./domains.js";
import {
	loadIntegrationConfig,
	notionConfigSchema,
	notionPersonalConfigSchema,
} from "./integrations.js";

// The one domain→provider→token resolution for the generic Notion page tools
// (notion_page_get / notion_page_update, #625 + #818). A shared module rather than a
// per-tool copy because #818 names the drift risk explicitly: the read and write halves
// must resolve identically, or a page readable under one token becomes writable under
// another. Lives OUTSIDE domains.ts so config-printing tools that import domains stay
// structurally unable to reach credentials.ts (the seam credentials.ts documents).

/**
 * `domain` is required and never defaulted — the same rule state_doc_update and
 * daily_log_create enforce (ADR-054 §9): the two workspaces are separate Notion
 * integrations with disjoint page access, and a destination that defaults silently is
 * one that will one day be wrong. On 2026-08-08 the one tool that DID default
 * (task_create, #820) put a personal task in the work board.
 */
export function requireDomain(domain: Domain | undefined, doing: string): Domain {
	if (!domain) {
		throw new Error(
			`\`domain\` is required to ${doing} — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.`,
		);
	}
	return domain;
}

/** The selected domain's Notion token, via the provider map — never resolveToken's fallback. */
export async function domainToken(domain: Domain): Promise<string> {
	return getCredential(DOMAIN_PROVIDER[domain]);
}

/** True for the "object_not_found"-style failures notion.ts surfaces as `(404)`. */
export function isNotionNotFound(err: unknown): boolean {
	return err instanceof Error && err.message.includes("(404)");
}

/**
 * True when a page-envelope fetch failed because the id simply is not a page: Notion
 * answers 404 for a block id but 400 `validation_error` ("is a database, not a page")
 * for a database id. notion_page_get treats both as a SHAPE rather than a failure —
 * the children listing is the load-bearing call — so both have to be recognised, and
 * only the 404 was (a database id failed the whole read against production on
 * 2026-08-23, the first time the tool met one).
 */
export function isNotPageEnvelope(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (isNotionNotFound(err)) return true;
	return err.message.includes("(400)") && /not a page|is a database/i.test(err.message);
}

/**
 * The teaching half of a 404: a page missing from one workspace routinely lives in the
 * other (the #424 defect-1 class — on 2026-08-23 a personal page 404'd for a whole
 * session because the caller was authenticated to Work). Name the retry rather than
 * leaving the caller to conclude "Notion is unavailable".
 */
export function crossWorkspaceHint(domain: Domain): string {
	const other = DOMAINS.find((d) => d !== domain);
	return `Not found in the '${domain}' workspace (provider '${DOMAIN_PROVIDER[domain]}'). The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='${other}'.`;
}

/**
 * A Notion id from whatever a caller has in hand: a dashed or undashed 32-hex id, or a
 * full notion.so / app.notion.com URL. Returned dashed, Notion's canonical shape.
 *
 * Two details that look fussy and are not (#839). A Notion URL ends `<slug>-<32 hex>`,
 * where the slug is arbitrary user text, so:
 *
 * - Only the LAST PATH SEGMENT is considered. Stripping dashes from the whole URL welds
 *   the slug onto the id.
 * - The id is the LAST 32 characters of the last hex run, not the first 32. A slug ending
 *   in anything hex-ish — `-817-`, `-2026-`, a trailing `-1` — extends that run leftwards,
 *   and anchoring at its start reads 32 characters from the wrong offset. That produced a
 *   syntactically valid id pointing at nothing on 2026-08-23, from a URL this tool had
 *   just emitted itself. Every earlier test happened to use a slug ending in a non-hex
 *   letter, which is why it survived: the bug is invisible unless the slug ends in hex.
 */
export function normalizeNotionId(input: string): string {
	const segment = input.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "";
	const runs = segment.replace(/-/g, "").match(/[0-9a-f]{32,}/gi);
	if (!runs) {
		throw new Error(
			`Could not find a Notion id in '${input}' — pass a 32-hex page/block id (dashed or not) or a full Notion URL.`,
		);
	}
	const run = runs[runs.length - 1];
	const id = run.slice(run.length - 32).toLowerCase();
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Refuse a write addressed at the domain's State Doc. state_doc_update is those pages'
 * ONLY writer (ADR-053's one-writer rule) — a generic page tool that could also write
 * them would quietly reopen the append-only-drift problem that rule closed. The check is
 * structural, not prose: prose rules are exactly what got ignored six times on
 * 2026-08-23. A missing config row degrades to no guard (nothing to compare).
 *
 * Shared by notion_page_update and notion_page_create (#1057). A second copy would be a
 * second thing to remember when a third writer appears, and the rule it enforces is one
 * an author reaches for only after being told it exists.
 */
export async function refuseStateDocTarget(domain: Domain, pageId: string): Promise<void> {
	const config = await loadDomainNotionConfig(domain);
	const stateDocId = config?.state_doc_page_id;
	if (!stateDocId) return;
	if (sameNotionId(stateDocId, pageId)) {
		throw new Error(
			`This is the '${domain}' State Doc. Its sections are edited only through state_doc_update (ADR-053 one-writer rule) — use that tool, which addresses sections by exact heading and stamps 'Last updated' itself.`,
		);
	}
}

/**
 * Refuse a row addressed at the domain's Daily Log (#1017). daily_log_create is that
 * database's only writer, for the same reason state_doc_update is the State Doc's: a
 * Daily Log row is not a note. It holds its date against the dos ritual, whose writer
 * refuses a second entry for a day (#673), so a working-session page filed there is a
 * day the unattended sweep can never close. On 2026-09-14 an IDE session did exactly
 * that to the angus log, and that day's atoms were stranded.
 *
 * `ids` are compared against both the database and the data source pointer, so a
 * caller may pass either, in any spelling. A missing config row, or an id with no
 * Notion id in it, degrades to no guard: the create's own validation reports the
 * latter. The pointer itself comes from `dailyLogTarget.ts`'s `peekDailyLogTarget`
 * rather than a second read of the same two config fields here — that module exists
 * specifically so the write path and a guard like this one cannot resolve the Daily Log
 * differently (round 1 QA on #1017).
 */
export async function refuseDailyLogTarget(domain: Domain, ids: string[]): Promise<void> {
	const pointer = await peekDailyLogTarget(domain);
	if (!pointer) return;
	const dailyLog = [pointer.databaseId, pointer.dataSourceId].filter((v): v is string => Boolean(v));
	if (!ids.some((id) => dailyLog.some((p) => sameNotionId(p, id)))) return;
	throw new Error(
		`This is the '${domain}' Daily Log. Its entries are written only by the dos ritual, through daily_log_create (ADR-051 §11): one entry per domain per date, and a row filed here would hold its date against the ritual's own write, so that day could never be closed. To record a working session or a note, use capture; dos folds it into the day.`,
	);
}

/** The domain's Notion integration row, parsed; null when unconfigured. */
export async function loadDomainNotionConfig(domain: Domain) {
	return DOMAIN_PROVIDER[domain] === "notion_personal"
		? await loadIntegrationConfig("notion_personal", notionPersonalConfigSchema)
		: await loadIntegrationConfig("notion_work", notionConfigSchema);
}

export async function getStateDocPageId(domain: Domain): Promise<string | undefined> {
	const config = await loadDomainNotionConfig(domain);
	return config?.state_doc_page_id;
}

/**
 * The domain's Daily Log pointer IDs (database id and, when wired, data source id)
 * built from `peekDailyLogTarget` for `NotionPort.getDailyLogTargetIds` (#1572).
 */
export async function dailyLogTargetIds(domain: Domain): Promise<string[]> {
	const pointer = await peekDailyLogTarget(domain);
	if (!pointer) return [];
	return [pointer.databaseId, pointer.dataSourceId].filter((v): v is string => Boolean(v));
}

/** Two Notion ids name the same object, whatever their spelling (dashes, case, URL). */
function sameNotionId(a: string, b: string): boolean {
	const canonical = (value: string) => {
		try {
			return normalizeNotionId(value);
		} catch {
			return value.replace(/-/g, "").toLowerCase();
		}
	};
	return canonical(a) === canonical(b);
}
