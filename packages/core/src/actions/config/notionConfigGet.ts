import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	notionConfigSchema,
	notionPersonalConfigSchema,
	type NotionConfig,
	type NotionPersonalConfig,
} from "../../domain/integrations.js";
import type { ConfigRepository } from "../../ports/config.js";

const notionUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;
const idLine = (label: string, id: string | undefined) =>
	id ? [`  ${label}: ${id}`, `    url: ${notionUrl(id)}`] : [`  ${label}: (unset)`];

const routingSetupHint = (provider: string, unsetKeys: string[]) =>
	unsetKeys.length === 0
		? []
		: [
				`    setup: routing destination(s) [${unsetKeys.join(", ")}] unset — configure via`,
				`    integration_set({ provider: '${provider}', config: { ${unsetKeys[0]}: '<notion-id>' } })`,
			];

function splitMeetingsSources(
	config: Pick<
		NotionConfig,
		"meetings_source_data_source_id" | "private_meetings_source_data_source_id"
	>,
) {
	const publicSource = config.meetings_source_data_source_id;
	const privateSource = config.private_meetings_source_data_source_id;

	return {
		read: [publicSource, privateSource].filter(
			(id): id is string => typeof id === "string" && id.length > 0,
		),
		project: publicSource ? [publicSource] : [],
		captureWrite: publicSource,
	};
}

export const notionConfigGetInput = {
	provider: z
		.enum(["notion_work", "notion_personal"])
		.optional()
		.describe(
			"Which Notion workspace to return. Omit to return both (notion_work + notion_personal).",
		),
} as const;

export const notionConfigGetSchema = z.object(notionConfigGetInput);

export type NotionConfigGetInput = z.infer<typeof notionConfigGetSchema>;

export interface NotionConfigGetOutput {
	provider?: "notion_work" | "notion_personal";
	notion_work?: NotionConfig | null;
	notion_personal?: NotionPersonalConfig | null;
}

function formatWorkConfig(config: NotionConfig): string {
	const meetings = splitMeetingsSources(config);

	return [
		"notion_work (Work workspace):",
		...idLine("tasks_database_id", config.tasks_database_id),
		`  title_property: ${config.title_property}`,
		`  property_map: ${JSON.stringify(config.property_map)}`,
		"  dos pointers:",
		`    notion_connector: ${config.notion_connector ?? "(unset)"}`,
		`    notion_workspace: ${config.notion_workspace ?? "(unset)"}`,
		...idLine("  state_doc_page_id", config.state_doc_page_id),
		...idLine("  daily_log_database_id", config.daily_log_database_id),
		...idLine("  daily_log_data_source_id", config.daily_log_data_source_id),
		...idLine("  tasks_source_data_source_id", config.tasks_source_data_source_id),
		...idLine("  meetings_source_data_source_id", config.meetings_source_data_source_id),
		...idLine(
			"  private_meetings_source_data_source_id",
			config.private_meetings_source_data_source_id,
		),
		...idLine("  investor_crm_data_source_id", config.investor_crm_data_source_id),
		`    notion_user_id: ${config.notion_user_id ?? "(unset)"}`,
		"  meetings sources (#617, ADR-053 §6) — read both, project one:",
		`    dos may read: ${meetings.read.join(", ") || "(none configured)"}`,
		`    Recent Communications projects from: ${meetings.project.join(", ") || "(unset)"}`,
		`    captured meetings are written to: ${meetings.captureWrite ?? "(unset)"}`,
		"    private_meetings_source_data_source_id is READ-ONLY for dos: no title,",
		"    attendee or paraphrase from it is ever written into the State Doc. Notion",
		"    exposes no page-level sharing API — an ACL can be neither set nor read — so",
		"    no write can be preceded by a check of who can see it. This is a rule in the",
		"    dos skill body, NOT an enforced permission.",
		"  capture routing destinations (#299):",
		...idLine(
			"  dos_inbox_data_source_id (decommissioned per ADR-050)",
			config.dos_inbox_data_source_id,
		),
		...idLine(
			"  meetings_source_data_source_id (meetings routing)",
			config.meetings_source_data_source_id,
		),
		...routingSetupHint(
			"notion_work",
			(
				[
					["meetings_source_data_source_id", config.meetings_source_data_source_id],
				] as const
			)
				.filter(([, v]) => !v)
				.map(([k]) => k),
		),
		"  raw: " + JSON.stringify(config),
	].join("\n");
}

function formatPersonalConfig(config: NotionPersonalConfig): string {
	return [
		"notion_personal (personal workspace):",
		...idLine("tasks_database_id", config.tasks_database_id),
		`  title_property: ${config.title_property}`,
		`  property_map: ${JSON.stringify(config.property_map)}`,
		...idLine("people_database_id", config.people_database_id),
		...idLine("meeting_notes_database_id", config.meeting_notes_database_id),
		...idLine("tasks_data_source_id", config.tasks_data_source_id),
		...idLine("people_data_source_id", config.people_data_source_id),
		...idLine("meeting_notes_data_source_id", config.meeting_notes_data_source_id),
		`  notion_user_id: ${config.notion_user_id ?? "(unset)"}`,
		"  dos pointers (`angus` domain):",
		...idLine("  state_doc_page_id", config.state_doc_page_id),
		...idLine("  daily_log_database_id", config.daily_log_database_id),
		...idLine("  daily_log_data_source_id", config.daily_log_data_source_id),
		...idLine("  tasks_data_source_id", config.tasks_data_source_id),
		`    notion_user_id: ${config.notion_user_id ?? "(unset)"}`,
		"    (the two above are optional: set, they give the angus State Doc an Open Actions projection)",
		"  capture routing destinations (#299):",
		...idLine("  inbox_database_id", config.inbox_database_id),
		...idLine("  inbox_data_source_id", config.inbox_data_source_id),
		...idLine("  resources_database_id", config.resources_database_id),
		...idLine("  resources_data_source_id", config.resources_data_source_id),
		...routingSetupHint(
			"notion_personal",
			(
				[
					["inbox_database_id", config.inbox_database_id],
					["inbox_data_source_id", config.inbox_data_source_id],
					["resources_database_id", config.resources_database_id],
					["resources_data_source_id", config.resources_data_source_id],
				] as const
			)
				.filter(([, v]) => !v)
				.map(([k]) => k),
		),
		"  raw: " + JSON.stringify(config),
	].join("\n");
}

export function formatNotionConfigGetMcp(output: NotionConfigGetOutput): string {
	const fetchWork = !output.provider || output.provider === "notion_work";
	const fetchPersonal = !output.provider || output.provider === "notion_personal";

	const sections: string[] = [];

	if (fetchWork) {
		sections.push(
			output.notion_work
				? formatWorkConfig(output.notion_work)
				: "notion_work: not configured (add a 'notion_work' row to user_integrations via integration_set({ provider: 'notion_work', config: { tasks_database_id: '<notion-id>', ... } }))",
		);
	}

	if (fetchPersonal) {
		sections.push(
			output.notion_personal
				? formatPersonalConfig(output.notion_personal)
				: "notion_personal: not configured (add a 'notion_personal' row to user_integrations via integration_set({ provider: 'notion_personal', config: { tasks_database_id: '<notion-id>', ... } }))",
		);
	}

	return sections.join("\n\n");
}

export function createNotionConfigGetAction(repo: ConfigRepository) {
	return defineAction({
		id: "notion_config_get",
		domain: "integrations",
		description:
			"Return the owner's persisted Notion integration config(s) from user_integrations. Pass provider='notion_work' or provider='notion_personal' to get one workspace; omit to get both. notion_work holds Work workspace config (tasks DB, dos-hl pointers). notion_personal holds personal workspace config (tasks, people, meeting notes DBs). IDs are non-secret but user-specific — fetch at runtime rather than hard-coding.",
		schema: notionConfigGetSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (args): Promise<NotionConfigGetOutput> => {
			const { provider } = args;
			const fetchWork = !provider || provider === "notion_work";
			const fetchPersonal = !provider || provider === "notion_personal";

			const [workConfig, personalConfig] = await Promise.all([
				fetchWork ? repo.loadConfig("notion_work", notionConfigSchema) : null,
				fetchPersonal ? repo.loadConfig("notion_personal", notionPersonalConfigSchema) : null,
			]);

			return {
				provider,
				...(fetchWork ? { notion_work: workConfig } : {}),
				...(fetchPersonal ? { notion_personal: personalConfig } : {}),
			};
		},
		formatMcp: formatNotionConfigGetMcp,
	});
}
