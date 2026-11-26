import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type {
	ConfigPreferencesRepository,
	DosArtefactRegisterSpec,
	DosAtomType,
	DosAudienceSpec,
	DosConfigRecord,
	DosDailyLogPropertySpec,
	DosDomainConfig,
	DosOperatingPrinciple,
	DosPillarSpec,
	UserPreferencesRow,
} from "../../ports/config.js";

const nonEmptyTrimmedString = z.string().trim().min(1);

// ── confidence_thresholds JSONB sub-shape ───────────────────────────────────

const confidenceWindowSchema = z.object({
	block: z.number().int().min(0).max(100).optional(),
	review: z.number().int().min(0).max(100).optional(),
	auto_apply: z.number().int().min(0).max(100).optional(),
});

export const confidenceThresholdsSchema = z
	.object({
		task_creation: confidenceWindowSchema.optional(),
		entity_creation: confidenceWindowSchema.optional(),
		artifact_linking: confidenceWindowSchema.optional(),
		relationship_suggestion: confidenceWindowSchema.optional(),
		security_classification: confidenceWindowSchema.optional(),
	})
	.optional();

// ── notification_preferences JSONB sub-shape ────────────────────────────────

const alertConditionSchema = z.object({
	enabled: z.boolean().optional(),
	threshold_days: z.number().positive().optional(),
});

const exceptionAlertsSchema = z.object({
	enabled: z.boolean().optional(),
	ritual_silent: alertConditionSchema.optional(),
	source_silent: alertConditionSchema
		.extend({
			sources: z.array(z.string()).optional(),
			discovery_window_days: z.number().positive().optional(),
			min_observations: z.number().positive().optional(),
		})
		.optional(),
});

export const notificationPreferencesSchema = z
	.object({
		review_items: z.boolean().optional(),
		daily_summary: z.boolean().optional(),
		task_reminders: z.boolean().optional(),
		event_reminders: z.boolean().optional(),
		exception_alerts: exceptionAlertsSchema.optional(),
	})
	.optional();

// ── dos_config item schemas & CRUD envelopes ────────────────────────────────

const crudOpEnum = z.enum(["add", "update", "remove", "replace"]);

const stringReplacementPairSchema = z.object({
	match: nonEmptyTrimmedString,
	value: nonEmptyTrimmedString,
});

const stringArrayCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	item: nonEmptyTrimmedString.optional(),
	items: z.array(nonEmptyTrimmedString).optional(),
	match: nonEmptyTrimmedString.optional(),
	value: z.union([nonEmptyTrimmedString, z.array(nonEmptyTrimmedString)]).optional(),
	add: z.union([nonEmptyTrimmedString, z.array(nonEmptyTrimmedString)]).optional(),
	update: z
		.union([stringReplacementPairSchema, z.array(stringReplacementPairSchema)])
		.optional(),
	remove: z.union([nonEmptyTrimmedString, z.array(nonEmptyTrimmedString)]).optional(),
	replace: z.array(nonEmptyTrimmedString).optional(),
});

const stringArrayOrCrudSchema = z.union([
	z.array(nonEmptyTrimmedString),
	stringArrayCrudObjectSchema,
]);

export const dosAtomTypeSchema = z.object({
	key: nonEmptyTrimmedString,
	description: nonEmptyTrimmedString,
});

export const dosAtomTypePatchSchema = z.object({
	match: nonEmptyTrimmedString.optional(),
	key: nonEmptyTrimmedString,
	description: nonEmptyTrimmedString.optional(),
});

const atomTypeCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	key: nonEmptyTrimmedString.optional(),
	keys: z.array(nonEmptyTrimmedString).optional(),
	item: z.union([dosAtomTypeSchema, dosAtomTypePatchSchema]).optional(),
	items: z.array(z.union([dosAtomTypeSchema, dosAtomTypePatchSchema])).optional(),
	add: z.union([dosAtomTypeSchema, z.array(dosAtomTypeSchema)]).optional(),
	update: z.union([dosAtomTypePatchSchema, z.array(dosAtomTypePatchSchema)]).optional(),
	remove: z
		.union([
			nonEmptyTrimmedString,
			z.array(nonEmptyTrimmedString),
			z.object({ key: nonEmptyTrimmedString }),
			z.array(z.object({ key: nonEmptyTrimmedString })),
		])
		.optional(),
	replace: z.array(dosAtomTypeSchema).optional(),
});

export const dosOperatingPrincipleObjectSchema = z.object({
	key: nonEmptyTrimmedString,
	description: nonEmptyTrimmedString,
});

export const dosOperatingPrincipleItemSchema = z.union([
	nonEmptyTrimmedString,
	dosOperatingPrincipleObjectSchema,
]);

const operatingPrincipleUpdatePairSchema = z.object({
	key: nonEmptyTrimmedString.optional(),
	match: nonEmptyTrimmedString.optional(),
	description: nonEmptyTrimmedString.optional(),
	value: dosOperatingPrincipleItemSchema.optional(),
});

const operatingPrinciplesCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	key: nonEmptyTrimmedString.optional(),
	keys: z.array(nonEmptyTrimmedString).optional(),
	match: nonEmptyTrimmedString.optional(),
	value: z
		.union([dosOperatingPrincipleItemSchema, z.array(dosOperatingPrincipleItemSchema)])
		.optional(),
	item: z
		.union([dosOperatingPrincipleItemSchema, operatingPrincipleUpdatePairSchema])
		.optional(),
	items: z
		.array(z.union([dosOperatingPrincipleItemSchema, operatingPrincipleUpdatePairSchema]))
		.optional(),
	add: z
		.union([dosOperatingPrincipleItemSchema, z.array(dosOperatingPrincipleItemSchema)])
		.optional(),
	update: z
		.union([
			operatingPrincipleUpdatePairSchema,
			z.array(operatingPrincipleUpdatePairSchema),
		])
		.optional(),
	remove: z
		.union([
			nonEmptyTrimmedString,
			z.array(nonEmptyTrimmedString),
			z.object({ key: nonEmptyTrimmedString }),
			z.array(z.object({ key: nonEmptyTrimmedString })),
		])
		.optional(),
	replace: z.array(dosOperatingPrincipleItemSchema).optional(),
});

export const dosAudienceSpecSchema = z.object({
	key: nonEmptyTrimmedString,
	role: z.string().optional(),
	domain: z.string().optional(),
	register: nonEmptyTrimmedString,
	standing_exclusions: z.array(z.string()).optional(),
	examples: z.array(z.string()).optional(),
	cadence: z.string().optional(),
});

export const dosAudienceSpecPatchSchema = z.object({
	match: nonEmptyTrimmedString.optional(),
	key: nonEmptyTrimmedString,
	role: z.string().optional(),
	domain: z.string().optional(),
	register: nonEmptyTrimmedString.optional(),
	standing_exclusions: z.array(z.string()).optional(),
	examples: z.array(z.string()).optional(),
	cadence: z.string().optional(),
});

const audienceCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	key: nonEmptyTrimmedString.optional(),
	keys: z.array(nonEmptyTrimmedString).optional(),
	item: z.union([dosAudienceSpecSchema, dosAudienceSpecPatchSchema]).optional(),
	items: z.array(z.union([dosAudienceSpecSchema, dosAudienceSpecPatchSchema])).optional(),
	add: z.union([dosAudienceSpecSchema, z.array(dosAudienceSpecSchema)]).optional(),
	update: z
		.union([dosAudienceSpecPatchSchema, z.array(dosAudienceSpecPatchSchema)])
		.optional(),
	remove: z
		.union([
			nonEmptyTrimmedString,
			z.array(nonEmptyTrimmedString),
			z.object({ key: nonEmptyTrimmedString }),
			z.array(z.object({ key: nonEmptyTrimmedString })),
		])
		.optional(),
	replace: z.array(dosAudienceSpecSchema).optional(),
});

export const dosPillarSpecSchema = z.object({
	key: nonEmptyTrimmedString,
	label: nonEmptyTrimmedString,
	description: nonEmptyTrimmedString,
	notion_option: nonEmptyTrimmedString.optional(),
	notion_property: nonEmptyTrimmedString.optional(),
});

export const dosPillarSpecPatchSchema = z.object({
	match: nonEmptyTrimmedString.optional(),
	key: nonEmptyTrimmedString,
	label: nonEmptyTrimmedString.optional(),
	description: nonEmptyTrimmedString.optional(),
	notion_option: nonEmptyTrimmedString.optional(),
	notion_property: nonEmptyTrimmedString.optional(),
});

const pillarCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	key: nonEmptyTrimmedString.optional(),
	keys: z.array(nonEmptyTrimmedString).optional(),
	item: z.union([dosPillarSpecSchema, dosPillarSpecPatchSchema]).optional(),
	items: z.array(z.union([dosPillarSpecSchema, dosPillarSpecPatchSchema])).optional(),
	add: z.union([dosPillarSpecSchema, z.array(dosPillarSpecSchema)]).optional(),
	update: z.union([dosPillarSpecPatchSchema, z.array(dosPillarSpecPatchSchema)]).optional(),
	remove: z
		.union([
			nonEmptyTrimmedString,
			z.array(nonEmptyTrimmedString),
			z.object({ key: nonEmptyTrimmedString }),
			z.array(z.object({ key: nonEmptyTrimmedString })),
		])
		.optional(),
	replace: z.array(dosPillarSpecSchema).optional(),
});

export const dosArtefactRegisterSpecSchema = z.object({
	key: nonEmptyTrimmedString,
	tone: nonEmptyTrimmedString,
});

export const dosArtefactRegisterPatchSchema = z.object({
	match: nonEmptyTrimmedString.optional(),
	key: nonEmptyTrimmedString,
	tone: nonEmptyTrimmedString.optional(),
});

const artefactRegisterCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	key: nonEmptyTrimmedString.optional(),
	keys: z.array(nonEmptyTrimmedString).optional(),
	item: z
		.union([dosArtefactRegisterSpecSchema, dosArtefactRegisterPatchSchema])
		.optional(),
	items: z
		.array(z.union([dosArtefactRegisterSpecSchema, dosArtefactRegisterPatchSchema]))
		.optional(),
	add: z
		.union([dosArtefactRegisterSpecSchema, z.array(dosArtefactRegisterSpecSchema)])
		.optional(),
	update: z
		.union([dosArtefactRegisterPatchSchema, z.array(dosArtefactRegisterPatchSchema)])
		.optional(),
	remove: z
		.union([
			nonEmptyTrimmedString,
			z.array(nonEmptyTrimmedString),
			z.object({ key: nonEmptyTrimmedString }),
			z.array(z.object({ key: nonEmptyTrimmedString })),
		])
		.optional(),
	replace: z.array(dosArtefactRegisterSpecSchema).optional(),
});

export const dosDailyLogPropertySpecSchema = z.object({
	name: nonEmptyTrimmedString,
	notion_type: nonEmptyTrimmedString,
	required: z.boolean(),
	notes: z.string().optional(),
	role: z.string().optional(),
	options: z.array(z.string()).optional(),
});

export const dosDailyLogPropertyPatchSchema = z.object({
	match: nonEmptyTrimmedString.optional(),
	name: nonEmptyTrimmedString,
	notion_type: nonEmptyTrimmedString.optional(),
	required: z.boolean().optional(),
	notes: z.string().optional(),
	role: z.string().optional(),
	options: z.array(z.string()).optional(),
});

const dailyLogPropertyCrudObjectSchema = z.object({
	op: crudOpEnum.optional(),
	name: nonEmptyTrimmedString.optional(),
	names: z.array(nonEmptyTrimmedString).optional(),
	item: z
		.union([dosDailyLogPropertySpecSchema, dosDailyLogPropertyPatchSchema])
		.optional(),
	items: z
		.array(z.union([dosDailyLogPropertySpecSchema, dosDailyLogPropertyPatchSchema]))
		.optional(),
	add: z
		.union([dosDailyLogPropertySpecSchema, z.array(dosDailyLogPropertySpecSchema)])
		.optional(),
	update: z
		.union([dosDailyLogPropertyPatchSchema, z.array(dosDailyLogPropertyPatchSchema)])
		.optional(),
	remove: z
		.union([
			nonEmptyTrimmedString,
			z.array(nonEmptyTrimmedString),
			z.object({ name: nonEmptyTrimmedString }),
			z.array(z.object({ name: nonEmptyTrimmedString })),
		])
		.optional(),
	replace: z.array(dosDailyLogPropertySpecSchema).optional(),
});

export const dosDailyLogSchemaUpdateSchema = z.object({
	properties: z
		.union([z.array(dosDailyLogPropertySpecSchema), dailyLogPropertyCrudObjectSchema])
		.optional(),
	body_sections: stringArrayOrCrudSchema.optional(),
});

export const dosStateDocRulesUpdateSchema = z.object({
	max_words: z.number().int().positive().optional(),
	open_actions_cap: z.number().int().positive().optional(),
	communications_cap: z.number().int().positive().optional(),
});

export const dosDomainConfigUpdateSchema = z.object({
	topics: stringArrayOrCrudSchema.optional(),
	pillars: z.union([z.array(dosPillarSpecSchema), pillarCrudObjectSchema]).optional(),
	domain_signals: stringArrayOrCrudSchema.optional(),
	artefact_registers: z
		.union([z.array(dosArtefactRegisterSpecSchema), artefactRegisterCrudObjectSchema])
		.optional(),
	audiences: z
		.union([z.array(dosAudienceSpecSchema), audienceCrudObjectSchema])
		.optional(),
	state_doc_rules: dosStateDocRulesUpdateSchema.optional(),
	daily_log_schema: dosDailyLogSchemaUpdateSchema.optional(),
	waiting_on_status: z.string().nullable().optional(),
});

export const dosPastedInstructionsUpdateSchema = z
	.object({
		sha256: nonEmptyTrimmedString,
		pasted_at: nonEmptyTrimmedString,
	})
	.nullable();

export const dosConfigUpdateSchema = z
	.object({
		tone: stringArrayOrCrudSchema.optional(),
		operating_principles: z
			.union([
				z.array(dosOperatingPrincipleItemSchema),
				operatingPrinciplesCrudObjectSchema,
			])
			.optional(),
		handshake_instructions: z
			.union([
				nonEmptyTrimmedString,
				z.array(nonEmptyTrimmedString),
				stringArrayCrudObjectSchema,
			])
			.optional(),
		types: z.union([z.array(dosAtomTypeSchema), atomTypeCrudObjectSchema]).optional(),
		audiences: z
			.union([z.array(dosAudienceSpecSchema), audienceCrudObjectSchema])
			.optional(),
		by_domain: z.record(z.string(), dosDomainConfigUpdateSchema).optional(),
		pasted_instructions: dosPastedInstructionsUpdateSchema.optional(),
		allow_pillar_removal: z.boolean().optional(),
		allow_pillar_option_removal: z.boolean().optional(),
	})
	.optional();

export const configPreferencesUpdateInput = {
	// ── Scalar columns ──────────────────────────────────────────────────────
	user_mode: z
		.enum(["casual", "power"])
		.optional()
		.describe("How the UI/agent presents options to you ('casual' | 'power')."),
	automation_level: z
		.enum(["manual", "balanced", "aggressive"])
		.optional()
		.describe(
			"How autonomously the system acts without asking ('manual' | 'balanced' | 'aggressive').",
		),
	global_confidence_threshold: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe(
			"Fallback confidence threshold (0-100) used when a per-category threshold is not set.",
		),
	show_lifecycle_details: z
		.boolean()
		.optional()
		.describe("Show artifact lifecycle stage details in the app UI."),
	safe_mode: z
		.boolean()
		.optional()
		.describe("Prefer non-destructive routing (archive/move) over permanent deletion."),
	has_completed_onboarding: z
		.boolean()
		.optional()
		.describe("Mark onboarding as completed."),

	// ── JSONB blobs (deep-merged with existing values) ──────────────────────
	confidence_thresholds: confidenceThresholdsSchema.describe(
		"Per-category confidence thresholds. Supply only the categories you want to change - others are preserved.",
	),
	notification_preferences: notificationPreferencesSchema.describe(
		"Notification toggles. Supply only the keys you want to change - others are preserved. `exception_alerts` configures the worker's exception-only alert evaluator (#573: ritual silent / ingestion source silent) - thresholds and enable/disable, editable without a deploy per ADR-030. NOTE: the merge is top-level, so supplying `exception_alerts` replaces the whole nested object; send the full blob you want stored. `daily_summary` is a legacy unimplemented boolean - nothing acts on it.",
	),
	dos_config: dosConfigUpdateSchema.describe(
		"Validated deep-merge and array-item (add, update, remove, replace) CRUD across user_preferences.dos_config (tone, operating_principles, handshake_instructions, types, audiences, by_domain, pasted_instructions).",
	),
	allow_pillar_removal: z
		.boolean()
		.optional()
		.describe(
			"Explicitly allow removing or renaming an existing Notion pillar option in dos_config.by_domain.<domain>.pillars (#692).",
		),
	allow_pillar_option_removal: z
		.boolean()
		.optional()
		.describe(
			"Alias for allow_pillar_removal: explicitly allow removing or renaming an existing Notion pillar option in dos_config.by_domain.<domain>.pillars (#692).",
		),
} as const;

export const configPreferencesUpdateSchema = z.object(configPreferencesUpdateInput);
export type ConfigPreferencesUpdateInput = z.infer<typeof configPreferencesUpdateSchema>;

export interface ConfigPreferencesUpdateOutput {
	updated: boolean;
	changedKeys: string[];
	row: UserPreferencesRow | null;
}

// ── Merge & CRUD helpers ────────────────────────────────────────────────────

function toArray<T>(val: T | readonly T[] | undefined): T[] {
	if (val === undefined) return [];
	return Array.isArray(val) ? [...val] : [val as T];
}

function applyStringArrayCrud(
	existing: unknown,
	spec: z.infer<typeof stringArrayOrCrudSchema>,
): string[] {
	const current = Array.isArray(existing)
		? existing.filter((v): v is string => typeof v === "string")
		: typeof existing === "string" && existing.trim().length > 0
			? [existing]
			: [];

	if (Array.isArray(spec)) {
		return [...spec];
	}

	let next = [...current];

	if (spec.replace !== undefined) {
		next = [...spec.replace];
	} else if (spec.op === "replace") {
		const replacements =
			spec.items ?? (spec.value !== undefined ? toArray(spec.value) : toArray(spec.item));
		next = [...replacements];
	}

	const toAdd: string[] = [
		...toArray(spec.add),
		...(spec.op === "add"
			? [
					...toArray(spec.item),
					...(spec.items ?? []),
					...(spec.value !== undefined ? toArray(spec.value) : []),
				]
			: []),
	];
	for (const entry of toAdd) {
		if (!next.includes(entry)) {
			next.push(entry);
		}
	}

	const toUpdate: Array<{ match: string; value: string }> = [
		...toArray(spec.update),
		...(spec.op === "update" && spec.match !== undefined && typeof spec.value === "string"
			? [{ match: spec.match, value: spec.value }]
			: []),
	];
	for (const { match, value } of toUpdate) {
		const idx = next.indexOf(match);
		if (idx === -1) {
			throw new Error(`Cannot update string item '${match}': item not found`);
		}
		next[idx] = value;
	}

	const toRemove = new Set<string>([
		...toArray(spec.remove),
		...(spec.op === "remove"
			? [
					...toArray(spec.item),
					...(spec.items ?? []),
					...toArray(spec.match),
					...(spec.value !== undefined ? toArray(spec.value) : []),
				]
			: []),
	]);
	if (toRemove.size > 0) {
		next = next.filter((item) => !toRemove.has(item));
	}

	return next;
}

function applyKeyedArrayCrud<T extends object>(
	existing: unknown,
	spec: T[] | Record<string, unknown>,
	keyField: string,
	sectionLabel: string,
): T[] {
	const getField = (obj: unknown): string =>
		obj && typeof obj === "object"
			? String((obj as Record<string, unknown>)[keyField] ?? "").trim()
			: "";

	const current: T[] = Array.isArray(existing)
		? existing.filter(
				(item): item is T =>
					Boolean(item) && typeof item === "object" && !Array.isArray(item),
			)
		: [];

	if (Array.isArray(spec)) {
		return spec.map((item) => ({ ...item }));
	}

	let next: T[] = current.map((item) => ({ ...item }));
	const op = spec.op as string | undefined;

	if (Array.isArray(spec.replace)) {
		next = (spec.replace as T[]).map((item) => ({ ...item }));
	} else if (op === "replace") {
		const items = Array.isArray(spec.items)
			? (spec.items as T[])
			: spec.item
				? [spec.item as T]
				: [];
		next = items.map((item) => ({ ...item }));
	}

	const addItems: T[] = [
		...toArray<T>(spec.add as T | T[] | undefined),
		...(op === "add"
			? [
					...toArray<T>(spec.item as T | undefined),
					...(Array.isArray(spec.items) ? (spec.items as T[]) : []),
				]
			: []),
	];
	for (const item of addItems) {
		const k = getField(item);
		const existingIdx = next.findIndex(
			(e) => getField(e).toLowerCase() === k.toLowerCase(),
		);
		if (existingIdx >= 0) {
			next[existingIdx] = { ...next[existingIdx], ...item };
		} else {
			next.push({ ...item });
		}
	}

	const updateItems: Array<Record<string, unknown>> = [
		...toArray<Record<string, unknown>>(
			spec.update as Record<string, unknown> | Array<Record<string, unknown>> | undefined,
		),
		...(op === "update"
			? [
					...toArray<Record<string, unknown>>(spec.item as Record<string, unknown> | undefined),
					...(Array.isArray(spec.items) ? (spec.items as Array<Record<string, unknown>>) : []),
				]
			: []),
	];
	for (const patch of updateItems) {
		const matchKey = String(patch.match ?? patch[keyField] ?? spec[keyField] ?? "").trim();
		const nextKey = String(patch[keyField] ?? matchKey).trim();
		const idx = next.findIndex(
			(e) => getField(e).toLowerCase() === matchKey.toLowerCase(),
		);
		if (idx === -1) {
			throw new Error(`Cannot update ${sectionLabel} '${matchKey}': key not found`);
		}
		if (
			next.some(
				(item, i) =>
					i !== idx && getField(item).toLowerCase() === nextKey.toLowerCase(),
			)
		) {
			throw new Error(
				`Cannot update ${sectionLabel} '${matchKey}' to '${nextKey}': duplicate ${keyField} '${nextKey}' already exists`,
			);
		}
		const { match: _match, ...restPatch } = patch;
		next[idx] = {
			...next[idx],
			...(restPatch as Partial<T>),
			[keyField]: nextKey,
		};
	}

	const extractRemoveKey = (entry: unknown): string => {
		if (typeof entry === "string") return entry.trim();
		if (entry && typeof entry === "object" && keyField in entry) {
			return String((entry as Record<string, unknown>)[keyField] ?? "").trim();
		}
		return "";
	};

	const removeKeys = new Set<string>(
		[
			...toArray<unknown>(spec.remove as unknown),
			...(op === "remove"
				? [
						spec[keyField],
						...(Array.isArray(spec[`${keyField}s`]) ? (spec[`${keyField}s`] as unknown[]) : []),
						spec.item,
						...(Array.isArray(spec.items) ? (spec.items as unknown[]) : []),
					]
				: []),
		]
			.map(extractRemoveKey)
			.filter((k) => k.length > 0)
			.map((k) => k.toLowerCase()),
	);

	if (removeKeys.size > 0) {
		next = next.filter(
			(item) => !removeKeys.has(getField(item).toLowerCase()),
		);
	}

	return next;
}

function principleIdentity(item: DosOperatingPrinciple): string {
	return typeof item === "string" ? item.trim().toLowerCase() : item.key.trim().toLowerCase();
}

function applyOperatingPrinciplesCrud(
	existing: unknown,
	spec: DosOperatingPrinciple[] | z.infer<typeof operatingPrinciplesCrudObjectSchema>,
): DosOperatingPrinciple[] {
	const current: DosOperatingPrinciple[] = Array.isArray(existing)
		? existing.filter(
				(item): item is DosOperatingPrinciple =>
					typeof item === "string" ||
					(Boolean(item) &&
						typeof item === "object" &&
						typeof (item as Record<string, unknown>).key === "string"),
			)
		: [];

	if (Array.isArray(spec)) {
		return [...spec];
	}

	let next: DosOperatingPrinciple[] = [...current];

	if (spec.replace !== undefined) {
		next = [...spec.replace];
	} else if (spec.op === "replace") {
		const replacements =
			(spec.items as DosOperatingPrinciple[] | undefined) ??
			(spec.value !== undefined ? toArray<DosOperatingPrinciple>(spec.value) : []);
		next = [...replacements];
	}

	const addItems: DosOperatingPrinciple[] = [
		...toArray<DosOperatingPrinciple>(spec.add),
		...(spec.op === "add"
			? [
					...(spec.item !== undefined &&
					(typeof spec.item === "string" ||
						("key" in spec.item &&
							typeof spec.item.key === "string" &&
							"description" in spec.item &&
							typeof spec.item.description === "string"))
						? [spec.item as DosOperatingPrinciple]
						: []),
					...((spec.items as DosOperatingPrinciple[] | undefined) ?? []),
					...(spec.value !== undefined ? toArray<DosOperatingPrinciple>(spec.value) : []),
				]
			: []),
	];
	for (const item of addItems) {
		const id = principleIdentity(item);
		const existingIdx = next.findIndex((e) => principleIdentity(e) === id);
		if (existingIdx >= 0) {
			next[existingIdx] = item;
		} else {
			next.push(item);
		}
	}

	const updateSpecs = [
		...toArray<z.infer<typeof operatingPrincipleUpdatePairSchema>>(spec.update),
		...(spec.op === "update"
			? [
					...(spec.item && typeof spec.item === "object"
						? [spec.item as z.infer<typeof operatingPrincipleUpdatePairSchema>]
						: []),
					...(spec.match !== undefined && spec.value !== undefined && !Array.isArray(spec.value)
						? [{ match: spec.match, value: spec.value }]
						: []),
				]
			: []),
	];
	for (const u of updateSpecs) {
		const targetKey = (u.match ?? u.key ?? "").trim().toLowerCase();
		const idx = next.findIndex((e) => principleIdentity(e) === targetKey);
		if (idx === -1) {
			throw new Error(`Cannot update operating_principles '${u.match ?? u.key ?? ""}': not found`);
		}
		let updatedItem: DosOperatingPrinciple = next[idx];
		if (u.value !== undefined) {
			updatedItem = u.value;
		} else if (u.description !== undefined) {
			const prev = next[idx];
			const key = u.key ?? (typeof prev === "string" ? prev : prev.key);
			updatedItem = { key, description: u.description };
		} else if (u.key !== undefined) {
			const prev = next[idx];
			updatedItem = typeof prev === "string" ? u.key : { ...prev, key: u.key };
		}
		const nextId = principleIdentity(updatedItem);
		if (next.some((item, i) => i !== idx && principleIdentity(item) === nextId)) {
			throw new Error(
				`Cannot update operating_principles '${u.match ?? u.key ?? ""}': duplicate key '${nextId}' already exists`,
			);
		}
		next[idx] = updatedItem;
	}

	const removeIds = new Set<string>(
		[
			...toArray<unknown>(spec.remove as unknown),
			...(spec.op === "remove"
				? [
						spec.key,
						...(spec.keys ?? []),
						spec.match,
						spec.item,
						...(spec.items ?? []),
						...(spec.value !== undefined ? toArray<DosOperatingPrinciple>(spec.value) : []),
					]
				: []),
		]
			.map((entry) => {
				if (typeof entry === "string") return entry.trim().toLowerCase();
				if (entry && typeof entry === "object" && "key" in entry) {
					return String((entry as Record<string, unknown>).key ?? "")
						.trim()
						.toLowerCase();
				}
				return "";
			})
			.filter((k) => k.length > 0),
	);

	if (removeIds.size > 0) {
		next = next.filter((item) => !removeIds.has(principleIdentity(item)));
	}

	return next;
}

function resolvedPillarOption(pillar: DosPillarSpec): string | null {
	if (typeof pillar.notion_option === "string" && pillar.notion_option.trim().length > 0) {
		return pillar.notion_option.trim();
	}
	if (typeof pillar.notion_property === "string" && pillar.notion_property.trim().length > 0) {
		return pillar.notion_property.trim();
	}
	return null;
}

function assertPillarAppendOnlyRule(
	domain: string,
	existingPillars: DosPillarSpec[],
	nextPillars: DosPillarSpec[],
	allowPillarRemoval: boolean,
): void {
	if (allowPillarRemoval || existingPillars.length === 0) {
		return;
	}

	const violations: string[] = [];
	for (const prev of existingPillars) {
		const prevKey = prev.key.trim().toLowerCase();
		const nextMatch = nextPillars.find((p) => p.key.trim().toLowerCase() === prevKey);
		const prevOption = resolvedPillarOption(prev);

		if (!nextMatch) {
			violations.push(
				prevOption ? `${prev.key} (Notion option "${prevOption}")` : prev.key,
			);
			continue;
		}

		if (prevOption) {
			const nextOption = resolvedPillarOption(nextMatch);
			if (nextOption !== prevOption) {
				violations.push(
					`${prev.key} (Notion option "${prevOption}" -> "${nextOption ?? "(removed)"}")`,
				);
			}
		}
	}

	if (violations.length > 0) {
		throw new Error(
			`Refusing to remove or rename Notion pillar option(s) in domain '${domain}' [${violations.join(", ")}]: pillar options are append-only (#692). Pass allow_pillar_removal: true when intentionally retiring a pillar from active config.`,
		);
	}
}

export function mergeDosConfig(
	existingRaw: unknown,
	incoming: NonNullable<z.infer<typeof dosConfigUpdateSchema>>,
	topLevelAllowPillarRemoval?: boolean,
): DosConfigRecord {
	const existing: DosConfigRecord =
		existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
			? { ...(existingRaw as DosConfigRecord) }
			: {};

	const allowPillarRemoval =
		topLevelAllowPillarRemoval === true ||
		incoming.allow_pillar_removal === true ||
		incoming.allow_pillar_option_removal === true;

	const next: DosConfigRecord = { ...existing };

	if (incoming.tone !== undefined) {
		next.tone = applyStringArrayCrud(existing.tone, incoming.tone);
	}

	if (incoming.operating_principles !== undefined) {
		next.operating_principles = applyOperatingPrinciplesCrud(
			existing.operating_principles,
			incoming.operating_principles,
		);
	}

	if (incoming.handshake_instructions !== undefined) {
		if (typeof incoming.handshake_instructions === "string") {
			next.handshake_instructions = incoming.handshake_instructions;
		} else {
			next.handshake_instructions = applyStringArrayCrud(
				existing.handshake_instructions,
				incoming.handshake_instructions,
			);
		}
	}

	if (incoming.types !== undefined) {
		next.types = applyKeyedArrayCrud<DosAtomType>(
			existing.types,
			incoming.types as DosAtomType[] | Record<string, unknown>,
			"key",
			"dos_config.types",
		);
	}

	if (incoming.audiences !== undefined) {
		next.audiences = applyKeyedArrayCrud<DosAudienceSpec>(
			existing.audiences,
			incoming.audiences as DosAudienceSpec[] | Record<string, unknown>,
			"key",
			"dos_config.audiences",
		);
	}

	if (incoming.pasted_instructions !== undefined) {
		next.pasted_instructions = incoming.pasted_instructions;
	}

	if (incoming.by_domain !== undefined) {
		const existingByDomain: Record<string, DosDomainConfig> =
			existing.by_domain &&
			typeof existing.by_domain === "object" &&
			!Array.isArray(existing.by_domain)
				? { ...existing.by_domain }
				: {};

		const mergedByDomain: Record<string, DosDomainConfig> = { ...existingByDomain };

		for (const [domain, domainPatch] of Object.entries(incoming.by_domain)) {
			const prevDomain: DosDomainConfig =
				existingByDomain[domain] &&
				typeof existingByDomain[domain] === "object" &&
				!Array.isArray(existingByDomain[domain])
					? { ...existingByDomain[domain] }
					: {};

			const nextDomain: DosDomainConfig = { ...prevDomain };

			if (domainPatch.topics !== undefined) {
				nextDomain.topics = applyStringArrayCrud(prevDomain.topics, domainPatch.topics);
			}

			if (domainPatch.domain_signals !== undefined) {
				nextDomain.domain_signals = applyStringArrayCrud(
					prevDomain.domain_signals,
					domainPatch.domain_signals,
				);
			}

			if (domainPatch.pillars !== undefined) {
				const existingPillars: DosPillarSpec[] = Array.isArray(prevDomain.pillars)
					? prevDomain.pillars
					: [];
				const nextPillars = applyKeyedArrayCrud<DosPillarSpec>(
					existingPillars,
					domainPatch.pillars as DosPillarSpec[] | Record<string, unknown>,
					"key",
					`dos_config.by_domain.${domain}.pillars`,
				);
				assertPillarAppendOnlyRule(domain, existingPillars, nextPillars, allowPillarRemoval);
				nextDomain.pillars = nextPillars;
			}

			if (domainPatch.artefact_registers !== undefined) {
				nextDomain.artefact_registers = applyKeyedArrayCrud<DosArtefactRegisterSpec>(
					prevDomain.artefact_registers,
					domainPatch.artefact_registers as
						| DosArtefactRegisterSpec[]
						| Record<string, unknown>,
					"key",
					`dos_config.by_domain.${domain}.artefact_registers`,
				);
			}

			if (domainPatch.audiences !== undefined) {
				nextDomain.audiences = applyKeyedArrayCrud<DosAudienceSpec>(
					prevDomain.audiences,
					domainPatch.audiences as DosAudienceSpec[] | Record<string, unknown>,
					"key",
					`dos_config.by_domain.${domain}.audiences`,
				);
			}

			if (domainPatch.state_doc_rules !== undefined) {
				nextDomain.state_doc_rules = {
					...(prevDomain.state_doc_rules ?? {}),
					...domainPatch.state_doc_rules,
				};
			}

			if (domainPatch.daily_log_schema !== undefined) {
				const prevDailyLog = prevDomain.daily_log_schema ?? {};
				const nextDailyLog = { ...prevDailyLog };
				if (domainPatch.daily_log_schema.properties !== undefined) {
					nextDailyLog.properties = applyKeyedArrayCrud<DosDailyLogPropertySpec>(
						prevDailyLog.properties,
						domainPatch.daily_log_schema.properties as
							| DosDailyLogPropertySpec[]
							| Record<string, unknown>,
						"name",
						`dos_config.by_domain.${domain}.daily_log_schema.properties`,
					);
				}
				if (domainPatch.daily_log_schema.body_sections !== undefined) {
					nextDailyLog.body_sections = applyStringArrayCrud(
						prevDailyLog.body_sections,
						domainPatch.daily_log_schema.body_sections,
					);
				}
				nextDomain.daily_log_schema = nextDailyLog;
			}

			if (domainPatch.waiting_on_status !== undefined) {
				if (domainPatch.waiting_on_status === null) {
					delete nextDomain.waiting_on_status;
				} else {
					nextDomain.waiting_on_status = domainPatch.waiting_on_status;
				}
			}

			mergedByDomain[domain] = nextDomain;
		}

		next.by_domain = mergedByDomain;
	}

	return next;
}

export function formatConfigPreferencesUpdateMcp(output: ConfigPreferencesUpdateOutput): string {
	if (!output.updated || !output.row) {
		return "No fields supplied. Provide at least one field to update (e.g. user_mode, automation_level, confidence_thresholds, dos_config, etc.).";
	}

	const updated = output.row;
	const changedKeys = output.changedKeys.join(", ");
	const indentJson = (val: unknown) =>
		JSON.stringify(val ?? null, null, 2)
			.split("\n")
			.map((l) => "  " + l)
			.join("\n");

	const lines = [
		`Updated user_preferences (changed: ${changedKeys}).`,
		"",
		"Updated row:",
		`  user_mode:                  ${updated.user_mode}`,
		`  automation_level:           ${updated.automation_level}`,
		`  global_confidence_threshold: ${updated.global_confidence_threshold}`,
		`  show_lifecycle_details:     ${updated.show_lifecycle_details}`,
		`  safe_mode:                  ${updated.safe_mode}`,
		`  has_completed_onboarding:   ${updated.has_completed_onboarding}`,
		`  updated_at:                 ${updated.updated_at}`,
		"",
		"confidence_thresholds:",
		indentJson(updated.confidence_thresholds),
		"",
		"notification_preferences:",
		indentJson(updated.notification_preferences),
	];

	if (output.changedKeys.includes("dos_config") || updated.dos_config !== undefined) {
		lines.push("", "dos_config:", indentJson(updated.dos_config));
	}

	return lines.join("\n");
}

export function createConfigPreferencesUpdateAction(repo: ConfigPreferencesRepository) {
	return defineAction({
		id: "config_preferences_update",
		domain: "ops",
		description:
			"Partial-update the owner's user_preferences. Scalar fields replace; JSONB fields (confidence_thresholds, notification_preferences, dos_config) deep-merge and support section/item CRUD. Pillar removal requires allow_pillar_removal: true (#692). Full notes: docs/guides/tools/config_preferences_update.md",
		schema: configPreferencesUpdateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<ConfigPreferencesUpdateOutput> => {
			const updatableKeys = [
				"user_mode",
				"automation_level",
				"global_confidence_threshold",
				"show_lifecycle_details",
				"safe_mode",
				"has_completed_onboarding",
				"confidence_thresholds",
				"notification_preferences",
				"dos_config",
			] as const;

			const supplied = updatableKeys.filter((k) => args[k] !== undefined);
			if (supplied.length === 0) {
				return {
					updated: false,
					changedKeys: [],
					row: null,
				};
			}

			if (!repo.loadPreferencesRow) {
				throw new Error("ConfigRepository.loadPreferencesRow is not wired");
			}
			if (!repo.updatePreferencesRow) {
				throw new Error("ConfigRepository.updatePreferencesRow is not wired");
			}

			const current = await repo.loadPreferencesRow();
			if (!current) {
				throw new Error(
					"No user_preferences row found for this user. Create one first (log in via the app or call the Supabase config_preferences_get() DB function).",
				);
			}

			const patch: Record<string, unknown> = {};

			if (args.user_mode !== undefined) patch.user_mode = args.user_mode;
			if (args.automation_level !== undefined) patch.automation_level = args.automation_level;
			if (args.global_confidence_threshold !== undefined) {
				patch.global_confidence_threshold = args.global_confidence_threshold;
			}
			if (args.show_lifecycle_details !== undefined) {
				patch.show_lifecycle_details = args.show_lifecycle_details;
			}
			if (args.safe_mode !== undefined) patch.safe_mode = args.safe_mode;
			if (args.has_completed_onboarding !== undefined) {
				patch.has_completed_onboarding = args.has_completed_onboarding;
			}

			if (args.confidence_thresholds !== undefined) {
				const existing =
					(current.confidence_thresholds as Record<string, unknown> | undefined) ?? {};
				const incoming = args.confidence_thresholds as Record<string, unknown>;
				const merged: Record<string, unknown> = { ...existing };
				for (const [cat, windows] of Object.entries(incoming)) {
					if (windows !== undefined) {
						merged[cat] = {
							...((existing[cat] as Record<string, unknown> | undefined) ?? {}),
							...(windows as Record<string, unknown>),
						};
					}
				}
				patch.confidence_thresholds = merged;
			}

			if (args.notification_preferences !== undefined) {
				const existing =
					(current.notification_preferences as Record<string, unknown> | undefined) ?? {};
				patch.notification_preferences = {
					...existing,
					...args.notification_preferences,
				};
			}

			if (args.dos_config !== undefined) {
				patch.dos_config = mergeDosConfig(
					current.dos_config,
					args.dos_config,
					args.allow_pillar_removal === true || args.allow_pillar_option_removal === true,
				);
			}

			const updated = await repo.updatePreferencesRow(patch);
			return {
				updated: true,
				changedKeys: Object.keys(patch),
				row: updated,
			};
		},
		formatMcp: formatConfigPreferencesUpdateMcp,
	});
}
