import { z } from "zod";
import {
	assertFilterApplied,
	HOGQL_PROPERTY_ACCESS_HINT,
	stampFor,
	withHogqlPropertyHint,
} from "../../domain/posthog/contract.js";
import type { PostHogPort } from "../../ports/posthog.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { renderRows, resolvePostHogConnection, withStamp } from "./render.js";

export const posthogQueryInput = {
	connection: z
		.string()
		.min(1)
		.describe("Connection slug, e.g. 'work'. Run posthog_connections to list them."),
	query: z
		.record(z.string(), z.unknown())
		.describe(
			"A PostHog query object, passed through verbatim. For raw SQL use {kind:'HogQLQuery', query:'...'}. " +
				"IMPORTANT: when the connection's filter policy is 'required', a HogQL query MUST include the literal " +
				"`{filters}` placeholder in its WHERE clause (e.g. `... where timestamp >= now() - interval 7 day and {filters}`) " +
				"AND pass `filters: {filterTestAccounts: true}` alongside it. Without both, PostHog silently returns unfiltered " +
				"numbers that look correct — measured at 18% high on 7-day event volume for project 110015. Structured query " +
				"kinds (TrendsQuery etc.) set `filterTestAccounts: true` directly instead. There is no " +
				"debugging bypass on this tool — for a declared debugging read that needs unfiltered " +
				"traffic, use posthog_query_debug instead, which always returns filtered and unfiltered " +
				`together rather than the unfiltered figure alone. ${HOGQL_PROPERTY_ACCESS_HINT}`,
		),
} as const;

export const posthogQuerySchema = z.object(posthogQueryInput);

export type PosthogQueryInput = z.infer<typeof posthogQuerySchema>;

export function createPosthogQueryAction(
	port: PostHogPort,
): ActionDefinition<typeof posthogQuerySchema, string> {
	return defineAction({
		id: "posthog_query",
		domain: "integrations",
		description:
			"Run one read query against a single PostHog connection and return the rows stamped with connection, project, region, filter policy and pull time. Refuses (never silently rewrites) a HogQL query that omits the {filters} placeholder when the connection requires filtering, because PostHog would otherwise return unfiltered numbers that look correct. One connection per call by design: cross-connection totals are meaningless.",
		schema: posthogQuerySchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: (out) => out,
		run: async (args) => {
			const conn = await resolvePostHogConnection(port, args.connection);

			// Guard BEFORE the network call. A refused query should cost nothing and, more to
			// the point, should never have its results exist even briefly — the error is the
			// answer, and returning numbers alongside it would invite using them.
			assertFilterApplied(conn, args.query);

			const result = await port
				.runQuery({ ref: conn.ref, host: conn.host }, conn.projectId, args.query)
				.catch((err) => {
					throw withHogqlPropertyHint(err);
				});

			return withStamp(stampFor(conn), renderRows(result));
		},
	});
}
