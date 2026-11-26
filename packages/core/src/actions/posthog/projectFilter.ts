import { z } from "zod";
import { stampFor } from "../../domain/posthog/contract.js";
import type { PostHogPort } from "../../ports/posthog.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { resolvePostHogConnection, withStamp } from "./render.js";

export const posthogProjectFilterInput = {
	connection: z
		.string()
		.min(1)
		.describe("Connection slug, e.g. 'work' (the row provider is 'posthog:<slug>')."),
} as const;

export const posthogProjectFilterSchema = z.object(posthogProjectFilterInput);

export type PosthogProjectFilterInput = z.infer<typeof posthogProjectFilterSchema>;

export function createPosthogProjectFilterAction(
	port: PostHogPort,
): ActionDefinition<typeof posthogProjectFilterSchema, string> {
	return defineAction({
		id: "posthog_project_filter",
		domain: "integrations",
		description:
			"Read a PostHog project's own 'filter out internal and test users' setting, live from PostHog. This is the authoritative content of the test-account contract (#742); it is deliberately not copied into this repo, so use this rather than assuming what it contains.",
		schema: posthogProjectFilterSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: (out) => out,
		run: async (args) => {
			const conn = await resolvePostHogConnection(port, args.connection);
			const project = await port.getProject({ ref: conn.ref, host: conn.host }, conn.projectId);

			// Read from PostHog every time rather than cached in config. This is the content of
			// the contract, and PostHog is its only record — a copy in this repo would drift the
			// moment somebody edits the setting in the UI, and drift silently.
			const filters = project.testAccountFilters;
			const body = [
				`project name: ${project.name}`,
				`default-checked: ${project.testAccountFiltersDefaultChecked}`,
				"",
				filters.length
					? `test-account filter, ${filters.length} clause(s), as PostHog holds it:\n${filters
							.map((f) => `  ${JSON.stringify(f)}`)
							.join("\n")}`
					: "test-account filter: none configured in PostHog.",
				"",
				"These clauses are applied by PostHog when a query carries the {filters} placeholder.",
				"They are not stored in this repo, so this is always current.",
			].join("\n");

			return withStamp(stampFor(conn), body);
		},
	});
}
