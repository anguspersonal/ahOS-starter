import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { COVERS_ROLE } from "../../domain/dailyLogCovers.js";
import {
	isDailyLogUnwired,
	reachabilityError,
	resolveDailyLogPortTarget,
	resolveDailyLogTarget,
	type DailyLogTarget,
} from "../../domain/dailyLogTarget.js";
import { DOMAIN_PROVIDER } from "../../domain/domains.js";
import {
	DEFAULT_DOMAIN,
	DOMAINS,
	domainConfig,
	loadDosConfig,
	type Domain,
} from "../../domain/dosConfig.js";
import {
	hasDrift,
	hasPropertyDrift,
	propertyDriftFindings,
	quarantinedValues,
	reconcileDomainConfig,
	unverifiedProperties,
	unverifiedVocabularies,
	type DriftReport,
	type PropertyReconciliation,
	type VocabularyReconciliation,
} from "../../domain/dosConfigDrift.js";
import {
	notionConfigSchema,
	notionPersonalConfigSchema,
} from "../../domain/integrations.js";
import {
	reconcileTasksPropertyMap,
	type TaskPropertyFinding,
} from "../../domain/tasksPropertyDrift.js";
import type { ConfigRepository } from "../../ports/config.js";
import { readDatabaseProperties } from "../notion/schemaGuard.js";
import type {
	NotionDatabasePropertyItem,
	NotionPort,
} from "../../ports/notion.js";
import {
	formatAvailableProperties,
	type NotionDatabaseSchema,
} from "../tasks/taskProperties.js";

// dos-hl Step 0 config/Notion reconciliation probe (#656, #1001, #1494).
//
// Severity ladder (kept invariant across the #1494 action migration):
//   - UNREACHABLE Daily Log (HTTP 404 via error.status === 404, #1569) or UNWIRED domain:
//     THROW so the ritual stops before doing a full session of reads for a destination it
//     cannot write.
//   - ANY OTHER READ ERROR (5xx, DB read failure, dropped connection, or unreachable Tasks DB
//     including 404): report COULD NOT VERIFY and continue.
//   - DRIFT: report, QUARANTINE offending values, and continue.
//   - NOTION-ONLY OPTION: informational (retired vocabulary lives on in Notion).

export const dosConfigDriftInput = {
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			`Which domain's config to reconcile against its live Notion Daily Log. Defaults to '${DEFAULT_DOMAIN}'. Each domain is a different database in a different workspace behind a different token, and only that domain's own destination is read.`,
		),
} as const;

export const dosConfigDriftSchema = z.object(dosConfigDriftInput);

export type DosConfigDriftInput = z.infer<typeof dosConfigDriftSchema>;

export type DosConfigPort = Pick<
	ConfigRepository,
	"loadDosConfigRow" | "loadConfigDetailed" | "loadConfig"
>;

export interface DosConfigDriftPorts {
	notion: Pick<NotionPort, "retrieveDatabase"> &
		Partial<Pick<NotionPort, "resolveToken" | "retrieveDataSource" | "resolveDailyLogTarget">>;
	config: DosConfigPort;
	/** Optional seam for callers or unit tests overriding Daily Log target resolution. */
	resolveDailyLogTarget?: (
		domain: Domain,
		attempted: string,
	) => Promise<Pick<DailyLogTarget, "databaseId" | "dataSourceId">>;
}

/** What the tasks-integration check found for one domain. */
export type TasksDriftReport =
	| { status: "not_configured"; provider: string }
	| { status: "could_not_verify"; provider: string; databaseId: string; error: string }
	| { status: "empty_map"; provider: string; databaseId: string }
	| {
			status: "checked";
			provider: string;
			databaseId: string;
			findings: TaskPropertyFinding[];
			/** Every property name on the live database, for the "not found" message. */
			availableProperties: string[];
	  };

/**
 * Structured reconciliation for one domain against its live Notion destinations (#1024, #1494).
 * Reused directly by `ahos_doctor` wiring checks before rendering for MCP.
 */
export type DomainReconciliation =
	| { kind: "unconfigured"; domainsPresent: string[] }
	| { kind: "target_unresolved"; error: string }
	| { kind: "could_not_verify"; databaseId: string; error: string; tasks: TasksDriftReport }
	| { kind: "checked"; databaseId: string; report: DriftReport; tasks: TasksDriftReport };

export interface DosConfigDriftOutput {
	domain: Domain;
	reconciliation: DomainReconciliation;
}

function isAdapterUnavailable(err: unknown): boolean {
	return err instanceof Error && err.name === "AdapterUnavailableError";
}

/**
 * Strict Notion 404 check (#1569): branches solely on `err.status === 404` and
 * never inspects error message text.
 */
function isNotionStatus404(err: unknown): boolean {
	return (
		Boolean(err) &&
		typeof err === "object" &&
		"status" in (err as object) &&
		(err as { status?: unknown }).status === 404
	);
}

function flattenDatabaseProperties(
	rawProperties: Record<string, NotionDatabasePropertyItem>,
): NotionDatabaseSchema {
	const properties = Object.keys(rawProperties).map((name) => {
		const prop = rawProperties[name];
		const type = prop?.type ?? "unknown";
		const optionsHolder =
			type === "select"
				? prop?.select
				: type === "multi_select"
					? prop?.multi_select
					: type === "status"
						? prop?.status
						: undefined;
		const options = optionsHolder?.options
			?.map((o) => o.name)
			.filter((n): n is string => Boolean(n));

		return {
			name,
			type,
			...(options && options.length > 0 ? { options } : {}),
		};
	});

	return { properties };
}

async function retrieveLiveDatabaseSchema(
	notion: DosConfigDriftPorts["notion"],
	domain: Domain,
	databaseId: string,
): Promise<NotionDatabaseSchema> {
	// The shared read (#2285). Drift reports on a schema rather than writing through it,
	// so a database with no properties anywhere is an empty schema here, not an error.
	const { properties } = await readDatabaseProperties(notion, { workspace: domain, databaseId });
	return flattenDatabaseProperties(properties ?? {});
}

async function checkTasksPropertyMap(
	domain: Domain,
	ports: DosConfigDriftPorts,
): Promise<TasksDriftReport> {
	const provider = DOMAIN_PROVIDER[domain];
	const config =
		domain === "work"
			? await ports.config.loadConfig(provider, notionConfigSchema)
			: await ports.config.loadConfig(provider, notionPersonalConfigSchema);

	if (!config) return { status: "not_configured", provider };

	if (Object.keys(config.property_map).length === 0) {
		return { status: "empty_map", provider, databaseId: config.tasks_database_id };
	}

	let live: NotionDatabaseSchema;
	try {
		live = await retrieveLiveDatabaseSchema(ports.notion, domain, config.tasks_database_id);
	} catch (err) {
		if (isAdapterUnavailable(err)) {
			throw err;
		}
		// Unlike the Daily Log, the Tasks DB is never a hard stop: any read failure (404 included)
		// degrades to COULD NOT VERIFY so the Daily Log section still reaches the caller.
		return {
			status: "could_not_verify",
			provider,
			databaseId: config.tasks_database_id,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	return {
		status: "checked",
		provider,
		databaseId: config.tasks_database_id,
		findings: reconcileTasksPropertyMap(config.property_map, live),
		availableProperties: live.properties.map((p) => p.name),
	};
}

export async function reconcileDomainAgainstNotion(
	domain: Domain,
	ports: DosConfigDriftPorts,
): Promise<DomainReconciliation> {
	const config = await loadDosConfig(ports.config);
	const block = domainConfig(config, domain);

	if (!block) return { kind: "unconfigured", domainsPresent: Object.keys(config.by_domain) };

	let target: Pick<DailyLogTarget, "databaseId" | "dataSourceId">;
	try {
		if (ports.resolveDailyLogTarget) {
			target = await ports.resolveDailyLogTarget(domain, "so nothing was read.");
		} else if (typeof ports.notion.resolveToken === "function") {
			target = await resolveDailyLogTarget(domain, "so nothing was read.", {
				config: ports.config,
				notion: { resolveToken: (w) => ports.notion.resolveToken!(w) },
			});
		} else {
			target = await resolveDailyLogPortTarget(
				domain,
				ports.config,
				"so nothing was read.",
			);
		}
	} catch (err) {
		if (isAdapterUnavailable(err)) {
			throw err;
		}
		if (isDailyLogUnwired(err)) {
			throw err;
		}
		return { kind: "target_unresolved", error: err instanceof Error ? err.message : String(err) };
	}

	let live: NotionDatabaseSchema;
	try {
		live = await retrieveLiveDatabaseSchema(ports.notion, domain, target.databaseId);
	} catch (err) {
		if (isAdapterUnavailable(err)) {
			throw err;
		}
		if (isNotionStatus404(err)) {
			throw reachabilityError(
				domain,
				target.databaseId,
				err,
				"Nothing was read, and the ritual must not proceed to a write it now knows will fail.",
			);
		}
		return {
			kind: "could_not_verify",
			databaseId: target.databaseId,
			error: err instanceof Error ? err.message : String(err),
			tasks: await checkTasksPropertyMap(domain, ports),
		};
	}

	return {
		kind: "checked",
		databaseId: target.databaseId,
		report: reconcileDomainConfig(block, live, domain),
		tasks: await checkTasksPropertyMap(domain, ports),
	};
}

const list = (values: string[]): string => values.join(", ");

function renderVocabulary(v: VocabularyReconciliation): string[] {
	const head = `  ${v.vocabulary} \u2192 ${v.property ? `"${v.property}"` : "(unresolved)"}: `;
	const alsoInNotion =
		v.unused.length > 0
			? [`      notion also offers (fine \u2014 retired vocabulary lives on): ${list(v.unused)}`]
			: [];

	switch (v.status) {
		case "ok":
			return [
				`${head}ok \u2014 all ${v.configured.length} configured values are live options.`,
				...alsoInNotion,
			];
		case "drift":
			if (v.property === null) {
				return [
					`${head}DRIFT \u2014 ${v.vocabulary}[] is non-empty (${v.configured.length} configured), but daily_log_schema declares no property with role '${v.vocabulary}'.`,
					`      QUARANTINED, do not write any of: ${list(v.configured)}`,
				];
			}
			return [
				`${head}DRIFT \u2014 ${v.missing.length} of ${v.configured.length} configured values are not Notion options.`,
				`      QUARANTINED, do not offer and do not write: ${list(v.missing)}`,
				...alsoInNotion,
			];
		case "absent":
			return [
				`${head}DRIFT \u2014 config declares this property but the live Daily Log has no such property.`,
				`      QUARANTINED, do not write any of: ${list(v.configured)}`,
			];
		case "no_options":
			return [
				`${head}UNENFORCEABLE \u2014 the property exists but declares no options, so Notion will`,
				"      CREATE whatever is written rather than reject it (#695). Nothing is quarantined;",
				`      write only values the owner has confirmed. Configured: ${list(v.configured)}`,
			];
		case "unresolved":
			return [
				`${head}NOT CHECKED \u2014 this domain's daily_log_schema declares no property for`,
				"      this vocabulary, so there is nothing to reconcile against (#703). Not a fault.",
			];
		case "empty":
			return [`${head}nothing configured, nothing to check.`];
	}
}

function renderProperty(p: PropertyReconciliation): string[] {
	const head = `  "${p.name}" (${p.expectedType}${p.role ? `, role '${p.role}'` : ""}${p.required ? ", required" : ""}): `;
	switch (p.status) {
		case "ok":
			return p.expectedOptions && p.expectedOptions.length > 0
				? [`${head}ok \u2014 live options include ${list(p.expectedOptions)}.`]
				: [`${head}ok`];
		case "missing_required":
			return [
				`${head}DRIFT \u2014 missing from live Daily Log database.`,
				`      ${p.detail}`,
				`      fix: ${p.remediation}`,
			];
		case "missing_optional":
			if (p.role === COVERS_ROLE) {
				return [
					`${head}DRIFT \u2014 missing from live Daily Log database (#1016).`,
					`      ${p.detail}`,
					`      fix: ${p.remediation}`,
				];
			}
			return [`${head}optional property not present in Notion database.`];
		case "type_mismatch":
			return [
				`${head}DRIFT \u2014 Notion type is '${p.actualType}', expected '${p.expectedType}'.`,
				`      ${p.detail}`,
				`      fix: ${p.remediation}`,
			];
		case "missing_options":
			return [
				`${head}DRIFT \u2014 missing required option(s): ${list(p.missingOptions ?? [])}.`,
				`      Available in Notion: ${list(p.availableOptions ?? []) || "(none)"}.`,
				`      fix: ${p.remediation}`,
			];
		case "no_options":
			return [
				`${head}UNENFORCEABLE \u2014 property exists but declares no options in Notion (#695).`,
				`      fix: ${p.remediation}`,
			];
	}
}

function renderVerdict(report: DriftReport): string[] {
	const unverifiedVocabs = unverifiedVocabularies(report).map((v) => v.vocabulary);
	const unverifiedProps = unverifiedProperties(report).map((p) => p.name);
	const unverifiedAll = [...unverifiedVocabs, ...unverifiedProps];
	const notAnAllClear = `not verified: ${list(unverifiedAll)} \u2014 reconciled against nothing, so treat as unknown, not as clear.`;

	const quarantined = quarantinedValues(report);
	const propDrifts = propertyDriftFindings(report);

	if (hasDrift(report) || hasPropertyDrift(report)) {
		const driftSummaries: string[] = [];
		if (quarantined.length > 0) {
			driftSummaries.push(`${quarantined.length} configured value(s)`);
		}
		if (propDrifts.length > 0) {
			driftSummaries.push(
				`${propDrifts.length} schema propert${propDrifts.length === 1 ? "y defect" : "ies defect"} (${propDrifts.map((p) => p.name).join(", ")})`,
			);
		}
		const countDesc = driftSummaries.join(" and ");

		return [
			"",
			`verdict: DRIFT \u2014 ${countDesc} cannot be written to Notion.`,
			...(unverifiedAll.length > 0 ? [notAnAllClear] : []),
			"the ritual CONTINUES. Do not offer a quarantined value for classification and do not",
			"put one in a Daily Log write: it would either fail the write or silently create the",
			"option in the owner's workspace (#695). Classify that work under a surviving value,",
			"or leave it untagged and say so \u2014 an honest gap beats a wrong tag (#656 filed exactly",
			"that: a day of product work tagged `Ops, Other`).",
			"fix: bring config into line in a migration; never add the option to Notion to match a",
			"stale config, and never delete a Notion option (it strips the value from every",
			"historical page).",
		];
	}

	if (unverifiedAll.length > 0) {
		return [
			"",
			"verdict: NOT FULLY VERIFIED \u2014 nothing drifts in what could be checked, but",
			notAnAllClear,
			"the ritual CONTINUES, and nothing is quarantined \u2014 there is no live option set to",
			"quarantine against. Write only values the owner has confirmed: an unknown one is",
			"CREATED rather than refused (#695), which invents a taxonomy entry instead of failing.",
		];
	}

	return ["", "verdict: ok \u2014 every configured value exists in Notion."];
}

function renderReport(domain: Domain, databaseId: string, report: DriftReport): string {
	const propertiesLines =
		report.properties && report.properties.length > 0
			? [
					"",
					"daily log schema properties:",
					...(propertyDriftFindings(report).length === 0 && unverifiedProperties(report).length === 0
						? [`  ok \u2014 all ${report.properties.length} declared properties match Notion types and options.`]
						: report.properties.flatMap(renderProperty)),
				]
			: [];

	return [
		`config\u2194notion reconciliation \u2014 domain: ${domain} (Daily Log ${databaseId})`,
		"direction is config \u2286 notion: a configured value Notion lacks is a fault; a Notion",
		"option config lacks is not.",
		"",
		...report.vocabularies.flatMap(renderVocabulary),
		...propertiesLines,
		...renderVerdict(report),
	].join("\n");
}

function renderTasksReport(domain: Domain, report: TasksDriftReport): string {
	const header = `tasks db\u2194property_map reconciliation \u2014 domain: ${domain}, provider: ${report.provider}`;

	switch (report.status) {
		case "not_configured":
			return [
				header,
				`NOT CHECKED \u2014 no '${report.provider}' tasks integration is configured for this domain,`,
				"so there is no property_map to reconcile. Not a fault: a domain need not use",
				"task_create.",
			].join("\n");

		case "could_not_verify":
			return [
				`${header} (Tasks DB ${report.databaseId})`,
				"COULD NOT VERIFY \u2014 reading the live Tasks DB schema failed, and the failure is not",
				"informative about whether property_map is correct. task_create itself is unaffected",
				"by this check and will still attempt its own write.",
				`  notion said: ${report.error}`,
			].join("\n");

		case "empty_map":
			return [
				`${header} (Tasks DB ${report.databaseId})`,
				"",
				"verdict: DRIFT \u2014 property_map is empty on a configured tasks integration.",
				"task_create falls back to a guessed property name for every abstract key (status,",
				"priority, owner, ...); a guess wrong for this database only surfaces when a write",
				"is attempted (#1001's observed case: four task_create calls failing on 'Owner').",
				`fix: integration_set({ provider: '${report.provider}', config: { property_map: { ... } } }).`,
			].join("\n");

		case "checked": {
			const missing = report.findings.filter((f) => f.status === "mapped_missing");
			const ok = report.findings.filter((f) => f.status === "mapped_ok");
			const available = report.findings.filter((f) => f.status === "unmapped_available");

			const lines = [`${header} (Tasks DB ${report.databaseId})`, ""];

			if (missing.length > 0) {
				lines.push(
					`verdict: DRIFT \u2014 ${missing.length} mapped propert${missing.length === 1 ? "y" : "ies"} ` +
						`${missing.length === 1 ? "does" : "do"} not exist on the tasks database:`,
				);
				for (const f of missing) {
					lines.push(`  '${f.abstractKey}' \u2192 "${f.mappedName}": NOT FOUND.`);
				}
				lines.push(
					`  Available properties: ${formatAvailableProperties(report.availableProperties)}.`,
				);
				lines.push(
					"the ritual CONTINUES: this only bites the next task_create call that uses one of",
					"these keys, exactly as it would without this check. fix: correct property_map, or",
					"remove the key if this database has no equivalent property.",
				);
			} else {
				lines.push("verdict: ok \u2014 every mapped property exists on the tasks database.");
			}

			if (ok.length > 0) {
				lines.push(
					"",
					`  mapped and present: ${list(ok.map((f) => `${f.abstractKey} \u2192 "${f.mappedName}"`))}`,
				);
			}
			if (available.length > 0) {
				lines.push(
					`  not mapped, but the database has a property under the default name \u2014 informational: ${list(
						available.map((f) => f.abstractKey),
					)}`,
				);
			}

			return lines.join("\n");
		}
	}
}

export function formatDosConfigDriftMcp(output: DosConfigDriftOutput): string {
	const { domain, reconciliation: result } = output;

	if (result.kind === "unconfigured") {
		return [
			`config\u2194notion reconciliation \u2014 domain: ${domain}: NOT CHECKED.`,
			`There is no config block for '${domain}', so there is no vocabulary to reconcile.`,
			"This is not an all-clear. Do not invent topics, pillars or property names for it.",
			`  domains present: ${result.domainsPresent.join(", ") || "(none)"}`,
		].join("\n");
	}

	if (result.kind === "target_unresolved") {
		return [
			`config\u2194notion reconciliation \u2014 domain: ${domain}: COULD NOT VERIFY.`,
			`Resolving the Daily Log target for '${domain}' failed with a read error,`,
			"which says nothing about whether the config is correct. Continue the",
			"ritual and treat the vocabulary as unverified rather than as broken.",
			`  error: ${result.error}`,
		].join("\n");
	}

	const tasksText = renderTasksReport(domain, result.tasks);

	if (result.kind === "could_not_verify") {
		const dailyLogText = [
			`config\u2194notion reconciliation \u2014 domain: ${domain}: COULD NOT VERIFY.`,
			`Reading the live Daily Log schema (${result.databaseId}) failed, and the failure is`,
			"not a 404, so it says nothing about whether the config is correct. Continue the",
			"ritual and treat the vocabulary as unverified rather than as broken.",
			`  notion said: ${result.error}`,
		].join("\n");
		return `${dailyLogText}\n\n${tasksText}`;
	}

	const dailyLogText = renderReport(domain, result.databaseId, result.report);
	return `${dailyLogText}\n\n${tasksText}`;
}

export function createDosConfigDriftAction(ports: DosConfigDriftPorts) {
	return defineAction({
		id: "dos_config_drift",
		domain: "ops",
		description:
			"Reconcile one domain's dos config against the live Notion Daily Log schema, AND its tasks " +
			"integration's property_map against the live Tasks DB, and report what cannot be written. Checks " +
			"config against Notion one way only: every configured value must exist in Notion, never the " +
			"reverse. Read-only \u2014 it edits neither side. Full notes: docs/guides/tools/dos_config_drift.md",
		schema: dosConfigDriftSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<DosConfigDriftOutput> => {
			const domain = args.domain ?? DEFAULT_DOMAIN;
			const reconciliation = await reconcileDomainAgainstNotion(domain, ports);
			return { domain, reconciliation };
		},
		formatMcp: formatDosConfigDriftMcp,
	});
}
