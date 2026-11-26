import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { redactIntegrationConfig } from "../../domain/integrations.js";
import type { ConfigRepository, IntegrationSummary } from "../../ports/config.js";

const SHOW_CONFIG = Symbol("integrationList.showConfig");

export const integrationListInput = {
	provider: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional provider key (e.g. 'github', 'notion_work') to filter the returned integrations and include its non-secret config in MCP output.",
		),
	include_config: z
		.boolean()
		.optional()
		.describe(
			"When true, include redacted non-secret config values in the MCP text summary.",
		),
} as const;

export const integrationListSchema = z.object(integrationListInput);

export type IntegrationListInput = z.infer<typeof integrationListSchema>;

export interface IntegrationListOutput {
	integrations: IntegrationSummary[];
	include_config?: boolean;
}

export function formatIntegrationListMcp(
	output: IntegrationListOutput,
	options?: { include_config?: boolean; provider?: string },
): string {
	const { integrations } = output;

	if (integrations.length === 0) {
		return "No integrations configured. Add rows to user_integrations (e.g. provider 'notion_work' with { tasks_database_id }).";
	}

	const symbolShowConfig = (output as IntegrationListOutput & { [SHOW_CONFIG]?: boolean })[
		SHOW_CONFIG
	];
	const showConfig =
		options?.include_config !== undefined || options?.provider !== undefined
			? Boolean(options.include_config || options.provider)
			: output.include_config !== undefined
				? Boolean(output.include_config)
				: symbolShowConfig !== undefined
					? symbolShowConfig
					: integrations.some((i) => i.config !== undefined);

	// Deliberately prints only provider/routing/status/enabled/which keys are set by default —
	// redacted non-secret config values are appended when include_config or provider is supplied.
	// routing shows where each connector is sourced (native | mcp | own_substrate); see ADR-032.
	const body = integrations
		.map((i) => {
			const header = `• ${i.provider} [${i.routing}${
				i.status === "connected" ? "" : `, ${i.status}`
			}]${i.enabled ? "" : " (disabled)"} — keys: ${
				i.config_keys.length ? i.config_keys.join(", ") : "(none)"
			}`;
			if (!showConfig) {
				return header;
			}
			const safeConfig = redactIntegrationConfig(i.config ?? {});
			return `${header}\n  config: ${JSON.stringify(safeConfig)}`;
		})
		.join("\n");

	// #818 scope 2: page access is workspace-wide, not per-database, so an agent can
	// check it exists BEFORE promising a page update — the 2026-08-23 failure was a
	// session that looked healthy because structured writes kept working while page
	// work was silently unreachable.
	const notionProviders = integrations.filter((i) => i.provider.startsWith("notion"));
	const pageAccess =
		notionProviders.length === 0
			? ""
			: "\n\nNotion page access (#625/#818): notion_page_get / notion_page_update reach arbitrary pages — domain='work' → notion_work, domain='angus' → notion_personal. Configured destinations keep their dedicated writers (task_create, state_doc_update, daily_log_create).";

	return `Configured integrations:\n${body}${pageAccess}`;
}

export function createIntegrationListAction(repo: ConfigRepository) {
	return defineAction({
		id: "integration_list",
		domain: "integrations",
		description:
			"List which external integrations (e.g. Notion tasks, GitHub) are configured for you, with optional provider filtering and redacted non-secret config inspection.",
		schema: integrationListSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args?: IntegrationListInput): Promise<IntegrationListOutput> => {
			const rawIntegrations = await repo.listIntegrations();
			const filtered = args?.provider
				? rawIntegrations.filter((i) => i.provider === args.provider)
				: rawIntegrations;
			const showConfig = Boolean(args?.include_config || args?.provider);
			const integrations = filtered.map((i) =>
				i.config !== undefined || showConfig
					? { ...i, config: redactIntegrationConfig(i.config ?? {}) }
					: i,
			);
			const out: IntegrationListOutput = { integrations };
			Object.defineProperty(out, SHOW_CONFIG, {
				value: showConfig,
				enumerable: false,
			});
			return out;
		},
		formatMcp: formatIntegrationListMcp,
	});
}
