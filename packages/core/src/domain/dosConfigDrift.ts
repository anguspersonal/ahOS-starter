import { pillarNotionOption, type DomainConfig, type DailyLogProperty } from "./dosConfig.js";
import { COVERS_ROLE, COVERS_TYPES } from "./dailyLogCovers.js";
import type { NotionDatabaseSchema } from "../index.js";

// Reconcile a domain's dos config against the LIVE Notion Daily Log schema (#656).
//
// THE DEFECT THIS EXISTS TO CATCH
// `dos_config` is authored independently of the Notion schema and, until this
// module, nothing compared the two. Both halves of #656 are that one defect: config
// offered `Round`, `Product` and `EHS` as topics when `Other domains` had no such
// options, and a day of product work was filed as `Ops, Other` because the write blew
// up at the last step of a ritual whose every prior step had succeeded. Same shape as
// #655's unreachable State Doc: discovered at the write, after all the reads.
//
// DIRECTION IS ASYMMETRIC, AND THAT IS THE WHOLE DESIGN — CONFIG ⊆ NOTION
//   * A CONFIG value with no live Notion option is a FAILURE. It cannot be written:
//     depending on the path Notion either rejects it (#656's observed 400) or silently
//     CREATES it (#695), and the silent branch is the worse one because it invents a
//     taxonomy entry in the owner's real workspace.
//   * A NOTION option absent from config is INFORMATIONAL and must never fail. That is
//     how retired vocabulary is meant to age: `Personal` was removed from config by
//     ADR-054 §2 and `P1 Launch`/`P3 EHS` by #692, and all of them stay in Notion so
//     historical entries still read correctly. Deleting a Notion option strips it from
//     every page that ever carried it, so the config side is the only side that
//     shrinks.
//
// NOTHING HERE FAILS A RUN. This module returns findings; the caller decides. See
// tools/checkDosConfigDrift.ts for the severity rules, which is where the reason a
// drift must NOT abort the ritual is written down.

/** A config list whose values are written into one Notion Daily Log property. */
export type VocabularyKey = "topics" | "pillars";

/**
 * Which declared Daily Log property each config vocabulary is written into.
 *
 * THIS TABLE IS THE EXISTING PROSE CONVENTION, MADE EXECUTABLE. It is deliberately NOT
 * the structural join #703 asks for, and it must not grow into one here.
 *
 * Today the only statement of "topics go to `Other domains`, pillar options go to
 * `Pillars`" is prose — migration 089's property note, `dos_config_get`'s renderer
 * note, and dos Steps 4 and 8a. #703 will put the join in config and this table
 * collapses to reading that field.
 *
 * WHY A LITERAL HERE DOES NOT BREAK MIGRATION 087's RULE ("Notion property names live
 * in config, never in code"). These strings are SELECTORS OVER CONFIG. They pick which
 * `daily_log_schema.properties` entry to read, and the name that is then matched
 * against Notion is that entry's own `name`, straight from config. No string in this
 * file is ever sent to Notion or written to a page. So if the owner renames the Notion
 * property and updates config to match, the selector stops resolving and this check
 * reports `unresolved` — it cannot check the wrong property, and it cannot address
 * Notion by a stale name. Degrading to "I could not verify this" is the only safe
 * failure mode for a lookup that is guessing, and it is why `unresolved` is
 * informational rather than a drift.
 */
const VOCABULARY_BINDINGS: { vocabulary: VocabularyKey; conventionalProperty: string }[] = [
	{ vocabulary: "topics", conventionalProperty: "Other domains" },
	{ vocabulary: "pillars", conventionalProperty: "Pillars" },
];

/**
 * What became of one vocabulary.
 *
 *   ok           every configured value is a live Notion option.
 *   drift        at least one configured value is not — `missing` names them.
 *   no_options   the live property exists but declares NO options, so it enforces
 *                nothing and every value would be CREATED on write (#695). Distinct
 *                from `drift`: "your vocabulary is wrong" and "there is no vocabulary
 *                to be wrong against" need different fixes.
 *   absent       config declares the property but Notion does not have it. Every write
 *                to it fails, so this is drift of the destination itself.
 *   unresolved   config declares no property under the conventional name, so the
 *                binding could not be resolved at all (#703). Not a failure.
 *   empty        config configures no values for this vocabulary, so nothing would be
 *                written and nothing can be wrong. Checked before the destination is
 *                even resolved, since a missing destination for a write that never
 *                happens is not a fault.
 */
export type VocabularyStatus =
	| "ok"
	| "drift"
	| "no_options"
	| "absent"
	| "unresolved"
	| "empty";

export type VocabularyReconciliation = {
	vocabulary: VocabularyKey;
	/** The property name taken from config, or `null` when the binding did not resolve. */
	property: string | null;
	status: VocabularyStatus;
	/** Every value config would write, in config order. */
	configured: string[];
	/** Configured values with no live Notion option. These must not be written. */
	missing: string[];
	/** Live Notion options config does not offer. Informational — never a failure. */
	unused: string[];
};

export type PropertyStatus =
	| "ok"
	| "missing_required"
	| "missing_optional"
	| "type_mismatch"
	| "missing_options"
	| "no_options";

export type PropertyReconciliation = {
	name: string;
	role?: string;
	required: boolean;
	status: PropertyStatus;
	expectedType: string;
	actualType?: string;
	expectedOptions?: string[];
	availableOptions?: string[];
	missingOptions?: string[];
	detail?: string;
	remediation?: string;
};

export type DriftReport = {
	vocabularies: VocabularyReconciliation[];
	properties?: PropertyReconciliation[];
};

/** The values config would write for one vocabulary, in config order, blanks dropped. */
function configuredValues(block: DomainConfig, vocabulary: VocabularyKey): string[] {
	const raw =
		vocabulary === "topics"
			? block.topics
			: // A pillar with no option does not project; it is not a value at all, and
				// reporting it as a missing one would demand an option for a pillar that is
				// deliberately Notion-invisible.
				block.pillars.map(pillarNotionOption).filter((o): o is string => o !== null);

	return raw.map((v) => v.trim()).filter((v) => v.length > 0);
}

function reconcileVocabulary(
	block: DomainConfig,
	live: NotionDatabaseSchema,
	binding: { vocabulary: VocabularyKey; conventionalProperty: string },
): VocabularyReconciliation {
	const configured = configuredValues(block, binding.vocabulary);
	const base = { vocabulary: binding.vocabulary, configured, missing: [], unused: [] };

	// Empty short-circuits everything, and it must come FIRST. A vocabulary that would
	// write nothing cannot be at fault, so resolving its destination — and reporting the
	// destination missing — would be a false alarm about a write that never happens.
	if (configured.length === 0) return { ...base, property: null, status: "empty" };

	// Resolve the destination property from config.
	// For pillars (#703), resolution requires an explicit `role: "pillars"` property declaration.
	// A non-empty pillars[] with no role declared is flagged as drift.
	const declared =
		binding.vocabulary === "pillars"
			? block.daily_log_schema.properties.find((p) => p.role === "pillars")
			: block.daily_log_schema.properties.find((p) => p.name === binding.conventionalProperty);

	if (!declared) {
		if (binding.vocabulary === "pillars") {
			return { ...base, property: null, status: "drift" };
		}
		return { ...base, property: null, status: "unresolved" };
	}

	const property = declared.name;
	const liveProperty = live.properties.find((p) => p.name === property);
	if (!liveProperty) return { ...base, property, status: "absent" };

	const options = liveProperty.options ?? [];
	if (options.length === 0) return { ...base, property, status: "no_options" };

	const missing = configured.filter((v) => !options.includes(v));
	const unused = options.filter((o) => !configured.includes(o));

	return {
		...base,
		property,
		status: missing.length > 0 ? "drift" : "ok",
		missing,
		unused,
	};
}

export const REQUIRED_SELECT_OPTIONS: Record<string, readonly string[]> = {
	Type: ["Daily", "Catch-up"],
	"Synthesis Status": ["Confirmed", "Unconfirmed"],
};

export const REQUIRED_ROLE_OPTIONS: Record<string, readonly string[]> = {
	type: ["Daily", "Catch-up"],
	synthesis_status: ["Confirmed", "Unconfirmed"],
};

export function reconcileProperty(
	declared: DailyLogProperty,
	live: NotionDatabaseSchema,
	domain?: string,
): PropertyReconciliation {
	const domainDesc = domain ? ` (${domain} workspace)` : "";
	const liveProp =
		live.properties.find((p) => p.name === declared.name) ??
		live.properties.find((p) => p.name.toLowerCase() === declared.name.toLowerCase());

	if (!liveProp) {
		if (declared.required) {
			return {
				name: declared.name,
				role: declared.role,
				required: true,
				status: "missing_required",
				expectedType: declared.notion_type,
				detail: `required property '${declared.name}' does not exist on the live Daily Log database.`,
				remediation: `Add property '${declared.name}' (${declared.notion_type}) to the Daily Log database in Notion${domainDesc}.`,
			};
		}
		if (declared.role === COVERS_ROLE) {
			return {
				name: declared.name,
				role: declared.role,
				required: false,
				status: "missing_optional",
				expectedType: (COVERS_TYPES as readonly string[]).join(" | "),
				detail: `property '${declared.name}' (role '${COVERS_ROLE}') does not exist on the live Daily Log database (#1016). Covers will be omitted from entries.`,
				remediation: `Add property '${declared.name}' (type rich_text or multi_select) to the Daily Log database in Notion${domainDesc} (#1016).`,
			};
		}
		return {
			name: declared.name,
			role: declared.role,
			required: false,
			status: "missing_optional",
			expectedType: declared.notion_type,
			detail: `optional property '${declared.name}' does not exist on the live Daily Log database.`,
			remediation: `Add property '${declared.name}' (${declared.notion_type}) to the Daily Log database in Notion${domainDesc}, or remove from dos_config.`,
		};
	}

	// Type compatibility check
	if (declared.role === COVERS_ROLE) {
		if (!(COVERS_TYPES as readonly string[]).includes(liveProp.type)) {
			return {
				name: declared.name,
				role: declared.role,
				required: declared.required,
				status: "type_mismatch",
				expectedType: (COVERS_TYPES as readonly string[]).join(" | "),
				actualType: liveProp.type,
				detail: `property '${declared.name}' (role '${COVERS_ROLE}') is type '${liveProp.type}' in Notion, expected rich_text or multi_select (#1016). Covers will be omitted from entries.`,
				remediation: `Change '${declared.name}' property type in Notion${domainDesc} to rich_text or multi_select, or fix config (#1016).`,
			};
		}
	} else if (liveProp.type !== declared.notion_type) {
		return {
			name: declared.name,
			role: declared.role,
			required: declared.required,
			status: "type_mismatch",
			expectedType: declared.notion_type,
			actualType: liveProp.type,
			detail: `property '${declared.name}' is type '${liveProp.type}' in Notion, expected '${declared.notion_type}'.`,
			remediation: `Change '${declared.name}' property type in Notion${domainDesc} to '${declared.notion_type}', or update daily_log_schema in dos_config.`,
		};
	}

	// Select options check
	const isSelectLike = liveProp.type === "select" || liveProp.type === "multi_select" || liveProp.type === "status";
	if (isSelectLike) {
		const expectedSet = new Set<string>();
		if (REQUIRED_SELECT_OPTIONS[declared.name]) {
			for (const opt of REQUIRED_SELECT_OPTIONS[declared.name]) expectedSet.add(opt);
		}
		if (declared.role && REQUIRED_ROLE_OPTIONS[declared.role]) {
			for (const opt of REQUIRED_ROLE_OPTIONS[declared.role]) expectedSet.add(opt);
		}
		if (declared.options) {
			for (const opt of declared.options) expectedSet.add(opt);
		}

		if (expectedSet.size > 0) {
			const expectedOptions = Array.from(expectedSet);
			const liveOptions = liveProp.options ?? [];

			if (liveOptions.length === 0) {
				return {
					name: declared.name,
					role: declared.role,
					required: declared.required,
					status: "no_options",
					expectedType: declared.notion_type,
					actualType: liveProp.type,
					expectedOptions,
					availableOptions: [],
					detail: `property '${declared.name}' has no options defined in Notion; Notion will create any option written on write (#695).`,
					remediation: `Define expected option(s) ${expectedOptions.map((o) => `'${o}'`).join(", ")} on '${declared.name}' in Notion${domainDesc}.`,
				};
			}

			const missingOptions = expectedOptions.filter((opt) => !liveOptions.includes(opt));
			if (missingOptions.length > 0) {
				return {
					name: declared.name,
					role: declared.role,
					required: declared.required,
					status: "missing_options",
					expectedType: declared.notion_type,
					actualType: liveProp.type,
					expectedOptions,
					availableOptions: liveOptions,
					missingOptions,
					detail: `property '${declared.name}' is missing required option(s): ${missingOptions.join(", ")}. Available: ${liveOptions.join(", ")}.`,
					remediation: `Add option(s) ${missingOptions.map((o) => `'${o}'`).join(", ")} to the '${declared.name}' property in Notion${domainDesc}.`,
				};
			}

			return {
				name: declared.name,
				role: declared.role,
				required: declared.required,
				status: "ok",
				expectedType: declared.notion_type,
				actualType: liveProp.type,
				expectedOptions,
				availableOptions: liveOptions,
			};
		}
	}

	return {
		name: declared.name,
		role: declared.role,
		required: declared.required,
		status: "ok",
		expectedType: declared.notion_type,
		actualType: liveProp.type,
	};
}

/**
 * Compare one domain's configured vocabularies and schema properties against the live Daily Log schema.
 *
 * Pure: both inputs are supplied, nothing is read or written, and the same pair always
 * produces the same report. The I/O — and the decision about what a finding MEANS for a
 * running ritual — belongs to the caller.
 */
export function reconcileDomainConfig(
	block: DomainConfig,
	live: NotionDatabaseSchema,
	domain?: string,
): DriftReport {
	const declaredProps = block.daily_log_schema?.properties ?? [];
	return {
		vocabularies: VOCABULARY_BINDINGS.map((b) => reconcileVocabulary(block, live, b)),
		properties: declaredProps.map((p) => reconcileProperty(p, live, domain)),
	};
}

/**
 * The configured values a ritual must NOT write, because Notion has no such option.
 *
 * This is the actionable half of the report. Quarantining is strictly better than the
 * status quo it replaces: every one of these values already fails at the write (or,
 * worse, silently creates an option), so withholding them loses nothing that ever
 * worked and costs one bad write per run.
 */
export function quarantinedValues(report: DriftReport): string[] {
	return report.vocabularies.flatMap((v) =>
		// `absent` has no live option set to compare each value against, so nothing lands
		// in `missing` — but the destination property itself is gone, so EVERY configured
		// value is unwritable. Similarly, when pillars[] is non-empty and no property
		// carries role 'pillars' (#703), nothing can be written and every configured value
		// is quarantined.
		v.status === "absent" || (v.status === "drift" && v.property === null)
			? v.configured
			: v.missing,
	);
}

/**
 * The vocabularies nothing was compared against, so their silence is not an all-clear.
 *
 *   no_options   the live property enforces nothing, so every value would be CREATED on
 *                write (#695) rather than rejected — the failure that does not announce
 *                itself, and the state the personal Daily Log is documented to be in.
 *   unresolved   config declares no property under the conventional name (#703), so
 *                there was no destination to reconcile against.
 *
 * `empty` is deliberately NOT here. A vocabulary that would write nothing has nothing to
 * verify, so "every configured value exists in Notion" is vacuously true of it rather
 * than unknown.
 */
export function unverifiedVocabularies(report: DriftReport): VocabularyReconciliation[] {
	return report.vocabularies.filter(
		(v) => v.status === "no_options" || v.status === "unresolved",
	);
}

export function isPropertyDrift(p: PropertyReconciliation): boolean {
	return (
		p.status === "missing_required" ||
		p.status === "type_mismatch" ||
		p.status === "missing_options" ||
		(p.status === "missing_optional" && p.role === COVERS_ROLE)
	);
}

export function propertyDriftFindings(report: DriftReport): PropertyReconciliation[] {
	return (report.properties ?? []).filter(isPropertyDrift);
}

export function unverifiedProperties(report: DriftReport): PropertyReconciliation[] {
	return (report.properties ?? []).filter((p) => p.status === "no_options");
}

/** True when at least one configured vocabulary value cannot be written. */
export function hasDrift(report: DriftReport): boolean {
	return report.vocabularies.some((v) => v.status === "drift" || v.status === "absent");
}

/** True when at least one schema property is missing, has mismatched type, or lacks required options. */
export function hasPropertyDrift(report: DriftReport): boolean {
	return propertyDriftFindings(report).length > 0;
}
