import type { SupabaseClient } from "@supabase/supabase-js";

export interface GmailLabelDefinition {
	name: string;
	label_id?: string;
	description: string;
}

export interface GmailScriptDefinition {
	title: string;
	aliases: string[];
	description: string;
	tags: string[];
	properties: {
		kind: "automation";
		system_type: "script" | "marker";
		tier?: number;
		mode?: "auto" | "claude";
		owned_labels: string[];
	};
}

export interface GmailTriageSchemeDefinition {
	title: string;
	aliases: string[];
	description: string;
	tags: string[];
	properties: {
		kind: "automation";
		system_type: "label_scheme";
		labels: GmailLabelDefinition[];
	};
}

export const GMAIL_INTEGRATION_ENTITY = {
	title: "Gmail Integration",
	entity_type: "resource",
	aliases: ["Gmail", "gmail-integration", "Google Mail"],
	description: "Google Workspace Gmail messaging and email automation integration for ahOS.",
	tags: ["email", "gmail", "integration", "google-workspace"],
	properties: {
		kind: "system",
		system_type: "integration",
		provider: "gmail",
		accounts: ["owner@example.com", "owner@work.example.com"],
	},
} as const;

export const GMAIL_TRIAGE_SCHEME: GmailTriageSchemeDefinition = {
	title: "Gmail Numbered Triage System",
	aliases: ["Gmail Triage Scheme", "numbered-triage", "inbox-triage-scheme"],
	description: "Hand-rolled 8-tier inbox triage scheme for email categorization, prioritization, and workflow routing.",
	tags: ["gmail", "triage", "labels", "email-workflow"],
	properties: {
		kind: "automation",
		system_type: "label_scheme",
		labels: [
			{ name: "1: to respond", description: "Actionable email requiring a written response from Angus" },
			{ name: "2: FYI", description: "Informational email; awareness only, no response required" },
			{ name: "3: comment", description: "Comment and review notifications (Google Docs, PRs, Notion)" },
			{ name: "4: notification", description: "System, service, and transactional alerts/notifications" },
			{ name: "5: meeting update", description: "Calendar invitations, reschedules, and meeting updates" },
			{
				name: "6: awaiting reply",
				label_id: "Label_314",
				description: "Thread where Angus replied and is waiting on someone else's response",
			},
			{ name: "7: actioned", description: "Completed or actioned thread" },
			{ name: "8: marketing", description: "Marketing, sales outreach, newsletters, and promotional emails" },
			{
				name: "Pending Action",
				label_id: "Label_331",
				description: "Open task where the next move is on Angus",
			},
		],
	},
};

export const GMAIL_SCRIPTS: GmailScriptDefinition[] = [
	{
		title: "Script: Tier 1 (Nuclear)",
		aliases: ["Tier 1 Nuclear"],
		description: "Aggressive clearance script for bulk removing or archiving high-volume disposable email.",
		tags: ["gmail", "script", "automation", "tier-1"],
		properties: {
			kind: "automation",
			system_type: "script",
			tier: 1,
			owned_labels: ["Label_5", "Script: Tier 1 (Nuclear)"],
		},
	},
	{
		title: "Script: Tier 2 (Category)",
		aliases: ["Tier 2 Category"],
		description: "Category-based triage script sorting incoming mail into primary operational categories.",
		tags: ["gmail", "script", "automation", "tier-2"],
		properties: {
			kind: "automation",
			system_type: "script",
			tier: 2,
			owned_labels: ["Label_6", "Script: Tier 2 (Category)"],
		},
	},
	{
		title: "Script: Tier 3 (Bulk Reduce)",
		aliases: ["Tier 3 Bulk Reduce"],
		description: "Bulk reduction triage script filtering automated reports and notifications from inbox.",
		tags: ["gmail", "script", "automation", "tier-3"],
		properties: {
			kind: "automation",
			system_type: "script",
			tier: 3,
			owned_labels: ["Label_7", "Script: Tier 3 (Bulk Reduce)"],
		},
	},
	{
		title: "Script: Tier 3 (Keep)",
		aliases: ["Tier 3 Keep"],
		description: "Preservation rule script protecting critical subscriptions, receipts, and records from bulk sweeps.",
		tags: ["gmail", "script", "automation", "tier-3"],
		properties: {
			kind: "automation",
			system_type: "script",
			tier: 3,
			owned_labels: ["Label_8", "Script: Tier 3 (Keep)"],
		},
	},
	{
		title: "Script: Tier 4 (Focus)",
		aliases: ["Tier 4 Focus"],
		description: "High-priority focus triage script highlighting direct VIP comms and urgent threads.",
		tags: ["gmail", "script", "automation", "tier-4"],
		properties: {
			kind: "automation",
			system_type: "script",
			tier: 4,
			owned_labels: ["Label_9", "Script: Tier 4 (Focus)"],
		},
	},
	{
		title: "Script: Stale Blitz (Auto)",
		aliases: ["Stale Blitz Auto"],
		description: "Scheduled script that automatically sweeps and archives stale threads exceeding inactivity threshold.",
		tags: ["gmail", "script", "automation", "stale-blitz"],
		properties: {
			kind: "automation",
			system_type: "script",
			mode: "auto",
			owned_labels: ["Label_3", "Script: Stale Blitz (Auto)"],
		},
	},
	{
		title: "Script: Stale Blitz (Claude)",
		aliases: ["Stale Blitz Claude"],
		description: "Assisted triage script used by Claude for interactive stale thread review and clearance.",
		tags: ["gmail", "script", "automation", "stale-blitz"],
		properties: {
			kind: "automation",
			system_type: "script",
			mode: "claude",
			owned_labels: ["Label_4", "Script: Stale Blitz (Claude)"],
		},
	},
	{
		title: "Script: Morning Briefing Archive",
		aliases: ["Morning Briefing Archive"],
		description: "Daily morning cleanup script that archives preceding day's automated briefing and digest emails.",
		tags: ["gmail", "script", "automation", "morning-briefing"],
		properties: {
			kind: "automation",
			system_type: "script",
			owned_labels: ["Label_12", "Label_321", "Script: Morning Briefing Archive"],
		},
	},
	{
		title: "Script: Archive Low Signal",
		aliases: ["Archive Low Signal"],
		description: "Low-signal suppression script archiving newsletters, promotions, and cold outreach.",
		tags: ["gmail", "script", "automation", "low-signal"],
		properties: {
			kind: "automation",
			system_type: "script",
			owned_labels: ["Label_320", "Script: Archive Low Signal"],
		},
	},
	{
		title: "Script: Archived by Script",
		aliases: ["Archived by Script Marker"],
		description: "Audit trail marker label applied by automated scripts when archiving messages without human interaction.",
		tags: ["gmail", "script", "automation", "audit"],
		properties: {
			kind: "automation",
			system_type: "marker",
			owned_labels: ["Label_309", "Archived by script"],
		},
	},
];

export interface SeedResult {
	integrationEntityId: string;
	triageSchemeEntityId: string;
	scriptEntityIds: Record<string, string>;
	edgesCreated: number;
}

/**
 * Idempotently seed or update Gmail automation and triage entities in the knowledge graph.
 */
export async function seedGmailAutomationEntities(
	supabase: SupabaseClient,
	userId: string,
): Promise<SeedResult> {
	// 1. Upsert parent Gmail Integration entity
	const { data: existingParent, error: parentReadError } = await supabase
		.from("entities")
		.select("id")
		.eq("user_id", userId)
		.eq("title", GMAIL_INTEGRATION_ENTITY.title)
		.maybeSingle();

	if (parentReadError) {
		throw new Error(`Failed to check existing Gmail integration entity: ${parentReadError.message}`);
	}

	let integrationEntityId = existingParent?.id;
	if (!integrationEntityId) {
		const { data: newParent, error: parentInsertError } = await supabase
			.from("entities")
			.insert({
				user_id: userId,
				title: GMAIL_INTEGRATION_ENTITY.title,
				entity_type: GMAIL_INTEGRATION_ENTITY.entity_type,
				aliases: GMAIL_INTEGRATION_ENTITY.aliases,
				description: GMAIL_INTEGRATION_ENTITY.description,
				tags: GMAIL_INTEGRATION_ENTITY.tags,
				properties: GMAIL_INTEGRATION_ENTITY.properties,
				hot: false,
			})
			.select("id")
			.single();

		if (parentInsertError || !newParent) {
			throw new Error(`Failed to create Gmail integration entity: ${parentInsertError?.message}`);
		}
		integrationEntityId = newParent.id;
	}

	// 2. Upsert Triage Scheme entity
	const { data: existingScheme, error: schemeReadError } = await supabase
		.from("entities")
		.select("id")
		.eq("user_id", userId)
		.eq("title", GMAIL_TRIAGE_SCHEME.title)
		.maybeSingle();

	if (schemeReadError) {
		throw new Error(`Failed to check existing triage scheme entity: ${schemeReadError.message}`);
	}

	let triageSchemeEntityId = existingScheme?.id;
	if (!triageSchemeEntityId) {
		const { data: newScheme, error: schemeInsertError } = await supabase
			.from("entities")
			.insert({
				user_id: userId,
				title: GMAIL_TRIAGE_SCHEME.title,
				entity_type: "resource",
				aliases: GMAIL_TRIAGE_SCHEME.aliases,
				description: GMAIL_TRIAGE_SCHEME.description,
				tags: GMAIL_TRIAGE_SCHEME.tags,
				properties: GMAIL_TRIAGE_SCHEME.properties,
				hot: false,
			})
			.select("id")
			.single();

		if (schemeInsertError || !newScheme) {
			throw new Error(`Failed to create triage scheme entity: ${schemeInsertError?.message}`);
		}
		triageSchemeEntityId = newScheme.id;
	}

	// 3. Upsert individual Script entities
	const scriptEntityIds: Record<string, string> = {};
	for (const script of GMAIL_SCRIPTS) {
		const { data: existingScript, error: scriptReadError } = await supabase
			.from("entities")
			.select("id")
			.eq("user_id", userId)
			.eq("title", script.title)
			.maybeSingle();

		if (scriptReadError) {
			throw new Error(`Failed to read script entity '${script.title}': ${scriptReadError.message}`);
		}

		let scriptId = existingScript?.id;
		if (!scriptId) {
			const { data: newScript, error: scriptInsertError } = await supabase
				.from("entities")
				.insert({
					user_id: userId,
					title: script.title,
					entity_type: "resource",
					aliases: script.aliases,
					description: script.description,
					tags: script.tags,
					properties: script.properties,
					hot: false,
				})
				.select("id")
				.single();

			if (scriptInsertError || !newScript) {
				throw new Error(`Failed to create script entity '${script.title}': ${scriptInsertError?.message}`);
			}
			scriptId = newScript.id;
		}
		scriptEntityIds[script.title] = scriptId;
	}

	// 4. Ensure is_part_of edges from each child to Gmail Integration
	const allChildIds = [triageSchemeEntityId, ...Object.values(scriptEntityIds)];
	let edgesCreated = 0;

	for (const childId of allChildIds) {
		const { data: existingEdge, error: edgeReadError } = await supabase
			.from("entity_relationships")
			.select("id")
			.eq("user_id", userId)
			.eq("source_id", childId)
			.eq("target_id", integrationEntityId)
			.eq("relationship_type", "is_part_of")
			.maybeSingle();

		if (edgeReadError) {
			throw new Error(`Failed to read relationship for child ${childId}: ${edgeReadError.message}`);
		}

		if (!existingEdge) {
			const { error: edgeInsertError } = await supabase
				.from("entity_relationships")
				.insert({
					user_id: userId,
					source_id: childId,
					target_id: integrationEntityId,
					relationship_type: "is_part_of",
				});

			if (edgeInsertError) {
				throw new Error(`Failed to link child ${childId} to integration: ${edgeInsertError.message}`);
			}
			edgesCreated++;
		}
	}

	return {
		integrationEntityId,
		triageSchemeEntityId,
		scriptEntityIds,
		edgesCreated,
	};
}
