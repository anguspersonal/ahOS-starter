import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { STATE_DOC_LINK_KIND } from "../../domain/vocab.js";
import type {
	DailyLogQueueEntry,
	ExternalLinkRepository,
} from "../../ports/externalLinks.js";
import { defineAction } from "../defineAction.js";

export const dosDailyLogQueueInput = {
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Whose queue: 'work' or 'angus'. There is one Daily Log per domain (ADR-051 §11) and one State Doc per domain (ADR-054 §9), so the attended ritual asks per domain. Matched on the twin's `daily_log` pointer provider. Omitted, every domain's twins are listed together, plus any twin with no pointer at all (the one read that can show those).",
		),
	include_consumed: z
		.boolean()
		.optional()
		.describe(
			"Also list twins that already carry a `consumed_by_state` row (folded into the State Doc). Defaults to false: the queue is what the State Doc has NOT absorbed. Set true for an audit of every twin.",
		),
} as const;

export const getDailyLogQueueInput = dosDailyLogQueueInput;

export const dosDailyLogQueueSchema = z.object(dosDailyLogQueueInput);

export type DosDailyLogQueueInput = z.infer<typeof dosDailyLogQueueSchema>;

export interface DosDailyLogQueueOutput {
	domain?: Domain;
	include_consumed: boolean;
	entries: DailyLogQueueEntry[];
}

export const DOS_DAILY_LOG_QUEUE_DESCRIPTION =
	"Every Daily Log twin the State Doc has not yet absorbed \u2014 the second half of an attended dos " +
	"session's standing read. Catch-up is only ever over these logs, never over atoms: miss a week " +
	"and the review is five logs, not two hundred atoms. Full notes: " +
	"docs/guides/tools/dos_daily_log_queue.md";

function status(e: DailyLogQueueEntry): string {
	if (e.consumed_by_state) return `folded into state doc ${e.consumed_by_state}`;
	if (e.conflicting_providers.length) {
		return `POINTER CONFLICT (daily_log pointers under ${e.conflicting_providers.join(" and ")}; unattributable)`;
	}
	if (e.page_id === null) return "NO PAGE POINTER (twin write was cut short; cannot be promoted)";
	if (e.markers === "none") return "NO SYNTHESIS MARKERS (its atoms were never marked; half-written)";
	if (e.markers === "unattended") return "UNCONFIRMED (swept draft, #561)";
	return "confirmed";
}

function line(e: DailyLogQueueEntry): string {
	return [
		e.date ?? "(no date)",
		e.domain ?? "(no domain)",
		status(e),
		e.page_id ? `page ${e.page_id}` : "",
		e.title ? `"${e.title}"` : "(untitled)",
		`twin ${e.artifact_id}`,
	]
		.filter(Boolean)
		.join("  ");
}

export function formatDosDailyLogQueueMcp(output: DosDailyLogQueueOutput): string {
	const { domain, include_consumed, entries } = output;
	const queued = entries.filter((e) => e.consumed_by_state === null);
	const drafts = queued.filter((e) => e.markers === "unattended").length;
	const unmarked = queued.filter((e) => e.page_id !== null && e.markers === "none").length;
	const conflicts = queued.filter((e) => e.conflicting_providers.length > 0).length;
	const pointerless = queued.filter(
		(e) => e.page_id === null && e.conflicting_providers.length === 0,
	).length;
	const scope = domain ? `domain: ${domain}` : "all domains (no domain given)";

	return [
		`daily-log queue, ${scope}, oldest first: twins with no '${STATE_DOC_LINK_KIND}' row${include_consumed ? " (consumed twins included, marked)" : ""}:`,
		"",
		entries.length ? entries.map(line).join("\n") : "(none)",
		"",
		`${queued.length} log(s) not yet folded into the State Doc; ${drafts} unconfirmed swept drafts; ${unmarked} with no synthesis markers; ${pointerless} with no page pointer; ${conflicts} unattributable (pointer conflict).`,
		"A log leaves this queue when the attended ritual folds it into the State Doc and, on the owner's approval, stamps",
		`'${STATE_DOC_LINK_KIND}' on the TWIN (artifact_id = the twin, external_id = the State Doc page id). Never on the atoms: they were consumed at hop 1, by the log.`,
		"Status is derived from the synthesis and evidence-closing markers pointing at the page and stored nowhere: confirmed (synthesized or evidence_aggregated present), UNCONFIRMED (only synthesized_unattended or evidence_aggregated_unattended), or NO SYNTHESIS MARKERS (nothing stamped; an attended run whose marker writes failed). Promotion is INSERT-only.",
		domain
			? "Scoped: only twins whose pointer names this domain's provider. A twin with no pointer cannot be attributed and is listed only by the unscoped read."
			: "Unscoped: twins from every domain, and any twin with no pointer at all.",
		"",
		"```json",
		JSON.stringify(entries),
		"```",
	].join("\n");
}

export function createDosDailyLogQueueAction(repo: ExternalLinkRepository) {
	return defineAction({
		id: "dos_daily_log_queue",
		domain: "ops",
		description: DOS_DAILY_LOG_QUEUE_DESCRIPTION,
		schema: dosDailyLogQueueSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<DosDailyLogQueueOutput> => {
			const includeConsumed = args.include_consumed ?? false;
			const entries = await repo.getDailyLogQueue(args.domain, includeConsumed);
			return {
				...(args.domain !== undefined ? { domain: args.domain } : {}),
				include_consumed: includeConsumed,
				entries,
			};
		},
		formatMcp: formatDosDailyLogQueueMcp,
	});
}
