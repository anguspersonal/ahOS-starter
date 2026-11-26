import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	reachabilityError,
	resolveDailyLogTarget,
	type DailyLogTarget,
} from "../../domain/dailyLogTarget.js";
import {
	COVERS_ROLE,
	coversGuardFilter,
	coversType,
	coversValue,
	effectiveCovers,
	normalizeCovers,
	type CoversType,
} from "../../domain/dailyLogCovers.js";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { dailyLogRoleProperty, domainConfig, loadDosConfig } from "../../domain/dosConfig.js";
import {
	assertOptionsMatchSchema,
	assertPropertiesMatchSchema,
	describeProperties,
	resolveTitleProperty,
	DatabasePropertiesMissingError,
	requireDatabaseProperties,
	type RawDatabaseProperties,
	type NotionDatabaseSchema,
} from "../notion/schemaGuard.js";
import { markdownToBlocks, type BlockPayload } from "../notion/blocks.js";
import {
	PILLARS_ROLE,
	ROLES,
	assertOption,
	resolveRole,
} from "../records/propertyRoles.js";
import { DAILY_LOG_CONTENT_SUBTYPE, DAILY_LOG_LINK_KIND } from "../../domain/vocab.js";
import type { ArtifactRepository, CapturePort } from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { ExternalLinkRepository } from "../../ports/externalLinks.js";
import type { NotionPort } from "../../ports/notion.js";

// The Daily Log's writer (#674, ADR-051 §11, ADR-054 §6/§9).
//
// Before this tool, ahKMS exposed exactly two Notion page writers — task_create and
// state_doc_update — and neither can name a destination, so the Daily Log was written
// by whatever Notion connector the calling surface happened to carry. That makes the
// write path depend on the surface, which is the failure ADR-054 §6 names for
// destinations, and it left the `angus` domain unwritable by any route: a day could
// close its State Doc and not its Daily Log, so the `synthesized` marker (ADR-050 §6)
// had no object to point at, and `external_id` is NOT NULL.
//
// Three things this tool is deliberately NOT:
//  - It is not the marker's source of truth. It may set a marker PROPERTY, but the
//    ledger write stays external_link_create; the direction is ahKMS → Notion, never
//    the reverse (ADR-051 §11). The `daily_log` link it writes under `write_twin`
//    (#2258, ADR-051 Amendment 6) is the twin's POINTER to its page, not a marker.
//  - It does not decide whether a log should exist. "Nothing captured, no log" is the
//    caller's call — this tool cannot conjure an empty entry, because `title` and
//    `date` are required of the caller and neither is defaulted.
//  - It does not bake a schema in; it reads the declared schema from
//    dos_config.daily_log_schema for the domain and enforces what the config calls
//    required (#1139). Property names are validated against a live read of the
//    destination, because the two Daily Logs genuinely differ and baking either
//    one in is what ADR-054 §6 forbids.

/** Notion accepts at most 100 child blocks per create/append call. */
const CHILDREN_PER_CALL = 100;

/** The pointer write is tried this many times before the twin is compensated (#2258). */
const POINTER_ATTEMPTS = 2;

/** `artifacts.surface` on the twin, the value Step 8b has always passed (#562). */
const TWIN_SURFACE = "dos";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when a supplied property value is present (not undefined/null) but its
 * Notion-shape payload is empty for its type — e.g. `{ select: null }`,
 * `{ multi_select: [] }`, `{ rich_text: [] }`, `{ checkbox: undefined }`. Without
 * this, `{ "Synthesis Status": { select: null } }` satisfies a `required: true`
 * check that only tests the outer value, and Notion writes a property that reads
 * exactly as blank as the entries #1139 is about (round-1 QA finding).
 */
function isEmptyPropertyValue(val: unknown): boolean {
	if (val === undefined || val === null) return true;
	if (typeof val !== "object") return false;
	const inner = Object.values(val as Record<string, unknown>)[0];
	if (inner === undefined || inner === null) return true;
	if (Array.isArray(inner)) return inner.length === 0;
	if (typeof inner === "string") return inner.trim().length === 0;
	return false;
}

export const createDailyLogEntryInput = {
	// Every required field is `.optional()` at the zod level and enforced by a guard in
	// the handler instead — the same deliberate shape as state_doc_update. A hard-required
	// field here would let the MCP SDK's own validateToolInput reject a malformed call
	// with a generic "Required" BEFORE the handler runs, burying the explanatory error
	// for exactly the caller it exists to help. A WRONG enum member still fails schema
	// validation; only *missing* is meant to fall through.
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which Daily Log to write: 'work' (the Work workspace) or 'angus' (the personal workspace). Each resolves its own database pointer AND its own Notion token — there is no default, because a destination that defaults silently is one that will one day be wrong (ADR-054 §9).",
		),
	date: z
		.string()
		.optional()
		.describe(
			"Required. The day this entry is written for, YYYY-MM-DD. Written to the destination's date property. The duplicate guard keys on the days the entry COVERS (see `covers`), and an entry with no declared covers covers its own date.",
		),
	covers: z
		.array(z.string())
		.optional()
		.describe(
			"The days this entry accounts for, YYYY-MM-DD each (#1016): the distinct `captured_at` dates of every atom the dos ritual stamps with this entry's page. Written to the Daily Log property that domain's dos config declares with role 'covers', and the duplicate guard refuses the write when an existing entry already covers one of them. Omitted means [date], a run that closes its own day. Ignored, with a note, when the config declares no Covers property.",
		),
	pillars: z
		.array(z.string())
		.optional()
		.describe(
			"The pillar objectives to record for this entry. Written to the Daily Log property that domain's dos config declares with role 'pillars'. Refused if the config declares no property with role 'pillars' (pillars → none declared; write none).",
		),
	title: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Required. The entry's title. It is written to whichever property the destination declares as its title property, discovered by introspection — you never name that property.",
		),
	body: z
		.string()
		.optional()
		.describe(
			"The entry's page body, one block per line. '## ' becomes a heading, '- ' / '* ' bullets, '- [ ]' / '- [x]' to-dos, '1. ' numbered items, '> ' quotes; anything else is a paragraph. Inline markdown ([label](url), **bold**, *italic*, `code`, ~~strikethrough~~) is parsed into Notion rich_text runs. Long lines are split across rich-text runs rather than rejected.",
		),
	properties: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Extra Notion property values, keyed by the destination's own property NAME, in real Notion REST shapes — a date is {'date': {'start': '2026-08-21'}}, a checkbox {'checkbox': true}, a select {'select': {'name': 'Daily'}}, a multi-select {'multi_select': [{'name': 'Ops'}]}, rich text {'rich_text': [{'text': {'content': '...'}}]}. These are NOT the claude.ai Notion connector's conventions: no __YES__/__NO__, no 'date:Date:start', no JSON-string arrays. Every name is validated against a live read of the destination before anything is written, and an unknown one is an error listing the valid names.",
		),
	date_property: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Which property `date` is written to. Only needed when the destination has zero or more than one date property — with exactly one, it is discovered by introspection.",
		),
	allow_duplicate: z
		.boolean()
		.optional()
		.describe(
			"Write even though an entry already covers one of these days (#673, #1016). Off by default: the duplicate guard runs whenever that domain's daily_log_data_source_id is configured, and refuses with the existing page's id rather than silently creating a second entry for one day. On refusal, twin_present indicates whether the clashing page has an ahKMS Daily Log twin (#721).",
		),
	write_twin: z
		.boolean()
		.default(false)
		.describe(
			"Also write this entry's ahKMS twin and its `daily_log` pointer, in this call, after the page (#2258): page, then twin, then pointer, returning twin_artifact_id. Off by default, and off means exactly the old behaviour (no twin, no pointer). Pass true only from a ritual that no longer writes the twin itself with capture and external_link_create, or the entry gets two twins. A twin or pointer failure never fails the page: the reply carries a `twin: MISSING` warning instead.",
		),
} as const;

type CreateDailyLogEntryArgs = z.infer<z.ZodObject<typeof createDailyLogEntryInput>>;

/**
 * What the handler accepts. Wider than the tool's schema for the reason given on the
 * schema itself: the required fields are enforced here so their errors are the ones a
 * malformed call actually sees.
 */
export type CreateDailyLogEntryCall = Partial<CreateDailyLogEntryArgs>;

function requireDomain(args: CreateDailyLogEntryCall): Domain {
	if (!args.domain) {
		throw new Error(
			"`domain` is required — 'work' (the Work Daily Log) or 'angus' (the personal one). There is no default: each domain is a different database in a different Notion workspace behind a different token.",
		);
	}
	return args.domain;
}

function requireDate(args: CreateDailyLogEntryCall): string {
	if (!args.date) {
		throw new Error(
			"`date` is required — the day this entry is for, YYYY-MM-DD. It is deliberately not defaulted to today: the unattended fallback sweep (#561) runs for days that are already past, and an entry filed under the wrong day is worse than one that was never written.",
		);
	}
	if (!ISO_DATE.test(args.date)) {
		throw new Error("`date` must be YYYY-MM-DD, got '" + args.date + "'.");
	}
	return args.date;
}

function requireTitle(args: CreateDailyLogEntryCall): string {
	if (!args.title) {
		throw new Error("`title` is required — the Daily Log entry's title.");
	}
	return args.title;
}

/** The destination's title property, discovered rather than assumed. */

/**
 * Which property the date goes on. Discovered when unambiguous, demanded when not — an
 * entry filed against the wrong date property is invisible to both the tail read and
 * the duplicate guard, so guessing between two candidates is not on.
 */
function resolveDateProperty(
	schema: NotionDatabaseSchema,
	explicit: string | undefined,
	databaseId: string,
): string {
	if (explicit) {
		const hit = schema.properties.find((p) => p.name === explicit);
		if (!hit) {
			throw new Error(
				"date_property '" +
					explicit +
					"' is not a property of Notion database " +
					databaseId +
					". Its properties are: " +
					describeProperties(schema),
			);
		}
		if (hit.type !== "date") {
			throw new Error(
				"date_property '" + explicit + "' is of type '" + hit.type + "', not 'date'.",
			);
		}
		return explicit;
	}

	const dates = schema.properties.filter((p) => p.type === "date");
	if (dates.length === 1) return dates[0].name;
	if (dates.length === 0) {
		throw new Error(
			"Notion database " +
				databaseId +
				" has no date property, so a Daily Log entry cannot be addressed by day. Its properties are: " +
				describeProperties(schema),
		);
	}
	throw new Error(
		"Notion database " +
			databaseId +
			" has " +
			dates.length +
			" date properties (" +
			dates.map((p) => p.name).join(", ") +
			"), so `date` is ambiguous. Pass date_property to name the one this entry is filed under.",
	);
}

/**
 * Refuse a second entry for a day that already has one (#673).
 *
 * The attended ritual has never had this guard and the unattended sweep implements it
 * as skill prose; putting it at the tool boundary closes it for both domains and both
 * paths at once. It needs the data source id, so it is skipped — visibly, in the
 * response — when only the database id is wired.
 */
/**
 * Thrown when createDailyLogEntry refuses to write because an entry already exists
 * or already covers the requested dates (#673, #1016).
 *
 * `twin_present` indicates whether any clashing Notion page has a matching ahKMS
 * Daily Log twin link in `artifact_external_links` (`kind = 'daily_log'`) (#721).
 */
export class DailyLogDuplicateRefusalError extends Error {
	readonly twin_present: boolean;
	readonly existing_page_ids: string[];

	constructor(message: string, twinPresent: boolean, existingPageIds: string[]) {
		super(message);
		this.name = "DailyLogDuplicateRefusalError";
		this.twin_present = twinPresent;
		this.existing_page_ids = existingPageIds;
	}
}

export interface DailyLogTwinLookup {
	hasDailyLogTwin?(pageIds: string[]): Promise<boolean>;
}

/**
 * What `write_twin: true` writes through (#2258, ADR-051 Amendment 6). Capture stays the
 * only artifact writer and `recordExternalLink` the only link writer; this tool sequences
 * them, it does not reimplement either.
 */
export interface DailyLogTwinWritePorts {
	capture: Pick<CapturePort, "capture">;
	links: Pick<ExternalLinkRepository, "recordExternalLink">;
	artifacts: Pick<ArtifactRepository, "mutateByIds">;
}

export interface DailyLogCreatePorts {
	notion: NotionPort;
	config: Pick<ConfigRepository, "loadConfigDetailed" | "loadDosConfigRow">;
	externalLinks?: (Pick<ExternalLinkRepository, "getDailyLogQueue"> & DailyLogTwinLookup) | DailyLogTwinLookup;
	/** Optional: absent, a `write_twin: true` call still writes the page and warns `twin: MISSING`. */
	twin?: DailyLogTwinWritePorts;
}

export interface DailyLogCreateResult {
	id: string;
	url: string;
	domain: Domain;
	provider: string;
	title: string;
	date: string;
	covers?: string[];
	pillars?: string[];
	blocksWritten: number;
	/** The twin this call wrote AND pointed at the page. Only ever set under `write_twin: true` (#2258). */
	twin_artifact_id?: string;
	text: string;
}

function toDatabaseSchema(raw: RawDatabaseProperties): NotionDatabaseSchema {
	const rawProperties = raw as Record<string, Record<string, any>>;
	const properties = Object.keys(rawProperties).map((name) => {
		const prop = rawProperties[name];
		const type = (prop?.type as string | undefined) ?? "unknown";
		const optionsHolder =
			type === "select"
				? prop?.select
				: type === "multi_select"
					? prop?.multi_select
					: type === "status"
						? prop?.status
						: undefined;
		const rawOptions: Array<{ name?: string }> | undefined =
			optionsHolder?.options ?? (Array.isArray(prop?.options) ? prop.options : undefined);
		const options = rawOptions?.map((o) => o?.name).filter((n): n is string => Boolean(n));
		return {
			name,
			type,
			...(options && options.length > 0 ? { options } : {}),
		};
	});
	return { properties };
}

/**
 * Look up whether any of the given Notion page IDs has an ahKMS Daily Log twin
 * link (`kind = 'daily_log'`) in `artifact_external_links` (#721).
 */
async function checkTwinPresent(
	pageIds: string[],
	domain: Domain,
	externalLinks?: DailyLogCreatePorts["externalLinks"],
): Promise<boolean> {
	if (pageIds.length === 0 || !externalLinks) return false;
	try {
		if (typeof externalLinks.hasDailyLogTwin === "function") {
			return await externalLinks.hasDailyLogTwin(pageIds);
		}
		if ("getDailyLogQueue" in externalLinks && typeof externalLinks.getDailyLogQueue === "function") {
			const entries = await externalLinks.getDailyLogQueue(domain, true);
			const wanted = new Set(pageIds);
			return entries.some((e) => e.page_id !== null && wanted.has(e.page_id));
		}
		return false;
	} catch (err) {
		if (err instanceof Error && err.name === "AdapterUnavailableError") return false;
		// Fail closed (not-recovering), but LOUDLY: unlike a read-path fallback such as
		// `getExternalLinks`'s `[]`-on-error, this false is what tells the caller "no twin -
		// stop the domain, the day was never closed" (#721). A real query failure (RLS
		// misconfig, transient network error) must not read identically to a genuine
		// foreign-entry case in the logs (qa-review round 1 low finding).
		console.error(
			`checkTwinPresent: artifact_external_links query failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

async function assertNoExistingEntry(
	target: DailyLogTarget,
	dateProperty: string,
	date: string,
	domain: Domain,
	ports: DailyLogCreatePorts,
): Promise<string | null> {
	const dataSourceId = target.dataSourceId;
	if (!dataSourceId) {
		return (
			"No duplicate guard ran: daily_log_data_source_id is unset for domain '" +
			domain +
			"', so this tool could not ask Notion whether " +
			date +
			" already has an entry (#673)."
		);
	}

	const existing = await ports.notion
		.queryDataSource({
			workspace: domain,
			dataSourceId,
			filter: { property: dateProperty, date: { equals: date } },
			pageSize: 5,
		})
		.catch((err) => {
			throw reachabilityError(domain, dataSourceId, err);
		});

	if (existing.results.length > 0) {
		const pageIds = existing.results.map((p) => p.id);
		const twinPresent = await checkTwinPresent(pageIds, domain, ports.externalLinks);
		throw new DailyLogDuplicateRefusalError(
			[
				"Domain '" +
					domain +
					"' already has a Daily Log entry for " +
					date +
					" (" +
					pageIds.join(", ") +
					"). Nothing was written.",
				"twin_present: " + twinPresent,
				"Edit that entry, or pass allow_duplicate: true if a second entry for the day is genuinely what you want (#673).",
			].join("\n"),
			twinPresent,
			pageIds,
		);
	}

	return null;
}

/** The Covers property this write can use, or why it cannot (a note, never a failure). */
type CoversTarget = { name: string; type: CoversType } | { note: string };

/**
 * Resolve the Covers property: named by that domain's dos config (role 'covers'), and
 * present on the live database with a type that can carry dates.
 *
 * Every miss DEGRADES to the pre-#1016 behaviour (guard on Date, no Covers written) with
 * a note, rather than failing the write. This tool is on the unattended sweep's path,
 * and a config migration pushed before the Notion property exists must not stop every
 * night's Daily Log; an entry with an empty Covers reads as covering its own Date,
 * which is exactly what that fallback wrote anyway.
 */
async function resolveCoversTarget(
	domain: Domain,
	schema: NotionDatabaseSchema,
	callerNamedCovers: boolean,
	ports: DailyLogCreatePorts,
): Promise<CoversTarget | null> {
	const name = await loadDosConfig(ports.config)
		.then((config) => dailyLogRoleProperty(domainConfig(config, domain), COVERS_ROLE))
		.catch(() => null);

	if (!name) {
		return callerNamedCovers
			? {
					note:
						"Covers not written: domain '" +
						domain +
						"''s dos config declares no Daily Log property with role 'covers', so this entry reads as covering its own date and the duplicate guard keyed on that (#1016).",
				}
			: null;
	}

	const type = coversType(schema, name);
	if (!type) {
		return {
			note:
				"Covers not written: dos config declares '" +
				name +
				"' (role 'covers') for domain '" +
				domain +
				"', but on the live Daily Log it is not a rich_text or multi_select property. The entry reads as covering its own date. Add the property in Notion or fix the config (#1016).",
		};
	}
	return { name, type };
}

/**
 * Refuse an entry for a day another entry already covers (#673, keyed per #1016).
 *
 * A same-Date entry whose Covers names OTHER days is not a clash: that is the catch-up
 * page dated 5 Sep whose markers sit on 28 Aug and 4 Sep, which used to hold 5 Sep
 * against the sweep for good.
 */
async function assertNoEntryCovers(
	target: DailyLogTarget,
	covers: { name: string; type: CoversType },
	dateProperty: string,
	days: string[],
	domain: Domain,
	ports: DailyLogCreatePorts,
): Promise<string | null> {
	const dataSourceId = target.dataSourceId;
	if (!dataSourceId) {
		return (
			"No duplicate guard ran: daily_log_data_source_id is unset for domain '" +
			domain +
			"', so this tool could not ask Notion whether " +
			days.join(", ") +
			" already has an entry (#673)."
		);
	}

	const existing = await ports.notion
		.queryDataSource({
			workspace: domain,
			dataSourceId,
			filter: coversGuardFilter(covers.name, covers.type, dateProperty, days),
			pageSize: 100,
		})
		.catch((err) => {
			throw reachabilityError(domain, dataSourceId, err);
		});

	const wanted = new Set(days);
	const clashingPages: { pageId: string; day: string }[] = [];
	for (const page of existing.results) {
		for (const d of effectiveCovers(page, covers.name, dateProperty)) {
			if (wanted.has(d)) {
				clashingPages.push({ pageId: page.id, day: d });
			}
		}
	}

	if (clashingPages.length > 0) {
		const clashes = clashingPages.map((c) => c.day + " (" + c.pageId + ")");
		const clashingPageIds = [...new Set(clashingPages.map((c) => c.pageId))];
		const twinPresent = await checkTwinPresent(clashingPageIds, domain, ports.externalLinks);
		throw new DailyLogDuplicateRefusalError(
			[
				"Domain '" +
					domain +
					"': an existing Daily Log entry already covers " +
					clashes.join(", ") +
					". Nothing was written.",
				"twin_present: " + twinPresent,
				"An entry covers the days its '" +
					covers.name +
					"' property lists, or its own date when that is empty (#1016). Drop those days from `covers`, edit that entry, or pass allow_duplicate: true if a second entry for the day is genuinely what you want (#673).",
			].join("\n"),
			twinPresent,
			clashingPageIds,
		);
	}

	return null;
}

export const dailyLogCreateSchema = z.object(createDailyLogEntryInput);

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function twinMissing(pageId: string, detail: string): string {
	return (
		"\nWARNING: twin: MISSING \u2014 Daily Log page " +
		pageId +
		" was created, but " +
		detail +
		" Nothing heals this on a later call (#2258)."
	);
}

type TwinOutcome = { artifactId: string } | { warning: string };

/**
 * Write the entry's ahKMS twin, then the twin's `daily_log` pointer (#2258, ADR-051
 * Amendment 6).
 *
 * Notion and Postgres share no transaction, so this is a sequence with compensation,
 * not an atomic write. The state it exists to prevent is a twin with no pointer: such a
 * twin belongs to no domain, is unpromotable, and is invisible to every scoped read. So
 * when the pointer cannot be written, the twin this call created is soft-archived and
 * the caller is left with "page, no twin", which is already a reported state.
 *
 * Never throws: the page exists by the time this runs, and a thrown error would read as
 * "nothing was written" to a caller that then writes a second page.
 */
async function writeTwin(
	twin: DailyLogTwinWritePorts | undefined,
	entry: {
		pageId: string;
		pageUrl: string;
		provider: string;
		title: string;
		body: string;
		date: string;
		pillars: string[];
	},
	userId: string | undefined,
): Promise<TwinOutcome> {
	if (!twin) {
		return {
			warning: twinMissing(
				entry.pageId,
				"this server has no twin write ports wired, so no twin and no pointer were written.",
			),
		};
	}
	if (entry.body.trim().length === 0) {
		return {
			warning: twinMissing(
				entry.pageId,
				"the entry has no body and a twin cannot be captured without text, so no twin and no pointer were written.",
			),
		};
	}

	let captured: { id: string; deduplicated: boolean };
	try {
		captured = await twin.capture.capture(
			{
				title: entry.title,
				text: entry.body,
				content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				// The day the entry NARRATES, never the day it is written: for a swept day
				// the two are up to seven days apart (#562).
				captured_at: entry.date,
				surface: TWIN_SURFACE,
				processing_metadata: { pillars: entry.pillars },
			},
			userId,
		);
	} catch (err) {
		return {
			warning: twinMissing(
				entry.pageId,
				"the twin capture failed, so no pointer was attempted: " + errorText(err) + ".",
			),
		};
	}

	let pointerError = "";
	for (let attempt = 0; attempt < POINTER_ATTEMPTS; attempt++) {
		try {
			const written = await twin.links.recordExternalLink(captured.id, {
				kind: DAILY_LOG_LINK_KIND,
				provider: entry.provider,
				external_id: entry.pageId,
				external_url: entry.pageUrl,
			});
			if (written.ok) return { artifactId: captured.id };
			pointerError = written.error ?? "the link write reported failure";
		} catch (err) {
			pointerError = errorText(err);
		}
	}

	const repair =
		" Repair: attach the pointer with external_link_create (kind '" +
		DAILY_LOG_LINK_KIND +
		"', provider '" +
		entry.provider +
		"', external_id " +
		entry.pageId +
		").";

	// Compensation covers only a twin THIS call created. A deduplicated capture returned
	// an earlier write's row, and archiving that would destroy something this call does
	// not own.
	if (captured.deduplicated) {
		return {
			warning: twinMissing(
				entry.pageId,
				"its pointer is missing on the EXISTING twin " +
					captured.id +
					" (capture matched an earlier artifact, which was left as it is): " +
					pointerError +
					"." +
					repair,
			),
		};
	}

	// An archive that matches no row resolves with an empty list and no error (the
	// repository filters on its own owner id), so "did not throw" is not "archived".
	// Only a returned row for this twin proves the compensation landed.
	let archiveError = "";
	try {
		const archived = await twin.artifacts.mutateByIds(
			[captured.id],
			true,
			"daily_log_create: pointer write to page " + entry.pageId + " failed, twin compensated (#2258)",
		);
		if (!archived.some((row) => row.id === captured.id)) archiveError = "the archive matched no row";
	} catch (err) {
		archiveError = errorText(err);
	}
	if (archiveError) {
		return {
			warning: twinMissing(
				entry.pageId,
				"the pointer write failed " +
					POINTER_ATTEMPTS +
					" times (" +
					pointerError +
					") and archiving twin " +
					captured.id +
					" failed too (" +
					archiveError +
					"), so that twin is live with NO pointer." +
					repair,
			),
		};
	}

	return {
		warning: twinMissing(
			entry.pageId,
			"the pointer write failed " +
				POINTER_ATTEMPTS +
				" times (" +
				pointerError +
				"), so twin " +
				captured.id +
				" was archived (reversible) rather than left with no pointer.",
		),
	};
}

/**
 * Create one Daily Log entry in the domain's Notion workspace.
 *
 * Everything checkable is checked before the first write: the domain resolves, the
 * destination is reachable, its title and date properties are discovered, every
 * caller-supplied property name exists, and the day has no entry yet. A bad call
 * therefore costs one or two reads and changes nothing.
 */
async function runDailyLogCreate(
	args: CreateDailyLogEntryCall,
	ports: DailyLogCreatePorts,
	userId?: string,
): Promise<DailyLogCreateResult> {
	const domain = requireDomain(args);
	const date = requireDate(args);
	const title = requireTitle(args);
	const days = normalizeCovers(args.covers, date);

	const target = await resolveDailyLogTarget(domain, {
		config: ports.config,
		notion: ports.notion,
	});

	// Properties live on the data source under the Notion API version the SDK speaks,
	// not on the database object (#2285). `requireDatabaseProperties` reads whichever
	// has them; a database with a schema nowhere is its own error, not a 404.
	const schema = await requireDatabaseProperties(ports.notion, {
		workspace: domain,
		databaseId: target.databaseId,
		dataSourceId: target.dataSourceId,
	})
		.then(toDatabaseSchema)
		.catch((err) => {
			if (err instanceof DatabasePropertiesMissingError) throw err;
			throw reachabilityError(domain, target.databaseId, err);
		});

	const titleProperty = resolveTitleProperty(schema, target.databaseId);
	const dateProperty = resolveDateProperty(schema, args.date_property, target.databaseId);

	const coversTarget = await resolveCoversTarget(domain, schema, args.covers !== undefined, ports);
	const covers = coversTarget && "name" in coversTarget ? coversTarget : null;

	let pillarsTarget: { name: string; values: string[] } | null = null;
	if (args.pillars !== undefined) {
		let configLoadFailed = false;
		const config = await loadDosConfig(ports.config).catch(() => {
			configLoadFailed = true;
			return null;
		});
		const block = config ? domainConfig(config, domain) : null;
		const declaredProp = dailyLogRoleProperty(block, PILLARS_ROLE);
		if (!declaredProp) {
			// #703 round-1 QA (Low): distinguish "config genuinely declares no
			// pillars property" from "config was unreachable" - the refusal
			// message must not tell a caller to add config when a transient
			// read failure is the real cause.
			throw new Error(
				configLoadFailed
					? "pillars → dos config unreachable; refusing to write rather than guessing (transient failure, not a missing declaration)"
					: "pillars → none declared; write none",
			);
		}
		const propName = resolveRole(schema, ROLES.pillars, target.databaseId, declaredProp);
		for (const pillar of args.pillars) {
			assertOption(schema, propName, pillar, "pillars");
		}
		pillarsTarget = { name: propName, values: args.pillars };
	}

	const supplied = args.properties ?? {};
	assertPropertiesMatchSchema(supplied, schema, {
		destination: "this Daily Log",
		reserved: {
			title: titleProperty,
			date: dateProperty,
			...(covers ? { covers: covers.name } : {}),
			...(pillarsTarget ? { pillars: pillarsTarget.name } : {}),
		},
	});
	assertOptionsMatchSchema(supplied, schema, { destination: "this Daily Log" });

	const guardNote = args.allow_duplicate
		? "Duplicate guard skipped: allow_duplicate was true."
		: covers
			? await assertNoEntryCovers(target, covers, dateProperty, days, domain, ports)
			: await assertNoExistingEntry(target, dateProperty, date, domain, ports);

	const properties: Record<string, unknown> = {
		[titleProperty]: { title: [{ text: { content: title } }] },
		[dateProperty]: { date: { start: date } },
		...(covers ? { [covers.name]: coversValue(covers.type, days) } : {}),
		...(pillarsTarget
			? { [pillarsTarget.name]: { multi_select: pillarsTarget.values.map((name) => ({ name })) } }
			: {}),
		...supplied,
	};

	// Enforce required properties declared in dos_config.daily_log_schema (#1139).
	// loadDosConfig().catch(() => null) is a deliberate fail-open: this guard is best-
	// effort schema enforcement layered on top of the live Notion write (which still
	// runs), not the source of truth for whether the write is allowed, so a transient
	// config-read failure degrades to "no required properties enforced this call"
	// rather than refusing an otherwise-valid entry.
	const dosConfig = await loadDosConfig(ports.config).catch(() => null);
	const domainConf = dosConfig ? domainConfig(dosConfig, domain) : null;
	const requiredProperties = domainConf?.daily_log_schema.properties.filter((p) => p.required) ?? [];
	const missingRequired = requiredProperties.filter((p) => isEmptyPropertyValue(properties[p.name]));
	if (missingRequired.length > 0) {
		const names = missingRequired.map((p) => `'${p.name}'`).join(", ");
		throw new Error(
			`Domain '${domain}' Daily Log write refused: missing required property ${names} (declared required: true in dos_config.daily_log_schema). Provide ${names} in properties (#1139).`,
		);
	}

	// One block per line, not one paragraph for the whole body: a day's synthesis is
	// multi-section markdown and Notion caps a single rich-text run at 2000 characters,
	// which createNotionTask's `body` parameter would have hit on the first real day.
	const blocks: BlockPayload[] = args.body ? markdownToBlocks(args.body) : [];
	const first = blocks.slice(0, CHILDREN_PER_CALL);
	const rest = blocks.slice(CHILDREN_PER_CALL);

	const page = await ports.notion
		.createPage({
			workspace: domain,
			databaseId: target.databaseId,
			properties,
			children: first,
		})
		.catch((err) => {
			throw reachabilityError(domain, target.databaseId, err);
		});

	// The body outran one call. Appending is a separate request by Notion's design, so a
	// failure here leaves a real entry with a truncated body - say so rather than
	// reporting a clean write.
	let overflowNote = "";
	for (let i = 0; i < rest.length; i += CHILDREN_PER_CALL) {
		try {
			await ports.notion.appendBlockChildren({
				workspace: domain,
				blockId: page.id,
				children: rest.slice(i, i + CHILDREN_PER_CALL),
			});
		} catch (err) {
			overflowNote =
				"\nWARNING: the entry was created but its body is incomplete \u2014 " +
				(rest.length - i) +
				" block(s) could not be appended: " +
				(err instanceof Error ? err.message : String(err));
			break;
		}
	}

	// Opt-in (#2258): an old skill copy does not pass write_twin and still writes the twin
	// itself in Step 8b, and capture never dedups a `daily_log` twin (#1124), so writing
	// one here unasked would leave that entry with two. Off must stay byte-identical.
	const twinOutcome =
		args.write_twin === true
			? await writeTwin(
					ports.twin,
					{
						pageId: page.id,
						pageUrl: page.url || "",
						provider: target.provider,
						title,
						body: args.body ?? "",
						date,
						pillars: args.pillars ?? [],
					},
					userId,
				)
			: null;
	const twinArtifactId = twinOutcome && "artifactId" in twinOutcome ? twinOutcome.artifactId : null;
	const twinNote = twinOutcome && "warning" in twinOutcome ? twinOutcome.warning : "";

	const lines = [
		"Daily Log entry created (" + domain + "): " + title,
		"  page_id: " + page.id,
		"  page_url: " + (page.url || "(none returned)"),
		"  provider: " + target.provider,
		...(twinArtifactId ? ["  twin_artifact_id: " + twinArtifactId] : []),
		"  blocks written: " + blocks.length,
		...(covers ? ["  covers: " + days.join(", ")] : []),
		...(pillarsTarget && pillarsTarget.values.length > 0
			? ["  pillars: " + pillarsTarget.values.join(", ")]
			: []),
		// The marker ledger's uniqueness key is (artifact_id, provider, kind, external_id),
		// so a marker stamped under the wrong provider string is unfindable by the reads
		// that look for it. Returning the provider this write actually authenticated as
		// removes the caller's chance to guess, and makes ADR-054 §3's
		// notion_personal -> notion_angus rename a one-place change.
		//
		// Scoped to the ritual (#1017). This line used to tell EVERY caller to stamp, and
		// entries an IDE session wrote for its own work carry markers: each reads as an
		// attended close, and the sweep never came back for the rest of that day's atoms.
		"Consumption markers, dos ritual only: stamp each narrative atom this entry synthesised with external_link_create, provider '" +
			target.provider +
			"', kind 'synthesized' (attended, requires ritual run_id) or 'synthesized_unattended' (#561 sweep only), external_id " +
			page.id +
			", and when dos_evidence_aggregate had material_total > 0 stamp one twin-level link on the Daily Log twin artifact_id with kind 'evidence_aggregated' (attended, requires ritual run_id) or 'evidence_aggregated_unattended' (#561 sweep only). One marker closes the whole day for the sweep, so any other caller must stamp none.",
	];
	if (guardNote) lines.push(guardNote);
	if (coversTarget && "note" in coversTarget) lines.push(coversTarget.note);

	return {
		id: page.id,
		url: page.url || "",
		domain,
		provider: target.provider,
		title,
		date,
		...(covers ? { covers: days } : {}),
		...(pillarsTarget && pillarsTarget.values.length > 0 ? { pillars: pillarsTarget.values } : {}),
		blocksWritten: blocks.length,
		...(twinArtifactId ? { twin_artifact_id: twinArtifactId } : {}),
		text: lines.join("\n") + overflowNote + twinNote,
	};
}

export function createDailyLogCreateAction(ports: DailyLogCreatePorts) {
	return defineAction({
		id: "daily_log_create",
		domain: "ops",
		description:
			"The dos ritual's Daily Log writer: ONE entry per domain per covered day, holding those days against " +
			"the ritual. Not for session notes or working logs; record those with capture. `domain` " +
			"('work' or 'angus') is required with no default, and so are `date` and `title`. Full notes: " +
			"docs/guides/tools/daily_log_create.md",
		schema: dailyLogCreateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		run: async (args, ctx) => runDailyLogCreate(args, ports, ctx.userId),
		formatMcp: (result) => result.text,
	});
}
