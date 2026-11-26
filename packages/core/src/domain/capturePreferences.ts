import { z } from "zod";
import { ARTIFACT_SURFACES } from "./artifacts.js";
import { DISCOVERED_PREFIX, ENRICHABLE_CONNECTORS } from "./ingest/selection.js";

const TRUST_TIERS = ["perfect", "high", "medium", "low", "unverified"] as const;
const trustTier = z.enum(TRUST_TIERS);
type TrustTier = (typeof TRUST_TIERS)[number];

export const SYNTHESIS_ROLES = ["narrative", "evidence", "metrics", "excluded"] as const;
export const synthesisRole = z.enum(SYNTHESIS_ROLES);
export type SynthesisRole = (typeof SYNTHESIS_ROLES)[number];

const GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT = Object.freeze({
	personal: "gmail_attachment",
	work: "gmail_attachment_work",
} as const);
const GMAIL_INGEST_SURFACE = "gmail_ingest";

const tagRuleSchema = z.object({
	match: z.string().min(1),
	in: z.enum(["text", "title", "source_url"]).default("text"),
	tags: z.array(z.string()).default([]),
	source_channel: z.string().optional(),
});

export type TagRule = z.infer<typeof tagRuleSchema>;

export const capturePreferencesSchema = z.object({
	create_derived_artifacts: z.boolean().default(true),
	default_tags: z.array(z.string()).default([]),
	default_source_channel: z.string().default("mcp"),
	tag_rules: z.array(tagRuleSchema).default([]),
	default_surface: z.string().optional(),
	surface_trust_map: z.record(z.string(), trustTier).default({}),
	default_trust: trustTier.default("medium"),
	default_role: synthesisRole.default("narrative"),
	surface_role_map: z.record(z.string(), synthesisRole).default({}),
});

export type CapturePreferences = z.infer<typeof capturePreferencesSchema>;

export const LOCAL_CONNECTORS = ["local"] as const;

export const MACHINE_INGEST_SURFACES = [
	ARTIFACT_SURFACES.actReceipt,
	ARTIFACT_SURFACES.github,
	ARTIFACT_SURFACES.slack,
	ARTIFACT_SURFACES.slackDm,
	ARTIFACT_SURFACES.whatsapp,
	ARTIFACT_SURFACES.whatsappDm,
	ARTIFACT_SURFACES.derived,
	GMAIL_INGEST_SURFACE,
] as const;

export const METRICS_SURFACES = [
	ARTIFACT_SURFACES.kpiSnapshot,
] as const;

export const DISCOVER_ROLE_SEED: Readonly<Record<string, SynthesisRole>> = Object.freeze(
	Object.fromEntries([
		...[
			...ENRICHABLE_CONNECTORS,
			...Object.values(GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT),
			...LOCAL_CONNECTORS,
		].map((c) => [`${DISCOVERED_PREFIX}${c}`, "evidence" as const]),
		...MACHINE_INGEST_SURFACES.map((s) => [s, "evidence" as const]),
		...METRICS_SURFACES.map((s) => [s, "metrics" as const]),
	]),
);

export const DEFAULT_CAPTURE_PREFERENCES: CapturePreferences = capturePreferencesSchema.parse({});

export function resolveTrust(
	prefs: CapturePreferences,
	artifact: {
		surface?: string | null;
		source_channel?: string | null;
		trust_override?: string | null;
	},
): TrustTier {
	const parsedOverride = trustTier.safeParse(artifact.trust_override);
	if (parsedOverride.success) return parsedOverride.data;
	if (artifact.surface && prefs.surface_trust_map[artifact.surface]) {
		return prefs.surface_trust_map[artifact.surface];
	}
	if (artifact.source_channel && prefs.surface_trust_map[artifact.source_channel]) {
		return prefs.surface_trust_map[artifact.source_channel];
	}
	return prefs.default_trust;
}

export function effectiveSurfaceRoleMap(
	prefs: CapturePreferences,
): Record<string, SynthesisRole> {
	return { ...DISCOVER_ROLE_SEED, ...prefs.surface_role_map };
}

export function isRobotAuthoredArtifact(artifact: {
	title?: string | null;
	surface?: string | null;
	content_subtype?: string | null;
	plain_text?: string | null;
	description?: string | null;
	tags?: string[] | null;
}): boolean {
	if (artifact.tags?.includes("not_robot_authored")) {
		return false;
	}
	if (artifact.tags?.includes("robot_authored") || artifact.tags?.includes("auto-task")) {
		return true;
	}
	const title = (artifact.title ?? "").toLowerCase();
	if (
		title.includes("[auto-task]") ||
		title.includes("auto-task") ||
		title.includes("scheduled routine completed") ||
		title.includes("scheduled routine")
	) {
		return true;
	}
	const plainText = artifact.plain_text ?? "";
	if (plainText.includes("Scheduled routine completed")) {
		return true;
	}
	const desc = artifact.description ?? "";
	if (desc.includes("Scheduled routine completed")) {
		return true;
	}
	return false;
}

export function getRoleOverrideTag(tags?: readonly string[] | null): SynthesisRole | null {
	if (!tags) return null;
	for (const role of SYNTHESIS_ROLES) {
		if (tags.includes(`role:${role}`)) return role;
	}
	return null;
}

export function hasRoleOverrideTag(tags?: readonly string[] | null): boolean {
	return getRoleOverrideTag(tags) !== null;
}

export function resolveSynthesisRole(
	prefs: CapturePreferences,
	artifact: {
		surface?: string | null;
		source_channel?: string | null;
		title?: string | null;
		content_subtype?: string | null;
		plain_text?: string | null;
		description?: string | null;
		tags?: string[] | null;
	},
): SynthesisRole {
	const tagOverride = getRoleOverrideTag(artifact.tags);
	if (tagOverride) {
		return tagOverride;
	}
	if (isRobotAuthoredArtifact(artifact)) {
		return "excluded";
	}
	const roleMap = effectiveSurfaceRoleMap(prefs);
	if (artifact.surface && roleMap[artifact.surface]) {
		return roleMap[artifact.surface];
	}
	if (artifact.source_channel && roleMap[artifact.source_channel]) {
		return roleMap[artifact.source_channel];
	}
	return prefs.default_role;
}

export const resolveEffectiveRole = resolveSynthesisRole;

export type RoleTierFilter =
	| { role: SynthesisRole; match: "all"; hitKeys: null; allKeys: string[]; defaultHit: boolean }
	| { role: SynthesisRole; match: "none"; hitKeys: string[]; allKeys: string[]; defaultHit: boolean }
	| { role: SynthesisRole; match: "filter"; or: string; hitKeys: string[]; allKeys: string[]; defaultHit: boolean };

function postgrestList(values: string[]): string {
	return `(${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

function postgrestTextArray(values: string[]): string {
	return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export function roleTierFilters(prefs: CapturePreferences): RoleTierFilter[] {
	const roleMap = effectiveSurfaceRoleMap(prefs);
	const keys = Object.keys(roleMap)
		.filter((k) => k !== "")
		.sort();
	const unmapped = (col: "surface" | "source_channel") =>
		`or(${col}.is.null,${col}.not.in.${postgrestList(keys)})`;
	return SYNTHESIS_ROLES.map((role): RoleTierFilter => {
		const hits = keys.filter((k) => roleMap[k] === role);
		const branches: string[] = [];
		const isDefault = role === prefs.default_role;
		if (hits.length > 0) {
			branches.push(`surface.in.${postgrestList(hits)}`);
			branches.push(`and(${unmapped("surface")},source_channel.in.${postgrestList(hits)})`);
		}
		if (isDefault) {
			if (keys.length === 0) return { role, match: "all", hitKeys: null, allKeys: keys, defaultHit: true };
			branches.push(`and(${unmapped("surface")},${unmapped("source_channel")})`);
		}
		if (branches.length === 0) return { role, match: "none", hitKeys: hits, allKeys: keys, defaultHit: isDefault };
		return { role, match: "filter", or: branches.join(","), hitKeys: hits, allKeys: keys, defaultHit: isDefault };
	});
}

export function combinedRoleTierFilter(
	prefs: CapturePreferences,
	roles: readonly SynthesisRole[],
):
	| { match: "all"; hitKeys: null; allKeys: string[]; defaultHit: boolean; overrideTags: string[] }
	| { match: "none"; hitKeys: string[]; allKeys: string[]; defaultHit: boolean; overrideTags: string[] }
	| { match: "filter"; or: string; hitKeys: string[]; allKeys: string[]; defaultHit: boolean; overrideTags: string[] } {
	const roleSet = new Set<SynthesisRole>(roles);
	const overrideTags = [...roleSet].map((r) => `role:${r}`);
	const roleMap = effectiveSurfaceRoleMap(prefs);
	const keys = Object.keys(roleMap)
		.filter((k) => k !== "")
		.sort();
	const hits = keys.filter((k) => roleSet.has(roleMap[k]));
	const isDefault = roleSet.has(prefs.default_role);
	const unmapped = (col: "surface" | "source_channel") =>
		`or(${col}.is.null,${col}.not.in.${postgrestList(keys)})`;
	const branches: string[] = [];
	if (overrideTags.length > 0) {
		branches.push(`tags.ov.${postgrestTextArray(overrideTags)}`);
	}
	if (hits.length > 0) {
		branches.push(`surface.in.${postgrestList(hits)}`);
		branches.push(`and(${unmapped("surface")},source_channel.in.${postgrestList(hits)})`);
	}
	if (isDefault) {
		if (keys.length === 0) return { match: "all", hitKeys: null, allKeys: keys, defaultHit: true, overrideTags };
		branches.push(`and(${unmapped("surface")},${unmapped("source_channel")})`);
	}
	if (branches.length === 0) return { match: "none", hitKeys: hits, allKeys: keys, defaultHit: isDefault, overrideTags };
	return { match: "filter", or: branches.join(","), hitKeys: hits, allKeys: keys, defaultHit: isDefault, overrideTags };
}

export type CaptureRouting = {
	tags: string[];
	source_channel: string;
};

function fieldValue(
	prefsField: TagRule["in"],
	input: { text: string; title: string; source_url?: string },
): string {
	if (prefsField === "title") return input.title;
	if (prefsField === "source_url") return input.source_url ?? "";
	return input.text;
}

export function applyCaptureRouting(
	prefs: CapturePreferences,
	input: { text: string; title: string; source_url?: string; tags?: string[] },
): CaptureRouting {
	const tags = new Set<string>([...prefs.default_tags, ...(input.tags ?? [])]);
	let source_channel = prefs.default_source_channel;
	let channelLocked = false;

	for (const rule of prefs.tag_rules) {
		let re: RegExp;
		try {
			re = new RegExp(rule.match, "i");
		} catch {
			continue;
		}
		if (!re.test(fieldValue(rule.in, input))) continue;
		for (const t of rule.tags) tags.add(t);
		if (rule.source_channel && !channelLocked) {
			source_channel = rule.source_channel;
			channelLocked = true;
		}
	}

	return { tags: [...tags], source_channel };
}
