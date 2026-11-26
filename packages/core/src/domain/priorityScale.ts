// Canonical 7-Point Priority Scale & Cross-Surface Mapping Contract (ADR-116, #1986).
// Isomorphic and browser-safe: zero Node imports.

export const PRIORITY_LEVEL_NUMBERS = [1, 2, 3, 4, 5, 6, 7] as const;
export type PriorityLevel = (typeof PRIORITY_LEVEL_NUMBERS)[number];

export const PRIORITY_LEVEL_CODES = [
	"P1",
	"P2",
	"P3",
	"P4",
	"P5",
	"P6",
	"P7",
] as const;
export type PriorityLevelCode = (typeof PRIORITY_LEVEL_CODES)[number];

export const PRIORITY_LEVEL_TITLES = [
	"Trivial",
	"Minor",
	"Low",
	"Normal",
	"High",
	"Urgent",
	"Critical",
] as const;
export type PriorityLevelTitle = (typeof PRIORITY_LEVEL_TITLES)[number];

export const PRIORITY_LEVEL_SLUGS = [
	"trivial",
	"minor",
	"low",
	"normal",
	"high",
	"urgent",
	"critical",
] as const;
export type PriorityLevelSlug = (typeof PRIORITY_LEVEL_SLUGS)[number];

export const DEFAULT_PRIORITY_CUT_LINE: PriorityLevel = 5;

export type CoarseTaskPriority = "low" | "medium" | "high" | "urgent";
export type NotionTaskPrioritySelect =
	| "Low"
	| "Medium"
	| "High"
	| "3 Low"
	| "2 Medium"
	| "1 High";
export type NotionPriorityTier = 1 | 2 | 3;

export interface PriorityLevelDefinition {
	id: PriorityLevel;
	slug: PriorityLevelSlug;
	display: PriorityLevelTitle;
	meaning: string;
	level: PriorityLevel;
	tier: PriorityLevelCode;
	title: PriorityLevelTitle;
	description: string;
	isDefaultCutLine: boolean;
}

export const PRIORITY_LEVELS: readonly PriorityLevelDefinition[] = [
	{
		id: 1,
		slug: "trivial",
		display: "Trivial",
		meaning:
			"Lowest-stakes item with negligible impact or urgency if delayed indefinitely.",
		level: 1,
		tier: "P1",
		title: "Trivial",
		description:
			"Lowest-stakes item with negligible impact or urgency if delayed indefinitely.",
		isDefaultCutLine: false,
	},
	{
		id: 2,
		slug: "minor",
		display: "Minor",
		meaning:
			"Nice-to-have polish, opportunistic cleanup, or low-leverage task scheduled when capacity allows.",
		level: 2,
		tier: "P2",
		title: "Minor",
		description:
			"Nice-to-have polish, opportunistic cleanup, or low-leverage task scheduled when capacity allows.",
		isDefaultCutLine: false,
	},
	{
		id: 3,
		slug: "low",
		display: "Low",
		meaning:
			"Useful improvement or follow-up that can slip to the next week without consequence.",
		level: 3,
		tier: "P3",
		title: "Low",
		description:
			"Useful improvement or follow-up that can slip to the next week without consequence.",
		isDefaultCutLine: false,
	},
	{
		id: 4,
		slug: "normal",
		display: "Normal",
		meaning:
			"Standard planned work with moderate impact and urgency at the symmetric midpoint of the scale.",
		level: 4,
		tier: "P4",
		title: "Normal",
		description:
			"Standard planned work with moderate impact and urgency at the symmetric midpoint of the scale.",
		isDefaultCutLine: false,
	},
	{
		id: 5,
		slug: "high",
		display: "High",
		meaning:
			"Important committed work for the current week; the default focus cut-line (>= 5) in the Priority Inbox and daily rituals.",
		level: 5,
		tier: "P5",
		title: "High",
		description:
			"Important committed work for the current week; the default focus cut-line (>= 5) in the Priority Inbox and daily rituals.",
		isDefaultCutLine: true,
	},
	{
		id: 6,
		slug: "urgent",
		display: "Urgent",
		meaning:
			"Time-sensitive commitment due within 24 to 48 hours or unblocking another person or critical path.",
		level: 6,
		tier: "P6",
		title: "Urgent",
		description:
			"Time-sensitive commitment due within 24 to 48 hours or unblocking another person or critical path.",
		isDefaultCutLine: false,
	},
	{
		id: 7,
		slug: "critical",
		display: "Critical",
		meaning:
			"Drop-everything blocker, live production incident, or hard external deadline today with immediate blast radius.",
		level: 7,
		tier: "P7",
		title: "Critical",
		description:
			"Drop-everything blocker, live production incident, or hard external deadline today with immediate blast radius.",
		isDefaultCutLine: false,
	},
] as const;

export const PRIORITY_SURFACES = [
	"notion_personal",
	"notion_work",
	"work_mcp",
	"github_issue",
	"gmail_triage",
] as const;
export type PrioritySurface = (typeof PRIORITY_SURFACES)[number];

export interface PrioritySurfaceMapping {
	surface: PrioritySurface;
	level: PriorityLevel;
	externalValue: string;
	isCanonicalReverse: boolean;
	notes: string;
}

export const PRIORITY_SURFACE_MAPPINGS: readonly PrioritySurfaceMapping[] = [
	// Personal Notion (3-tier numbered select: 3 Low, 2 Medium, 1 High)
	{
		surface: "notion_personal",
		level: 1,
		externalValue: "3 Low",
		isCanonicalReverse: false,
		notes: "Trivial maps to Notion 3 Low",
	},
	{
		surface: "notion_personal",
		level: 2,
		externalValue: "3 Low",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for Notion 3 Low",
	},
	{
		surface: "notion_personal",
		level: 3,
		externalValue: "2 Medium",
		isCanonicalReverse: false,
		notes: "Low maps to Notion 2 Medium",
	},
	{
		surface: "notion_personal",
		level: 4,
		externalValue: "2 Medium",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for Notion 2 Medium",
	},
	{
		surface: "notion_personal",
		level: 5,
		externalValue: "1 High",
		isCanonicalReverse: false,
		notes: "High maps to Notion 1 High",
	},
	{
		surface: "notion_personal",
		level: 6,
		externalValue: "1 High",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for Notion 1 High",
	},
	{
		surface: "notion_personal",
		level: 7,
		externalValue: "1 High",
		isCanonicalReverse: false,
		notes: "Critical maps to Notion 1 High",
	},

	// Work Notion (3-tier select: Low, Medium, High)
	{
		surface: "notion_work",
		level: 1,
		externalValue: "Low",
		isCanonicalReverse: false,
		notes: "Trivial maps to Notion Low",
	},
	{
		surface: "notion_work",
		level: 2,
		externalValue: "Low",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for Notion Low",
	},
	{
		surface: "notion_work",
		level: 3,
		externalValue: "Medium",
		isCanonicalReverse: false,
		notes: "Low maps to Notion Medium",
	},
	{
		surface: "notion_work",
		level: 4,
		externalValue: "Medium",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for Notion Medium",
	},
	{
		surface: "notion_work",
		level: 5,
		externalValue: "High",
		isCanonicalReverse: false,
		notes: "High maps to Notion High",
	},
	{
		surface: "notion_work",
		level: 6,
		externalValue: "High",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for Notion High",
	},
	{
		surface: "notion_work",
		level: 7,
		externalValue: "High",
		isCanonicalReverse: false,
		notes: "Critical maps to Notion High",
	},

	// work-mcp (4-tier label vocabulary: priority:1_critical..4_low)
	{
		surface: "work_mcp",
		level: 1,
		externalValue: "priority:4_low",
		isCanonicalReverse: false,
		notes: "Trivial maps to priority:4_low",
	},
	{
		surface: "work_mcp",
		level: 2,
		externalValue: "priority:4_low",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for priority:4_low",
	},
	{
		surface: "work_mcp",
		level: 3,
		externalValue: "priority:3_medium",
		isCanonicalReverse: false,
		notes: "Low maps to priority:3_medium",
	},
	{
		surface: "work_mcp",
		level: 4,
		externalValue: "priority:3_medium",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for priority:3_medium",
	},
	{
		surface: "work_mcp",
		level: 5,
		externalValue: "priority:2_high",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for priority:2_high",
	},
	{
		surface: "work_mcp",
		level: 6,
		externalValue: "priority:1_critical",
		isCanonicalReverse: false,
		notes: "Urgent maps to priority:1_critical",
	},
	{
		surface: "work_mcp",
		level: 7,
		externalValue: "priority:1_critical",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for priority:1_critical",
	},

	// GitHub Issues (ADR-080 3-label family: priority:low, priority:medium, priority:high)
	{
		surface: "github_issue",
		level: 1,
		externalValue: "priority:low",
		isCanonicalReverse: false,
		notes: "Trivial maps to GitHub priority:low",
	},
	{
		surface: "github_issue",
		level: 2,
		externalValue: "priority:low",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for GitHub priority:low",
	},
	{
		surface: "github_issue",
		level: 3,
		externalValue: "priority:medium",
		isCanonicalReverse: false,
		notes: "Low maps to GitHub priority:medium",
	},
	{
		surface: "github_issue",
		level: 4,
		externalValue: "priority:medium",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for GitHub priority:medium",
	},
	{
		surface: "github_issue",
		level: 5,
		externalValue: "priority:high",
		isCanonicalReverse: false,
		notes: "High maps to GitHub priority:high",
	},
	{
		surface: "github_issue",
		level: 6,
		externalValue: "priority:high",
		isCanonicalReverse: true,
		notes: "Canonical reverse target for GitHub priority:high",
	},
	{
		surface: "github_issue",
		level: 7,
		externalValue: "priority:high",
		isCanonicalReverse: false,
		notes: "Critical maps to GitHub priority:high",
	},

	// Gmail priority triage (7-tier numeric score 1..7)
	{
		surface: "gmail_triage",
		level: 1,
		externalValue: "1",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 1",
	},
	{
		surface: "gmail_triage",
		level: 2,
		externalValue: "2",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 2",
	},
	{
		surface: "gmail_triage",
		level: 3,
		externalValue: "3",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 3",
	},
	{
		surface: "gmail_triage",
		level: 4,
		externalValue: "4",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 4",
	},
	{
		surface: "gmail_triage",
		level: 5,
		externalValue: "5",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 5",
	},
	{
		surface: "gmail_triage",
		level: 6,
		externalValue: "6",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 6",
	},
	{
		surface: "gmail_triage",
		level: 7,
		externalValue: "7",
		isCanonicalReverse: true,
		notes: "1:1 mapping for Gmail triage score 7",
	},
] as const;

export const PRIORITY_TIER_TO_NOTION_SELECT: Record<
	PriorityLevelCode,
	NotionTaskPrioritySelect
> = {
	P1: "Low",
	P2: "Low",
	P3: "Medium",
	P4: "Medium",
	P5: "High",
	P6: "High",
	P7: "High",
};

export function isPriorityLevel(value: unknown): value is PriorityLevel {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 7
	);
}

export function isPriorityLevelSlug(
	value: unknown,
): value is PriorityLevelSlug {
	return (
		typeof value === "string" &&
		(PRIORITY_LEVEL_SLUGS as readonly string[]).includes(value)
	);
}

export function getPriorityLevelDefinition(
	level: PriorityLevel,
): PriorityLevelDefinition {
	const found = PRIORITY_LEVELS.find((row) => row.level === level);
	if (!found) {
		throw new Error(`Invalid priority level: ${String(level)}`);
	}
	return found;
}

export function getPriorityLevelBySlug(
	slug: PriorityLevelSlug,
): PriorityLevelDefinition {
	const found = PRIORITY_LEVELS.find((row) => row.slug === slug);
	if (!found) {
		throw new Error(`Invalid priority level slug: ${String(slug)}`);
	}
	return found;
}

export function formatPriorityBadge(level: PriorityLevel): string {
	const def = getPriorityLevelDefinition(level);
	return `${def.tier} ${def.title} (${def.level}/7)`;
}

export function priorityTierToLevel(tier: PriorityLevelCode): PriorityLevel {
	const parsed = Number.parseInt(tier.slice(1), 10);
	if (!isPriorityLevel(parsed)) {
		throw new Error(`Invalid priority tier: ${tier}`);
	}
	return parsed;
}

export function priorityLevelToTier(level: PriorityLevel): PriorityLevelCode {
	return `P${level}` as PriorityLevelCode;
}

export function priorityLevelToNotionTier(
	level: PriorityLevel,
): NotionPriorityTier {
	if (level >= 5) return 1;
	if (level >= 3) return 2;
	return 3;
}

export function notionTierToPriorityLevel(
	tier: NotionPriorityTier,
): PriorityLevel {
	switch (tier) {
		case 1:
			return 6;
		case 2:
			return 4;
		case 3:
			return 2;
		default:
			throw new Error(`Invalid Notion priority tier: ${String(tier)}`);
	}
}

export function priorityLevelToTaskCrudPriority(
	level: PriorityLevel,
): CoarseTaskPriority {
	if (level <= 2) return "low";
	if (level <= 4) return "medium";
	if (level === 5) return "high";
	return "urgent";
}

export const priorityLevelToTaskPriority = priorityLevelToTaskCrudPriority;

export function taskCrudPriorityToPriorityLevel(
	priority: CoarseTaskPriority,
): PriorityLevel {
	switch (priority) {
		case "low":
			return 2;
		case "medium":
			return 4;
		case "high":
			return 5;
		case "urgent":
			return 6;
	}
}

export const taskPriorityToLevel = taskCrudPriorityToPriorityLevel;

export function priorityLevelToNotionSelect(
	level: PriorityLevel | number | null | undefined,
	surface: "notion_personal" | "notion_work" = "notion_work",
): NotionTaskPrioritySelect | undefined {
	if (!isPriorityLevel(level)) return undefined;
	return toExternalPriority(surface, level) as NotionTaskPrioritySelect;
}

export function priorityTierToNotionSelect(
	tier?: string | null,
): NotionTaskPrioritySelect | undefined {
	if (!tier) return undefined;
	const normalized = tier.trim().toUpperCase();
	if (normalized in PRIORITY_TIER_TO_NOTION_SELECT) {
		return PRIORITY_TIER_TO_NOTION_SELECT[normalized as PriorityLevelCode];
	}
	return undefined;
}

export function notionSelectToPriorityLevel(
	selectName?: string | null,
): PriorityLevel | undefined {
	if (!selectName) return undefined;
	return (
		fromExternalPriority("notion_personal", selectName) ??
		fromExternalPriority("notion_work", selectName)
	);
}

export function toExternalPriority(
	surface: PrioritySurface,
	level: PriorityLevel,
): string {
	const row = PRIORITY_SURFACE_MAPPINGS.find(
		(m) => m.surface === surface && m.level === level,
	);
	if (!row) {
		throw new Error(
			`No priority surface mapping for surface=${surface} level=${String(level)}`,
		);
	}
	return row.externalValue;
}

export function mapPriorityToSurface(
	level: PriorityLevel,
	surface: PrioritySurface,
): string;
export function mapPriorityToSurface(
	surface: PrioritySurface,
	level: PriorityLevel,
): string;
export function mapPriorityToSurface(
	levelOrSurface: PriorityLevel | PrioritySurface,
	surfaceOrLevel: PrioritySurface | PriorityLevel,
): string {
	if (typeof levelOrSurface === "number") {
		return toExternalPriority(
			surfaceOrLevel as PrioritySurface,
			levelOrSurface,
		);
	}
	return toExternalPriority(levelOrSurface, surfaceOrLevel as PriorityLevel);
}

export function fromExternalPriority(
	surface: PrioritySurface,
	externalValue: string,
): PriorityLevel | undefined {
	const normalized = externalValue.trim().toLowerCase();
	if (!normalized) return undefined;
	const canonical = PRIORITY_SURFACE_MAPPINGS.find(
		(m) =>
			m.surface === surface &&
			m.isCanonicalReverse &&
			m.externalValue.toLowerCase() === normalized,
	);
	if (canonical) return canonical.level;
	const fallback = PRIORITY_SURFACE_MAPPINGS.find(
		(m) =>
			m.surface === surface && m.externalValue.toLowerCase() === normalized,
	);
	return fallback?.level;
}

export function mapSurfaceToPriorityLevel(
	surface: PrioritySurface,
	externalValue: string,
): PriorityLevel | undefined;
export function mapSurfaceToPriorityLevel(
	externalValue: string,
	surface: PrioritySurface,
): PriorityLevel | undefined;
export function mapSurfaceToPriorityLevel(
	surfaceOrValue: PrioritySurface | string,
	valueOrSurface: string | PrioritySurface,
): PriorityLevel | undefined {
	if ((PRIORITY_SURFACES as readonly string[]).includes(surfaceOrValue)) {
		return fromExternalPriority(
			surfaceOrValue as PrioritySurface,
			valueOrSurface,
		);
	}
	if ((PRIORITY_SURFACES as readonly string[]).includes(valueOrSurface)) {
		return fromExternalPriority(
			valueOrSurface as PrioritySurface,
			surfaceOrValue,
		);
	}
	return undefined;
}

export function resolveEffectivePriorityLevel(input: {
	priority_level?: number | null;
	priority_tier?: number | string | null;
	priority?: string | null;
}): PriorityLevel | undefined {
	if (isPriorityLevel(input.priority_level)) {
		return input.priority_level;
	}
	if (
		typeof input.priority_tier === "number" &&
		(input.priority_tier === 1 ||
			input.priority_tier === 2 ||
			input.priority_tier === 3)
	) {
		return notionTierToPriorityLevel(input.priority_tier);
	}
	if (typeof input.priority_tier === "string" && input.priority_tier.trim()) {
		const raw = input.priority_tier.trim().toUpperCase();
		if (raw in PRIORITY_TIER_TO_NOTION_SELECT) {
			return priorityTierToLevel(raw as PriorityLevelCode);
		}
		const asInt = Number.parseInt(raw, 10);
		if (asInt === 1 || asInt === 2 || asInt === 3) {
			return notionTierToPriorityLevel(asInt);
		}
	}
	if (typeof input.priority === "string" && input.priority.trim()) {
		const trimmed = input.priority.trim();
		const lower = trimmed.toLowerCase();
		if (
			lower === "low" ||
			lower === "medium" ||
			lower === "high" ||
			lower === "urgent"
		) {
			return taskCrudPriorityToPriorityLevel(lower);
		}
		const fromNotion = notionSelectToPriorityLevel(trimmed);
		if (fromNotion !== undefined) {
			return fromNotion;
		}
	}
	return undefined;
}
