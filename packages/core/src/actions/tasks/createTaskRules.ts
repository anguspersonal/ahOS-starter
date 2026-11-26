/**
 * Pure task-creation rules moved from tools/createTask.ts (#1661).
 */

export type TaskStatusPropertyShape = {
	status?: { name?: string } | null;
	select?: { name?: string } | null;
	title?: Array<{ plain_text?: string }>;
};

export type TaskWorkspaceAutomationShape = {
	automations?: {
		completed_at_stamp?: {
			data_source_id: string;
			status_property: string;
			done_values: string[];
		};
	};
	[key: string]: unknown;
};

/**
 * Tomorrow as a bare YYYY-MM-DD, for the triage due-date default (issue #298, from the
 * ratified capture-consolidation decision: "Due=tomorrow"). Computed from the server's
 * LOCAL calendar date: the stdio server runs on the user's own machine, where local time
 * IS the user's timezone; the remote (Railway) deployment runs UTC, which for a
 * date-only default is at worst one day early for a user far east of UTC. There is no
 * persisted per-user timezone anywhere in the system yet to do better against — if one
 * lands, this is the seam to route it through. Exported for tests.
 */
export function tomorrowDateOnly(now: Date = new Date()): string {
	// Local date parts (NOT toISOString, which would shift the date across the UTC
	// boundary for non-UTC servers); Date normalises day+1 across month/year ends.
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Build the "Skipped: ..." response text for a dedup hit. When the skip happened under
 * `single_task`, the text always includes the literal phrase
 * "skipped as duplicate (single_task)" — per the round-1 review's finding that a
 * misclassified single_task (an atom that actually has more than one distinct task)
 * silently drops every task after the first with nothing but prose to notice it by.
 * Grepping tool output for this exact phrase is the intended way callers/skills catch
 * that misclassification; don't reword it without updating callers that may match on it.
 */
export function skippedDuplicateText(opts: {
	artifactId: string;
	dedupKey?: string;
	singleTask?: boolean;
	raceLost?: boolean;
}): string {
	const reason = opts.dedupKey ? `a task with dedup_key '${opts.dedupKey}'` : "a task";
	const raceNote = opts.raceLost ? " — lost a concurrent dedup race" : "";
	const singleTaskNote = opts.singleTask
		? " This atom was skipped as duplicate (single_task) — if it actually has more than one distinct task, re-run the missed ones with dedup_key instead."
		: "";
	return (
		`Skipped: ${reason} is already linked to artifact ${opts.artifactId} (kind='task')${raceNote}. ` +
		`No new Notion page created.${singleTaskNote}`
	);
}

/**
 * Status/select option names treated as "closed" by the Tasks-DB duplicate guard (#734),
 * matched case-insensitively. This is the FALLBACK vocabulary — used whenever the
 * workspace has no persisted done-values list that actually applies (see
 * `resolveClosedStatusNames` below) — over the vocabulary actually used across ahOS's two
 * known workspaces (a plain "Not started/In progress/Done" status and the P0–P4
 * framework, neither of which needs anything beyond these names). A status value that
 * matches NEITHER this set NOR is missing is treated as OPEN — the guard would rather
 * over-report a duplicate (the caller can always pass `skip_notion_dedup: true`) than
 * under-report one and silently create a second task next to an unrecognised status.
 */
export const CLOSED_STATUS_NAMES = new Set([
	"done",
	"completed",
	"complete",
	"cancelled",
	"canceled",
	"closed",
	"archived",
	"won't do",
	"wont do",
	"abandoned",
]);

/** Read a query result's status/select property value name, whichever type it turns out to be. */
export function statusValueName(prop: TaskStatusPropertyShape | undefined): string | undefined {
	return prop?.status?.name ?? prop?.select?.name ?? undefined;
}

/**
 * The closed-status vocabulary to use for THIS query, per round-1 QA (#734): prefer the
 * workspace's own persisted done-values list over the hardcoded fallback when one exists
 * and actually applies to the data source/property this guard is querying.
 *
 * `notion_personal`'s `automations.completed_at_stamp` (#546/ADR-048) is scoped to a
 * single automation rule — its own `data_source_id` and `status_property` — not a
 * general per-database vocabulary, so it is only trustworthy here when both match what
 * the guard is about to read: same data source, same resolved status property name. When
 * it matches, its `done_values` are UNIONED with `CLOSED_STATUS_NAMES` rather than
 * replacing it — the rule only promises "these values are done", not "this is the
 * complete list", so union never removes a protection the fallback already gave. When it
 * doesn't match (wrong data source/property, unset, or the `notion_work` workspace,
 * whose schema has no `automations` key at all), this returns the fallback unchanged.
 */
export function resolveClosedStatusNames(
	config: TaskWorkspaceAutomationShape,
	dataSourceId: string,
	statusPropertyName: string,
): Set<string> {
	const rule = config.automations?.completed_at_stamp;
	if (
		!rule ||
		rule.data_source_id !== dataSourceId ||
		rule.status_property !== statusPropertyName
	) {
		return CLOSED_STATUS_NAMES;
	}
	return new Set([
		...CLOSED_STATUS_NAMES,
		...rule.done_values.map((value) => value.trim().toLowerCase()),
	]);
}

/**
 * Whether a matched Notion page counts as "open" for the duplicate guard (#734's "an OPEN
 * task" from the issue's sketch). No status property configured/found, or a status value
 * neither `closedNames` set recognises, is treated as open — see CLOSED_STATUS_NAMES'
 * comment for why erring toward "duplicate" rather than "let it through" is the safer
 * default. `closedNames` defaults to the hardcoded fallback; callers that know the
 * workspace/data-source should pass `resolveClosedStatusNames`'s result instead.
 */
export function isOpenStatus(
	name: string | undefined,
	closedNames: Set<string> = CLOSED_STATUS_NAMES,
): boolean {
	if (!name) return true;
	return !closedNames.has(name.trim().toLowerCase());
}

/** Concatenate a title property's rich-text runs into plain text, mirroring notionResultTitle. */
export function readTitleText(prop: TaskStatusPropertyShape | undefined): string {
	if (!Array.isArray(prop?.title)) return "";
	return prop.title.map((r) => r?.plain_text ?? "").join("");
}

/** Case-insensitive, trimmed equality — the issue's stated title-match rule. */
export function titlesMatch(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The response text for a create skipped because the Tasks-DB guard found an existing
 * open task (#734). Distinct wording from `skippedDuplicateText` (the ledger-side guard)
 * so a caller/skill can tell which system caught the duplicate — the ledger guard means
 * "you (ahKMS) already made this"; this one means "the Tasks DB already has this",
 * possibly a task nobody but Notion ever knew about.
 */
export function notionDuplicateText(opts: {
	title: string;
	page: { id: string };
	pageUrl?: string;
}): string {
	const url = opts.pageUrl ? `\nPage: ${opts.pageUrl}` : "";
	return (
		`Duplicate of existing task: an open task titled '${opts.title}' (or linked to the same ` +
		`source) already exists in the Tasks DB (page ${opts.page.id}).${url}\n` +
		`No new Notion page created — the guard consulted the Tasks database itself (ADR-040 erratum, ` +
		`#413), not only the lineage ledger. Pass skip_notion_dedup: true to create a second task ` +
		`anyway.`
	);
}

/**
 * Extract a Notion page ID from a person record's `properties.notion_page_id`,
 * `properties.notion_id`, or a 32-hex / dashed UUID in `source_url` (dashes stripped).
 */
export function extractNotionPageId(person: {
	source_url?: string | null;
	properties?: Record<string, unknown> | null;
}): string | null {
	if (typeof person.properties?.notion_page_id === "string") {
		return person.properties.notion_page_id;
	}
	if (typeof person.properties?.notion_id === "string") {
		return person.properties.notion_id;
	}
	if (person.source_url) {
		const match = person.source_url.match(
			/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
		);
		if (match) return match[1].replace(/-/g, "");
	}
	return null;
}
