import {
	loadIntegrationConfig,
	notionPersonalConfigSchema,
	type CompletedAtStampRule,
} from "../integrations.js";
import { getCredential } from "../credentials.js";
import {
	retrieveNotionPage,
	updateNotionPageProperties,
	queryNotionDataSource,
	type NotionPage,
} from "../notion.js";

// Rule v0 of the Notion automations capability (#546 / ADR-048): keep the personal
// Tasks DB's `Completed at` column truthful about CURRENT state.
//
//   Status ∈ done_values  AND  Completed at empty  → stamp it (source timestamp)
//   Status ∉ done_values  AND  Completed at set    → clear it (a re-done task gets
//                                                    a fresh stamp later)
//
// Both branches are idempotent no-ops when the column is already correct, which is
// what terminates the loop our own PATCH would otherwise start: the PATCH fires a
// fresh page.properties_updated event, that event re-evaluates to "none", done.
//
// Two entry points share this logic: the webhook fast path
// (handleNotionPagePropertiesUpdated, stamping from the EVENT timestamp — when the
// change happened, not when we processed it) and the daily reconciliation sweep
// (sweepCompletedAtDrift, stamping best-effort from page.last_edited_time).

export const SETUP_HINT =
	"notion automations: completed_at_stamp not configured — call integration_set " +
	"{ provider: 'notion_personal', config: { automations: { completed_at_stamp: " +
	"{ data_source_id, status_property, done_values, completed_at_property } } } } to enable it";

/**
 * Load the completed_at_stamp rule from the owner's notion_personal integration
 * row, or null (with a setup hint on stderr) when it isn't configured. Config is
 * runtime-loaded per event/sweep so there are no hardcoded ids anywhere in source.
 */
export async function loadCompletedAtStampRule(): Promise<CompletedAtStampRule | null> {
	const config = await loadIntegrationConfig(
		"notion_personal",
		notionPersonalConfigSchema,
	);
	const rule = config?.automations?.completed_at_stamp;
	if (!rule) {
		console.error(SETUP_HINT);
		return null;
	}
	return rule;
}

/** Compare two Notion ids ignoring dash formatting and case. */
function sameNotionId(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const norm = (id: string) => id.replaceAll("-", "").toLowerCase();
	return norm(a) === norm(b);
}

/** Whether a page belongs to the rule's configured data source. */
export function pageInDataSource(
	page: NotionPage,
	rule: CompletedAtStampRule,
): boolean {
	return (
		sameNotionId(page.parent?.data_source_id, rule.data_source_id) ||
		// Tolerate a config keyed by the legacy database id (single-source DBs share it).
		sameNotionId(page.parent?.database_id, rule.data_source_id)
	);
}

/**
 * Whether the event touched the rule's status property. Webhook
 * `updated_properties` carries property IDs only (URL-encoded, e.g. "XGe%40"),
 * so match against the retrieved page's property id, decoded and raw.
 */
export function statusPropertyUpdated(
	page: NotionPage,
	rule: CompletedAtStampRule,
	updatedPropertyIds: string[],
): boolean {
	const statusId = page.properties?.[rule.status_property]?.id;
	if (!statusId) return false;
	const decode = (id: string): string => {
		try {
			return decodeURIComponent(id);
		} catch {
			return id;
		}
	};
	return updatedPropertyIds.some(
		(id) => id === statusId || decode(id) === statusId,
	);
}

export type CompletedAtDecision =
	| { action: "stamp"; timestamp: string }
	| { action: "clear" }
	| { action: "none"; reason: "already-stamped" | "already-clear" };

/**
 * Pure decision core, shared by webhook and sweep. Reads the page's status name
 * and completed-at date by configured property NAME and returns what (if
 * anything) to write. "none" on both branches is the loop terminator.
 */
export function decideCompletedAt(
	page: NotionPage,
	rule: CompletedAtStampRule,
	sourceTimestamp: string,
): CompletedAtDecision {
	const statusName = page.properties?.[rule.status_property]?.status?.name ?? null;
	const done = statusName !== null && rule.done_values.includes(statusName);
	const completedAt =
		page.properties?.[rule.completed_at_property]?.date?.start ?? null;

	if (done) {
		return completedAt
			? { action: "none", reason: "already-stamped" }
			: { action: "stamp", timestamp: sourceTimestamp };
	}
	return completedAt
		? { action: "clear" }
		: { action: "none", reason: "already-clear" };
}

export type AppliedAction = "stamped" | "cleared" | "noop";

/** Execute a decision against Notion. No-op decisions never touch the API. */
async function applyDecision(
	pageId: string,
	decision: CompletedAtDecision,
	rule: CompletedAtStampRule,
	token: string,
): Promise<AppliedAction> {
	if (decision.action === "stamp") {
		await updateNotionPageProperties(
			pageId,
			{ [rule.completed_at_property]: { date: { start: decision.timestamp } } },
			token,
		);
		return "stamped";
	}
	if (decision.action === "clear") {
		await updateNotionPageProperties(
			pageId,
			{ [rule.completed_at_property]: { date: null } },
			token,
		);
		return "cleared";
	}
	return "noop";
}

/** The slice of a `page.properties_updated` webhook event the rule consumes. */
export type NotionPagePropertiesUpdatedEvent = {
	timestamp?: string;
	entity?: { id?: string; type?: string };
	data?: { updated_properties?: string[] };
};

export type WebhookRuleOutcome =
	| "unconfigured"
	| "ignored-no-page"
	| "ignored-other-data-source"
	| "ignored-status-unchanged"
	| AppliedAction;

/**
 * Webhook fast path: evaluate one `page.properties_updated` event. The payload
 * carries property IDs but no values (and its `parent` may be the workspace, not
 * the database), so the page is retrieved first; every gate — data-source match,
 * status-property-touched, decision — is then evaluated against real values.
 */
export async function handleNotionPagePropertiesUpdated(
	event: NotionPagePropertiesUpdatedEvent,
): Promise<WebhookRuleOutcome> {
	const pageId = event.entity?.id;
	if (!pageId) return "ignored-no-page";

	const rule = await loadCompletedAtStampRule();
	if (!rule) return "unconfigured";

	const token = await getCredential("notion_personal");
	const page = await retrieveNotionPage(pageId, token);

	if (!pageInDataSource(page, rule)) return "ignored-other-data-source";

	const updated = event.data?.updated_properties;
	if (updated && !statusPropertyUpdated(page, rule, updated)) {
		// Includes the event our own completed-at PATCH fires (it updates only the
		// date property) — second layer of loop termination on top of the no-op
		// decision branches.
		return "ignored-status-unchanged";
	}

	// Stamp from the EVENT timestamp — when the change happened in Notion, not
	// when this process got around to it. Fallback covers a malformed payload.
	const sourceTimestamp = event.timestamp ?? new Date().toISOString();
	const decision = decideCompletedAt(page, rule, sourceTimestamp);
	return applyDecision(page.id, decision, rule, token);
}

export type SweepCounts = {
	scanned: number;
	stamped: number;
	cleared: number;
	unchanged: number;
	errors: number;
};

/**
 * Reconciliation sweep (correctness net for webhook gaps): walk the configured
 * data source and converge every page — Done + empty → stamp from
 * `last_edited_time` (best effort; the true completion moment is gone), not-Done +
 * set → clear. Returns null (after the setup hint) when the rule isn't configured.
 * Per-page write failures are counted, never abort the sweep.
 */
export async function sweepCompletedAtDrift(): Promise<SweepCounts | null> {
	const rule = await loadCompletedAtStampRule();
	if (!rule) return null;

	const token = await getCredential("notion_personal");
	const counts: SweepCounts = {
		scanned: 0,
		stamped: 0,
		cleared: 0,
		unchanged: 0,
		errors: 0,
	};

	let cursor: string | undefined;
	do {
		const { results, next_cursor, has_more } = await queryNotionDataSource(
			rule.data_source_id,
			token,
			{ cursor },
		);
		for (const page of results) {
			if (page.archived) continue;
			counts.scanned += 1;
			const decision = decideCompletedAt(
				page,
				rule,
				page.last_edited_time ?? new Date().toISOString(),
			);
			try {
				const applied = await applyDecision(page.id, decision, rule, token);
				if (applied === "stamped") counts.stamped += 1;
				else if (applied === "cleared") counts.cleared += 1;
				else counts.unchanged += 1;
			} catch (err) {
				counts.errors += 1;
				console.error(
					`completed_at_stamp sweep: page ${page.id} update failed:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		cursor = has_more ? (next_cursor ?? undefined) : undefined;
	} while (cursor);

	return counts;
}
