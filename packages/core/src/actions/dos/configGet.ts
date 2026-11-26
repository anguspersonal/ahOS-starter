import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	DEFAULT_DOMAIN,
	DOMAINS,
	dailyLogRoleProperty,
	domainConfig,
	findAudienceSpec,
	loadDosConfigDetailed,
	pillarNotionOption,
	type Domain,
	type DomainConfig,
	type DosConfig,
	type DosConfigLoadStatus,
} from "../../domain/dosConfig.js";
import type { ConfigRepository } from "../../ports/config.js";
import { PILLARS_ROLE } from "../records/propertyRoles.js";

// Re-exported here so `ahos_doctor` (mcp-server) can ask how the load went. The core
// barrel lists `domain/dosConfig.js` names explicitly but re-exports this module whole,
// and #2256's packet does not include the barrel.
export {
	loadDosConfigDetailed,
	type DosConfigLoadResult,
	type DosConfigLoadStatus,
} from "../../domain/dosConfig.js";

export const dosConfigGetInput = {
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			`Which domain's config to return (ADR-051 §1 routing axis). Defaults to '${DEFAULT_DOMAIN}', so a caller that predates the domain axis keeps getting exactly what it always got. Per-domain: topics, pillars, domain_signals, artefact_registers, state_doc_rules, daily_log_schema. Global (returned whichever domain you ask for): types, tone, audiences.`,
		),
	audience: z
		.string()
		.optional()
		.describe(
			"Optional audience key (e.g. 'advisor', 'team', 'investor') per ADR-051 section 4 / ADR-054 section 4. When provided, returns that specific audience's detailed spec (register and standing exclusions).",
		),
} as const;

export const getDosConfigInput = dosConfigGetInput;

export const dosConfigGetSchema = z.object(dosConfigGetInput);

export type DosConfigGetInput = z.infer<typeof dosConfigGetSchema>;

export interface DosConfigGetOutput {
	domain: Domain;
	config: DomainConfig | null;
	types: DosConfig["types"];
	tone: DosConfig["tone"];
	audiences: DosConfig["audiences"];
	dos_config: DosConfig;
	audience?: string;
	/** How the stored config loaded (#2256). Absent on output built before the field existed. */
	load_status?: DosConfigLoadStatus;
	/** Zod issue paths behind a `degraded` or `unparseable` load. */
	load_issues?: string[];
}

const bullets = (lines: string[]): string => (lines.length === 0 ? "  (none)" : lines.join("\n"));

const renderPillarsHeader = (block: DomainConfig): string => {
	const prop = dailyLogRoleProperty(block, PILLARS_ROLE);
	const destination = prop
		? `pillars → "${prop}" (multi_select)`
		: "pillars → none declared; write none";
	return `Pillars (strategic objectives — NOT task priority; Tasks-DB Priority is a 1 to 3 urgency tier — ${destination}):`;
};

const renderPillars = (block: DomainConfig): string =>
	bullets(
		block.pillars.map((p) => {
			const option = pillarNotionOption(p);
			// State the no-projection case out loud rather than omitting the
			// annotation — a pillar that writes nothing should be visible in one
			// tool call, not inferred from a gap in the output.
			const projection = option ? `[Notion option: "${option}"]` : "[no Notion option]";
			return `  ${p.key} ${p.label} — ${p.description} ${projection}`;
		}),
	);

const renderDailyLog = (block: DomainConfig): string[] => {
	const prop = dailyLogRoleProperty(block, PILLARS_ROLE);
	const destNote = prop
		? `written verbatim into "${prop}" (declared with role 'pillars')`
		: "this domain declares no property with role 'pillars' (pillars → none declared; write none)";
	return [
		"Daily Log schema (* = required):",
		bullets(
			block.daily_log_schema.properties.map(
				(p) =>
					`  ${p.name} (${p.notion_type})${p.required ? " *" : ""}${p.role ? ` [role: ${p.role}]` : ""}${p.notes ? ` — ${p.notes}` : ""}`,
			),
		),
		`  body sections: ${block.daily_log_schema.body_sections.join(" | ") || "(none)"}`,
		`  note: each pillar's option value is the one shown against it above, ${destNote}. A pillar`,
		"        marked [no Notion option] does not project and is simply not selected. Never",
		"        re-derive a value from the pillar key and never invent one: the key is internal",
		"        vocabulary, renamed independently of Notion (#618), and Notion CREATES an",
		"        unknown multi-select option on write, so a guess adds a new pillar identity",
		"        rather than failing. Option names are immutable — a changed objective is a NEW",
		"        option, never a rename, because a rename rewrites what every historical entry",
		"        meant (#692).",
	];
};

const renderDomainBlock = (block: DomainConfig): string[] => [
	"Topics (subject areas for classifying an item — ADR-054 §2 renamed this from `domains`,",
	"which now means the routing axis and nothing else):",
	`  ${block.topics.join(", ") || "(none)"}`,
	"",
	renderPillarsHeader(block),
	renderPillars(block),
	"",
	"Artefact registers:",
	bullets(block.artefact_registers.map((r) => `  ${r.key} — ${r.tone}`)),
	"",
	"State Doc rules:",
	`  max_words: ${block.state_doc_rules.max_words}`,
	`  open_actions_cap: ${block.state_doc_rules.open_actions_cap}`,
	`  communications_cap: ${block.state_doc_rules.communications_cap}`,
	...(block.waiting_on_status ? ["", `Waiting-on task status: ${block.waiting_on_status}`] : []),
	"",
	...renderDailyLog(block),
];

/**
 * An unconfigured domain is reported as unconfigured, never as a set of empty lists.
 * The difference is the whole point: empty lists read as "the owner decided there are
 * none" and invite the ritual to carry on writing, which is `097bf71f` (ADR-054 §6).
 */
const renderMissingDomain = (domain: string, config: DosConfig): string[] => {
	const present = Object.keys(config.by_domain);
	return [
		`NO CONFIG BLOCK FOR DOMAIN '${domain}'. This is not the same as "everything is empty":`,
		"nothing is configured for it, so do NOT invent pillars, property names or topics for",
		"this domain — a Notion write built from guesses lands in the owner's real workspace.",
		`  domains present in this config: ${present.join(", ") || "(none)"}`,
		"  fix: land the domain's block in user_preferences.dos_config (migration 088, #679).",
	];
};

/**
 * Stored but unparseable is its own answer (#2256). Reporting it as a missing block sent
 * the owner to add config that was already there, while the real fault went unnamed.
 */
const renderUnparseable = (domain: string, issues: string[]): string[] => [
	`CONFIG STORED BUT UNPARSEABLE (asked for domain '${domain}'). user_preferences.dos_config`,
	"holds a config, but it failed schema validation, so NOTHING below reflects what is stored.",
	"The domain blocks are most likely present: do NOT add them again, and do NOT invent",
	"pillars, property names or topics — a Notion write built from guesses lands in the",
	"owner's real workspace.",
	"  validation issues:",
	...(issues.length > 0 ? issues.map((i) => `    - ${i}`) : ["    (none reported)"]),
	"  fix: correct the value at each path above (config_preferences_update), or widen the",
	"       reader in packages/core/src/domain/dosConfig.ts if the stored shape is legitimate.",
];

const renderDegraded = (issues: string[]): string[] => [
	"DEGRADED GLOBAL KEYS: these stored values failed validation and read as empty below.",
	"Domain blocks are unaffected.",
	...issues.map((i) => `  - ${i}`),
	"",
];

export function formatDosConfigGetMcp(output: DosConfigGetOutput): string {
	const { domain, config: block, dos_config: config, audience } = output;
	const loadIssues = output.load_issues ?? [];
	const missingDomain =
		output.load_status === "unparseable"
			? renderUnparseable(domain, loadIssues)
			: renderMissingDomain(domain, config);

	// Routing signals are listed for EVERY domain, not just the selected one, because
	// the question they answer is cross-domain: dos-hl Step 1 asks "does this atom
	// belong to this domain?" of every atom, and can only answer it by seeing the
	// other domain's signals too. The data is stored per-domain (ADR-054 §5); the
	// classifier that reads it is not.
	const routingSignals = bullets(
		Object.entries(config.by_domain).map(
			([key, value]) => `  ${key}: ${value.domain_signals.join(", ") || "(none)"}`,
		),
	);

	const audienceRequested = audience?.trim();
	let audienceSection: string[] = [];
	if (audienceRequested) {
		const matched = findAudienceSpec(config, audienceRequested);
		if (matched) {
			const role = matched.role ? ` (${matched.role})` : "";
			const cadence = matched.cadence ? ` [cadence: ${matched.cadence}]` : "";
			const dom = matched.domain ? ` [domain: ${matched.domain}]` : "";
			audienceSection = [
				`Audience spec: ${matched.key}${role}${cadence}${dom}`,
				`  Register: ${matched.register}`,
				"  Standing exclusions:",
				...(matched.standing_exclusions.length > 0
					? matched.standing_exclusions.map((e) => `    - ${e}`)
					: ["    (none)"]),
				`  Examples: ${matched.examples.length} accumulated`,
				"",
			];
		} else {
			audienceSection = [
				`NO AUDIENCE SPEC FOUND FOR '${audienceRequested}'. Known audiences: ${config.audiences.map((a) => a.key).join(", ") || "(none)"}`,
				"",
			];
		}
	}

	const audiencesFormatted = bullets(
		config.audiences.map((a) => {
			const role = a.role ? ` (${a.role})` : "";
			const cadence = a.cadence ? ` [cadence: ${a.cadence}]` : "";
			const dom = a.domain ? ` [domain: ${a.domain}]` : "";
			const header = `  ${a.key}${role}${cadence}${dom}:`;
			const reg = `    Register: ${a.register}`;
			const exclHeader = "    Standing exclusions:";
			const exclBullets =
				a.standing_exclusions.length > 0
					? a.standing_exclusions.map((e) => `      - ${e}`).join("\n")
					: "      (none)";
			return `${header}\n${reg}\n${exclHeader}\n${exclBullets}`;
		}),
	);

	return [
		`dos config — domain: ${domain} (user_preferences.dos_config):`,
		"",
		...(output.load_status === "degraded" ? renderDegraded(loadIssues) : []),
		...audienceSection,
		...(block ? renderDomainBlock(block) : missingDomain),
		"",
		"Global (identical whichever domain you ask for):",
		"",
		"Atom types:",
		bullets(config.types.map((t) => `  ${t.key} — ${t.description}`)),
		"",
		"Tone:",
		bullets(config.tone.map((r) => `  - ${r}`)),
		"",
		"Audiences (ADR-051 section 4 / ADR-054 section 4):",
		audiencesFormatted,
		"",
		"Domain routing signals (all domains — which domain does an item belong to?):",
		routingSignals,
		"",
		"Raw JSON:",
		JSON.stringify(
			{
				domain,
				config: block,
				types: config.types,
				tone: config.tone,
				audiences: config.audiences,
			},
			null,
			2,
		),
	].join("\n");
}

export function createDosConfigGetAction(repo: ConfigRepository) {
	return defineAction({
		id: "dos_config_get",
		domain: "ops",
		description:
			"The owner's persisted dos config for ONE domain ('work' default, or 'angus'): topics, " +
			"pillars, domain signals, artefact rules and thresholds. Note `topics` was renamed from " +
			"`domains`, which now means the routing axis only — the two are different things. Full notes: " +
			"docs/guides/tools/dos_config_get.md",
		schema: dosConfigGetSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<DosConfigGetOutput> => {
			const domain = args.domain ?? DEFAULT_DOMAIN;
			const { config, status, issues } = await loadDosConfigDetailed(repo);
			const block = domainConfig(config, domain);

			return {
				domain,
				config: block,
				types: config.types,
				tone: config.tone,
				audiences: config.audiences,
				dos_config: config,
				load_status: status,
				load_issues: issues,
				...(args.audience !== undefined ? { audience: args.audience } : {}),
			};
		},
		formatMcp: formatDosConfigGetMcp,
	});
}
