import { z } from "zod";
import { DOMAINS, type Domain } from "./domains.js";

// User-specific dos config: per-domain behaviour (topics, pillars, routing signals,
// artefact registers, state doc caps, daily log schema) plus the global keys that are
// the same whichever domain a night routes to (atom types, tone, operating_principles).
// Persisted in user_preferences.dos_config and read at runtime so the ritual stays
// vendor-agnostic (no bundled reference file).
//
// See supabase/migrations/20260617120000_050_add_dos_eod_config.sql, 055, 086, 087,
// 088, 089, 097 and 149 (the column itself was dos_eod_config -> dos_hl_config -> dos_config,
// migrations 054 and 097; migration 149 separates tone from operating_principles, #1984).
//
// OLDER SHAPES ARE READABLE HERE, AND THAT IS DELIBERATE
// Migration 088 reshapes the blob from flat/Work-shaped to `by_domain`, per
// ADR-054 §5, and 089 renames each pillar's projection field, per #692. Migrations
// reach prod on the release train and are pushed by hand, so this code is deployed
// BEFORE either lands — for an unknown window, possibly a long one. A reader that
// understood only the newest shape would return an empty config for every ritual the
// moment it deployed. So the newest shape is preferred at each level and the older
// one is a full fallback: `by_domain` over the flat keys, `pillars` over
// `priorities`, `notion_option` over `notion_property`.
//
// The fallback is a faithful, lossless read: it reports what is stored and never
// edits it. ADR-054 §2 removes the `Personal` topic value, for instance, but that
// removal is migration 088's job — doing it here as well would make the reader a
// second source of truth about the blob's contents.

/**
 * ADR-051 §1's routing axis, re-exported from its single declaration in
 * `domains.js` (#708). Closed by design: `domain` decides which Notion workspace a
 * night's output lands in, and a third value would need destinations wired before it
 * could mean anything (ADR-054 §6).
 *
 * Config STORAGE is deliberately wider than this — `by_domain` is parsed as an open
 * record — so a blob carrying an unknown domain key parses and stays visible instead
 * of failing the whole config. What is closed is the set a caller may ASK for. Those
 * are two different things and both are correct; they now derive from one declaration
 * rather than two identical ones.
 *
 * It is re-exported rather than only imported so the ~dozen call sites that already
 * import it from here keep working. `domains.js` is the home because it is the smaller
 * module, it carries `DOMAIN_PROVIDER`, and it depends only on the credential type —
 * so the arrow points config → axis and never back.
 */
export { DOMAINS, type Domain } from "./domains.js";

/**
 * The domain assumed when a caller does not name one. Every skill body, tool call and
 * ritual written before the domain axis existed means `work`, so that is what they
 * keep getting; naming a domain is how you opt into the other one.
 */
export const DEFAULT_DOMAIN: Domain = "work";

// A PILLAR is a named strategic objective for one domain — what the domain is
// trying to achieve over a period. It is deliberately NOT the same thing as a
// PRIORITY, which in this system means task urgency only: the Notion Tasks DB
// `Priority` 1 to 3 urgency tier (#471). One word, one meaning.
//
// The generic contract, settled on #618 (#411 picked the word; ADR-054 §5 made
// pillars per-domain; #692 moved the projection off checkbox properties), so a
// second domain does not re-derive it:
//
//  - CARDINALITY is 0..n, not four. Four is Work's current answer, not a
//    property of the concept; an empty list is a legitimate answer. Nothing here
//    enforces a bound. `angus` has five, ratified from Notion on #679.
//  - LIFETIME: the list means "the pillars in force now". No review cadence is
//    encoded. Retirement is non-destructive — drop the pillar from the config so
//    no new entry offers it, and LEAVE its option in the Notion multi-select, so
//    historical Daily Log entries keep the values that make neglect detection
//    readable. A CHANGED objective is a NEW option, never a renamed one (#692):
//    renaming rewrites what every historical entry meant.
//  - PROJECTION is a per-pillar choice, not intrinsic: a pillar projects into
//    Notion only if it carries `notion_option`. A domain can have pillars with no
//    Notion projection at all.
//  - vs TOPIC: "did we make progress on X today?" is sensible → pillar (an
//    objective, ticked in Step 4). Only "is this item about X?" is sensible →
//    topic (a subject area, used to classify in Step 1). The two lists may share
//    a word — `Round` is both — and that is fine; they are different things
//    under different keys, used at different moments.
/**
 * What every consumer sees, whichever shape the blob was stored in. Written out by
 * hand rather than inferred, so the legacy input key below cannot leak into the public
 * type: after parsing there is exactly one name for a pillar's projection.
 */
export type Pillar = {
	key: string;
	label: string;
	description: string;
	notion_option?: string;
};

const pillarSchema = z
	.object({
		key: z.string(),
		label: z.string(),
		description: z.string(),
		// The value this pillar writes into the Daily Log's pillars multi-select,
		// stored verbatim rather than derived from `key`. That is what lets the
		// internal vocabulary change without touching the owner's Notion workspace:
		// #618 renamed the keys to `Pillar N` while the projection kept its own name.
		//
		// IT IS AN OPTION VALUE, NOT A PROPERTY NAME. Until #692 each pillar had its
		// own Notion checkbox property NAMED after the objective, which put
		// time-varying content in the schema: changing an objective meant either
		// renaming the property (rewriting what every historical tick meant) or
		// leaving a property naming something retired. Both happened. The containing
		// property is now declared once, in `daily_log_schema.properties`.
		//
		// NEVER RENAME AN OPTION, ONLY ADD. A changed objective is a NEW option; the
		// retired one stops being selected and stays in Notion so history still reads
		// correctly. Renaming reintroduces the exact defect #692 removed.
		//
		// NEVER INVENT ONE EITHER. Notion CREATES an unknown multi-select option on
		// write, so a guessed or re-derived string does not fail loudly — it silently
		// adds a new pillar identity to the owner's workspace.
		//
		// ABSENT MEANS THE PILLAR DOES NOT PROJECT — nothing is selected for it.
		// Legacy blobs are handled at the read boundary, not here: both the
		// `notion_property` normalisation below and the `priorities` fallback fill
		// this field on the way in, so absence at a consumer means what the field says
		// it means rather than "derive one".
		notion_option: z.string().optional(),

		// Pre-089 blobs carry the same string under the old key, and migrations are
		// pushed by hand long after this code deploys, so the old key is READ rather
		// than assumed gone. It is read as an OPTION VALUE, which is the only
		// non-breaking reading: the checkbox properties these strings used to name are
		// already deleted from Notion, so treating them as property names would fail
		// every Daily Log write for the whole window — while the strings themselves
		// ARE live options, carried over verbatim by the backfill so that history
		// still reads correctly (#692).
		//
		// The transform below folds it into `notion_option`, so this key never escapes
		// the read boundary and no consumer can read the losing name by accident.
		notion_property: z.string().optional(),
	})
	.transform(({ notion_property, ...pillar }): Pillar => ({
		...pillar,
		notion_option: pillar.notion_option ?? notion_property,
	}));

/**
 * The Notion multi-select option value a pillar writes, or `null` when the pillar
 * does not project to Notion at all.
 *
 * Always use this rather than re-deriving from `key` — `key` is internal
 * vocabulary and changes on its own schedule from the external Notion option set.
 */
export function pillarNotionOption(pillar: Pillar): string | null {
	const explicit = pillar.notion_option?.trim();
	return explicit && explicit.length > 0 ? explicit : null;
}

/**
 * The legacy read boundary: a pillar taken from the pre-#618 `priorities` key
 * carries neither projection field, but it unarguably projected — the skill
 * derived `"{key} {label}"` at write time. Fill the field here so that
 * derivation happens exactly once, on the way in, and never at the point of use.
 *
 * Post-#692 that derived string is an OPTION value. For the one blob shape this
 * path exists for it is also the right one: the derivation reproduces the legacy
 * `P1 Launch` names, and those are exactly the options the backfill preserved. It
 * is still a derivation, though, and a derived option Notion does not know would be
 * created on write rather than rejected — which is why the rule everywhere else is
 * never to derive, and why migration 086 drained this key rather than leaving rows
 * on it.
 */
function fromLegacyPriority(pillar: Pillar): Pillar {
	return {
		...pillar,
		notion_option: pillarNotionOption(pillar) ?? `${pillar.key} ${pillar.label}`,
	};
}

const artefactRegisterSchema = z.object({
	key: z.string(),
	tone: z.string(),
});
export type ArtefactRegister = z.infer<typeof artefactRegisterSchema>;

const atomTypeSchema = z.object({
	key: z.string(),
	description: z.string(),
});
export type AtomType = z.infer<typeof atomTypeSchema>;

// `config_preferences_update` and DosConfigSettingsCanvas.tsx both write
// `{ key, description }` objects here, while every consumer of
// `DosConfig.operating_principles` expects `string[]`. Accept both and normalise on the
// way in, so the public contract is unchanged and the writer's shape cannot fail the
// parse. Before #2256 two such objects blanked `by_domain` for every domain, and
// `dos_config_get` reported the config as missing rather than as unparseable.
const operatingPrincipleSchema = z
	.union([z.string(), z.object({ key: z.string(), description: z.string() })])
	.transform((item) => (typeof item === "string" ? item : `${item.key}: ${item.description}`));

// The verbatim declaration of one Notion Daily Log property. This list is the only
// record of the destination's property NAMES — including the multi-select the pillars
// project into, which migration 089 declares here rather than in a second key, so the
// name has exactly one home (#692). Property names live in config, never in this file.
const dailyLogPropertySchema = z.object({
	name: z.string(),
	notion_type: z.string(),
	required: z.boolean(),
	notes: z.string().optional(),
	// What the property is FOR, when a tool must find it by something other than an LLM
	// reading `notes` (#703's mechanism). First role: `covers` (#1016), the days a Daily
	// Log entry accounts for, which daily_log_create writes and its duplicate guard keys
	// on. The NAME still lives in config (migration 087's rule); the role is the join.
	role: z.string().optional(),
	options: z.array(z.string()).optional(),
});

export type DailyLogProperty = z.infer<typeof dailyLogPropertySchema>;

const dailyLogSchemaSchema = z.object({
	properties: z.array(dailyLogPropertySchema).default([]),
	body_sections: z.array(z.string()).default([]),
});

const stateDocRulesSchema = z.object({
	max_words: z.number().default(2000),
	open_actions_cap: z.number().default(10),
	communications_cap: z.number().default(10),
});

const DEFAULT_STATE_DOC_RULES = { max_words: 2000, open_actions_cap: 10, communications_cap: 10 };
const DEFAULT_DAILY_LOG_SCHEMA = { properties: [], body_sections: [] };

export const audienceSpecSchema = z.object({
	key: z.string(),
	role: z.string().optional(),
	domain: z.string().optional(),
	register: z.string(),
	standing_exclusions: z.array(z.string()).default([]),
	examples: z.array(z.string()).default([]),
	cadence: z.string().optional(),
});
export type AudienceSpec = z.infer<typeof audienceSpecSchema>;

/**
 * Everything that is true of ONE domain: ADR-054 §5's per-domain column, plus
 * `artefact_registers`, which §5's table omits (that ADR's Amendment 1 places it
 * here; ratification is #685).
 */
const domainConfigSchema = z.object({
	// ADR-054 §2: the old top-level `domains` list, renamed and nested. `domain`
	// routes; `topics` classify.
	topics: z.array(z.string()).default([]),
	pillars: z.array(pillarSchema).default([]),
	// ADR-054 §5: ADR-051 §1's classifier, repurposed from
	// `workspace.{work_entities, personal_signals}` — from "which ritual refuses
	// you" to "which domain does this item route to".
	domain_signals: z.array(z.string()).default([]),
	artefact_registers: z.array(artefactRegisterSchema).default([]),
	audiences: z.array(audienceSpecSchema).optional(),
	state_doc_rules: stateDocRulesSchema.default(DEFAULT_STATE_DOC_RULES),
	daily_log_schema: dailyLogSchemaSchema.default(DEFAULT_DAILY_LOG_SCHEMA),
	// #1028: Notion task status indicating work waiting on someone else
	waiting_on_status: z.string().optional(),
});

export type DomainConfig = z.infer<typeof domainConfigSchema>;

const EMPTY_DOMAIN_CONFIG: DomainConfig = {
	topics: [],
	pillars: [],
	domain_signals: [],
	artefact_registers: [],
	state_doc_rules: DEFAULT_STATE_DOC_RULES,
	daily_log_schema: DEFAULT_DAILY_LOG_SCHEMA,
	waiting_on_status: undefined,
};

// The pre-088 flat blob's routing signals. Both lists live in a legacy blob and both
// are carried forward: `work_entities` becomes the `work` domain's signals and
// `personal_signals` becomes the `angus` domain's.
const legacyWorkspaceSchema = z.object({
	work_entities: z.array(z.string()).default([]),
	personal_signals: z.array(z.string()).default([]),
});

// The flat, Work-shaped keys as they exist before migration 088. All optional:
// their absence is what says "this blob is already reshaped".
const legacyFlatShape = {
	workspace: legacyWorkspaceSchema.optional(),
	pillars: z.array(pillarSchema).optional(),
	priorities: z.array(pillarSchema).optional(),
	domains: z.array(z.string()).optional(),
	artefact_registers: z.array(artefactRegisterSchema).optional(),
	state_doc_rules: stateDocRulesSchema.optional(),
	daily_log_schema: dailyLogSchemaSchema.optional(),
	waiting_on_status: z.string().optional(),
} as const;

type LegacyFlat = { [K in keyof typeof legacyFlatShape]?: z.infer<(typeof legacyFlatShape)[K]> };

/**
 * Project a pre-088 flat blob onto the per-domain shape.
 *
 * `work` gets everything, because everything in the flat blob was Work's.
 *
 * `angus` gets ONLY its routing signals, and only when the legacy blob carries some.
 * Routing is a cross-domain question — "which domain does this item belong to?" is
 * asked of every atom in dos Step 1, so dropping the personal half of the
 * classifier would break the filter that keeps personal atoms out of the Work
 * log. Nothing else is invented for `angus`: a pillar list or daily-log schema
 * conjured here would read as configured and be wrong, which is `097bf71f`
 * (ADR-054 §6). Until migration 088 runs, `angus` genuinely has no config beyond
 * those signals, and `dos_config_get` says so rather than rendering blanks.
 */
function fromLegacyFlat(legacy: LegacyFlat): Record<string, DomainConfig> {
	const personalSignals = legacy.workspace?.personal_signals ?? [];

	return {
		work: {
			topics: legacy.domains ?? [],
			pillars: legacy.pillars ?? (legacy.priorities ?? []).map(fromLegacyPriority),
			domain_signals: legacy.workspace?.work_entities ?? [],
			artefact_registers: legacy.artefact_registers ?? [],
			state_doc_rules: legacy.state_doc_rules ?? DEFAULT_STATE_DOC_RULES,
			daily_log_schema: legacy.daily_log_schema ?? DEFAULT_DAILY_LOG_SCHEMA,
		},
		...(personalSignals.length > 0
			? { angus: { ...EMPTY_DOMAIN_CONFIG, domain_signals: personalSignals } }
			: {}),
	};
}

export const pastedInstructionsSchema = z.object({
	sha256: z.string(),
	pasted_at: z.string(),
});
export type PastedInstructions = z.infer<typeof pastedInstructionsSchema>;

// SOFT GLOBAL KEYS. These are presentational - they shape prose, they do not route or
// address a write - so a malformed element must degrade only its own key. The strict
// form of each lives here so `loadDosConfigDetailed` can say which key degraded and
// why; `dosConfigSchema` applies them behind `.catch([])`. `by_domain` carries the
// destinations and stays strict: one bad tone rule must never cost both domains their
// config (#2256).
const softGlobalKeySchemas = {
	audiences: z.array(audienceSpecSchema),
	types: z.array(atomTypeSchema),
	tone: z.array(z.string()),
	operating_principles: z.array(operatingPrincipleSchema),
} as const;

export const dosConfigSchema = z
	.object({
		// Post-088. An open record rather than a closed enum, so an unknown domain
		// key stays visible instead of failing the parse for every domain.
		by_domain: z.record(z.string(), domainConfigSchema).optional(),
		// ADR-054 section 4 and section 5 global column: open set of audience specs (#743).
		// Each soft global key is isolated by `.catch` - see `softGlobalKeySchemas`.
		audiences: softGlobalKeySchemas.audiences.default([]).catch([]),
		types: softGlobalKeySchemas.types.default([]).catch([]),
		tone: softGlobalKeySchemas.tone.default([]).catch([]),
		operating_principles: softGlobalKeySchemas.operating_principles.default([]).catch([]),
		handshake_instructions: z.string().nullable().optional(),
		system_instructions: z.string().nullable().optional(),
		"system-instructions": z.string().nullable().optional(),
		canonical_instructions: z.string().nullable().optional(),
		claude_instructions: z.string().nullable().optional(),
		"claude-instructions": z.string().nullable().optional(),
		system_instructions_sync: pastedInstructionsSchema.nullable().optional(),
		claude_instructions_sync: pastedInstructionsSchema.nullable().optional(),
		pasted_instructions: pastedInstructionsSchema.nullable().optional(),
		...legacyFlatShape,
	})
	// `by_domain` wins when it is present AND non-empty; the flat keys are dropped
	// from the parsed shape entirely, so no consumer can read the losing shape by
	// accident - the precedence migration 086 established for `pillars`/`priorities`,
	// applied one level up. An empty `by_domain: {}` counts as absent rather than as
	// "configured with nothing", so a half-written blob degrades to the legacy read
	// instead of to silence.
	.transform(
		({
			by_domain,
			types,
			tone,
			operating_principles,
			handshake_instructions,
			system_instructions,
			"system-instructions": systemInstructionsHyphen,
			canonical_instructions,
			claude_instructions,
			"claude-instructions": claudeInstructionsHyphen,
			audiences,
			system_instructions_sync,
			claude_instructions_sync,
			pasted_instructions,
			...legacy
		}) => {
			const resolvedByDomain =
				by_domain && Object.keys(by_domain).length > 0 ? by_domain : fromLegacyFlat(legacy);
			const domainAudiences: AudienceSpec[] = [];
			if (resolvedByDomain) {
				for (const [dom, dConfig] of Object.entries(resolvedByDomain)) {
					if (dConfig.audiences) {
						for (const a of dConfig.audiences) {
							domainAudiences.push({
								...a,
								domain: a.domain ?? dom,
							});
						}
					}
				}
			}
			const allAudiences = [...(audiences ?? [])];
			for (const da of domainAudiences) {
				if (!allAudiences.some((a) => a.key.toLowerCase() === da.key.toLowerCase())) {
					allAudiences.push(da);
				}
			}
			const resolvedSync =
				system_instructions_sync ?? claude_instructions_sync ?? pasted_instructions ?? null;
			const resolvedSystemInstructions =
				system_instructions ??
				systemInstructionsHyphen ??
				canonical_instructions ??
				claude_instructions ??
				claudeInstructionsHyphen ??
				null;
			return {
				by_domain: resolvedByDomain,
				types,
				tone,
				operating_principles,
				handshake_instructions: handshake_instructions ?? null,
				system_instructions: resolvedSystemInstructions,
				audiences: allAudiences,
				pasted_instructions: resolvedSync,
				system_instructions_sync: resolvedSync,
			};
		},
	);

export type DosConfig = z.infer<typeof dosConfigSchema>;

export const DEFAULT_DOS_CONFIG: DosConfig = {
	by_domain: {},
	types: [],
	tone: [],
	operating_principles: [],
	handshake_instructions: null,
	system_instructions: null,
	audiences: [],
	pasted_instructions: null,
	system_instructions_sync: null,
};

export type ToneRulesWithConfig = string[] & { dosConfig?: DosConfig };

export function attachDosConfigToToneRules(
	rules: string[],
	config: DosConfig,
): ToneRulesWithConfig {
	const copy = [...rules] as ToneRulesWithConfig;
	Object.defineProperty(copy, "dosConfig", {
		value: config,
		enumerable: false,
		configurable: true,
		writable: false,
	});
	return copy;
}

/**
 * The config block for one domain, or `null` when the blob has none.
 *
 * `null` is not "empty". A domain with no block is UNCONFIGURED, and callers must
 * say so rather than rendering blank lists that read as a deliberate empty answer -
 * ADR-054 section 6 names that confusion as the `097bf71f` failure class.
 */
export function domainConfig(config: DosConfig, domain: Domain): DomainConfig | null {
	return config.by_domain[domain] ?? null;
}

/**
 * The name of the Daily Log property a domain block declares for `role`, or null when
 * it declares none (or there is no block). Code reading config, never prose.
 */
export function dailyLogRoleProperty(block: DomainConfig | null, role: string): string | null {
	return block?.daily_log_schema.properties.find((p) => p.role === role)?.name ?? null;
}

export interface DosConfigRowReader {
	loadDosConfigRow?(): Promise<unknown>;
}

/**
 * How a load went, so a caller can tell "nothing stored" from "stored but unparseable".
 * Before #2256 both produced the same answer, and the advice that followed was to add
 * config that was already there.
 *
 *  - `ok`          parsed cleanly.
 *  - `absent`      nothing stored; `config` is `DEFAULT_DOS_CONFIG`.
 *  - `degraded`    parsed, but one or more soft global keys were malformed and read as
 *                  `[]`; `by_domain` is intact.
 *  - `unparseable` a strict key (e.g. `by_domain`) failed; `config` is `DEFAULT_DOS_CONFIG`.
 */
export type DosConfigLoadStatus = "ok" | "absent" | "degraded" | "unparseable";

export interface DosConfigLoadResult {
	config: DosConfig;
	status: DosConfigLoadStatus;
	/** Zod issue paths and messages, e.g. `tone.0: Invalid input: expected string, received number`. */
	issues: string[];
}

const formatIssues = (issues: z.core.$ZodIssue[], prefix: PropertyKey[] = []): string[] =>
	issues.map((issue) => `${[...prefix, ...issue.path].join(".") || "(root)"}: ${issue.message}`);

/** Issues in the soft global keys, which `.catch([])` otherwise swallows. */
const softGlobalKeyIssues = (raw: unknown): string[] => {
	if (typeof raw !== "object" || raw === null) {
		return [];
	}
	const row = raw as Record<string, unknown>;
	return Object.entries(softGlobalKeySchemas).flatMap(([key, schema]) => {
		if (row[key] === undefined) {
			return [];
		}
		const parsed = schema.safeParse(row[key]);
		return parsed.success ? [] : formatIssues(parsed.error.issues, [key]);
	});
};

/**
 * Load and validate the owner's `user_preferences.dos_config`, reporting how it went.
 * Never silent: a degraded or unparseable config logs its zod issue paths (#2256).
 */
export async function loadDosConfigDetailed(
	repo: DosConfigRowReader,
): Promise<DosConfigLoadResult> {
	if (!repo.loadDosConfigRow) {
		throw new Error("ConfigRepository.loadDosConfigRow is not wired");
	}

	const raw = await repo.loadDosConfigRow();
	if (!raw || raw === DEFAULT_DOS_CONFIG) {
		return { config: DEFAULT_DOS_CONFIG, status: "absent", issues: [] };
	}

	const parsed = dosConfigSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = formatIssues(parsed.error.issues);
		console.error(
			`[dosConfig] user_preferences.dos_config failed validation; falling back to DEFAULT_DOS_CONFIG. Issues: ${issues.join("; ")}`,
		);
		return { config: DEFAULT_DOS_CONFIG, status: "unparseable", issues };
	}

	const softIssues = softGlobalKeyIssues(raw);
	if (softIssues.length > 0) {
		console.error(
			`[dosConfig] user_preferences.dos_config has malformed global keys, read as empty; by_domain is unaffected. Issues: ${softIssues.join("; ")}`,
		);
		return { config: parsed.data, status: "degraded", issues: softIssues };
	}

	return { config: parsed.data, status: "ok", issues: [] };
}

/**
 * Load and validate the owner's `user_preferences.dos_config` through `ConfigRepository` (#1603).
 * Unchanged contract for existing callers; `loadDosConfigDetailed` says how the load went.
 */
export async function loadDosConfig(repo: DosConfigRowReader): Promise<DosConfig> {
	return (await loadDosConfigDetailed(repo)).config;
}

/**
 * Standing engineering and operating heuristics from `user_preferences.dos_config.operating_principles`
 * (#1984). Defaults to `[]` for older rows or when preferences cannot be read.
 */
export function operatingPrinciples(config: DosConfig): string[] {
	return config.operating_principles;
}

/**
 * Format a single domain's configuration (topics, pillars, registers, routing signals)
 * as a compact single-line summary for MCP handshake and system instructions (#1987).
 */
export function formatDomainSummaryLine(
	domainKey: string,
	block: Partial<DomainConfig>,
): string {
	const parts: string[] = [];
	if (block.topics && block.topics.length > 0) {
		parts.push(`topics: ${block.topics.join(", ")}`);
	}
	if (block.pillars && block.pillars.length > 0) {
		const pillarSummaries = block.pillars.map((p) => {
			const opt = pillarNotionOption(p);
			const base = p.label ? `${p.key} ${p.label}` : p.key;
			return opt && opt !== base && opt !== p.label ? `${base} [${opt}]` : base;
		});
		parts.push(`pillars: ${pillarSummaries.join(", ")}`);
	}
	if (block.artefact_registers && block.artefact_registers.length > 0) {
		const regSummaries = block.artefact_registers.map((r) => `${r.key} (${r.tone})`);
		parts.push(`registers: ${regSummaries.join(", ")}`);
	}
	if (block.domain_signals && block.domain_signals.length > 0) {
		parts.push(`signals: ${block.domain_signals.join(", ")}`);
	}
	if (block.waiting_on_status) {
		parts.push(`waiting_on_status: ${block.waiting_on_status}`);
	}
	return `- ${domainKey}: ${parts.length > 0 ? parts.join(" | ") : "(configured)"}`;
}

/**
 * Render all non-empty `user_preferences.dos_config.*` data sections (`tone`,
 * `operating_principles`, `types`, `audiences`, `by_domain`) for injection into
 * the MCP initialize handshake and canonical system instructions (#1987).
 */
export function renderDosConfigSections(
	config?: Partial<DosConfig> | null,
	options?: { toneRulesOverride?: string[] },
): string[] {
	if (!config && (!options?.toneRulesOverride || options.toneRulesOverride.length === 0)) {
		return [];
	}
	const sections: string[] = [];
	const toneRules = options?.toneRulesOverride ?? config?.tone ?? [];
	if (toneRules.length > 0) {
		const rules = toneRules.map((rule) => `- ${rule}`).join("\n");
		sections.push(
			`Owner's writing rules (source of truth: user_preferences.dos_config.tone - ADR-030; re-read each session, #819). Apply to ALL prose addressed to the user, on every surface:\n${rules}`,
		);
	}

	const principlesList = config?.operating_principles ?? [];
	if (principlesList.length > 0) {
		const principles = principlesList.map((p) => `- ${p}`).join("\n");
		sections.push(
			`Operating principles (source of truth: user_preferences.dos_config.operating_principles):\n${principles}`,
		);
	}

	const types = config?.types ?? [];
	if (types.length > 0) {
		const typeLines = types.map((t) => `- ${t.key}: ${t.description}`).join("\n");
		sections.push(
			`Atom types (source of truth: user_preferences.dos_config.types):\n${typeLines}`,
		);
	}

	const audiences = config?.audiences ?? [];
	if (audiences.length > 0) {
		const audienceLines = audiences
			.map((a) => {
				const meta: string[] = [];
				if (a.role) meta.push(a.role);
				if (a.domain) meta.push(`domain: ${a.domain}`);
				if (a.cadence) meta.push(`cadence: ${a.cadence}`);
				const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
				const exclusions =
					a.standing_exclusions && a.standing_exclusions.length > 0
						? ` | Exclusions: ${a.standing_exclusions.join("; ")}`
						: "";
				return `- ${a.key}${metaStr}: ${a.register}${exclusions}`;
			})
			.join("\n");
		sections.push(
			`Audiences (source of truth: user_preferences.dos_config.audiences):\n${audienceLines}`,
		);
	}

	const byDomain = config?.by_domain ?? {};
	const domainEntries = Object.entries(byDomain);
	if (domainEntries.length > 0) {
		const domainLines = domainEntries
			.map(([domKey, block]) => formatDomainSummaryLine(domKey, block))
			.join("\n");
		sections.push(
			`Domains (source of truth: user_preferences.dos_config.by_domain):\n${domainLines}`,
		);
	}

	return sections;
}

/**
 * All configured audience specs across all domains (ADR-051 section 4 / ADR-054 section 4).
 */
export function audienceSpecs(config: DosConfig): AudienceSpec[] {
	return config.audiences;
}

/**
 * Find an audience spec by key (case-insensitive).
 */
export function findAudienceSpec(config: DosConfig, key: string): AudienceSpec | null {
	const normalized = key.trim().toLowerCase();
	return config.audiences.find((a) => a.key.trim().toLowerCase() === normalized) ?? null;
}

/**
 * Filter audience specs by domain (or global specs with no domain set).
 */
export function audienceSpecsForDomain(config: DosConfig, domain: Domain | string): AudienceSpec[] {
	const normalizedDomain = domain.trim().toLowerCase();
	return config.audiences.filter(
		(a) => !a.domain || a.domain.trim().toLowerCase() === normalizedDomain,
	);
}
