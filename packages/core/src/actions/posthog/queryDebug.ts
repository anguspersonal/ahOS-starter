import { z } from "zod";
import {
	assertFilterApplied,
	assertPolicyDeclared,
	stampFor,
	withHogqlPropertyHint,
} from "../../domain/posthog/contract.js";
import type { PostHogPort, PostHogQueryResult } from "../../ports/posthog.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	renderRows,
	resolvePostHogConnection,
	withTestAccountsFlag,
} from "./render.js";

/**
 * total / filtered / difference, side by side. Never the total alone.
 *
 * The fast path — a single numeric cell on both sides — is the additive-aggregate case
 * (`count()`) the query is normally written for, and it is the ONLY case where
 * `total - filtered` means "test-account traffic". Anything wider (multiple rows,
 * distinct users, a funnel rate, retention) does not subtract, so it is labelled a plain
 * arithmetic "difference" there, and the general case skips the subtraction entirely
 * rather than print a number that looks like a metric it is not.
 */
export function renderComparison(
	filtered: PostHogQueryResult,
	total: PostHogQueryResult,
): string {
	const fRows = filtered.results ?? [];
	const tRows = total.results ?? [];

	const isSingleNumber = (r: unknown[][]) =>
		r.length === 1 && r[0].length === 1 && typeof r[0][0] === "number";

	if (isSingleNumber(fRows) && isSingleNumber(tRows)) {
		const f = fRows[0][0] as number;
		const t = tRows[0][0] as number;
		const label = (filtered.columns ?? total.columns ?? [])[0] ?? "value";
		return [
			label,
			`  total      (unfiltered, includes test accounts): ${t}`,
			`  filtered   (test accounts excluded):              ${f}`,
			`  difference (total − filtered):                    ${t - f}`,
			"",
			'"difference" is a plain subtraction, not a labelled "test traffic" figure — it is ' +
				"only interpretable as test-account traffic for additive aggregates like count(). " +
				"For distinct users, funnel rates or retention it does not subtract this way.",
		].join("\n");
	}

	return [
		"total (unfiltered, includes test accounts):",
		renderRows(total),
		"",
		"filtered (test accounts excluded):",
		renderRows(filtered),
		"",
		"No difference computed: this result is not a single-row, single-column aggregate, so " +
			'"total minus filtered" would not be a meaningful number here.',
	].join("\n");
}

export const posthogQueryDebugInput = {
	connection: z
		.string()
		.min(1)
		.describe("Connection slug, e.g. 'work'. Must declare filter_policy 'required'."),
	query: z
		.record(z.string(), z.unknown())
		.describe(
			"The SAME guarded query shape posthog_query requires: for HogQL, the {filters} " +
				"placeholder in the SQL plus filters:{filterTestAccounts:true}; structured kinds " +
				"set filterTestAccounts:true directly. Pass exactly ONE query — this tool derives " +
				"the unfiltered leg itself by flipping filterTestAccounts to false on the identical " +
				"query text, it does not accept two.",
		),
	reason: z
		.string()
		.min(1)
		.describe(
			"Why this debugging read needs unfiltered traffic, e.g. 'reproducing the " +
				"scroll-to-end crash, which was hit on a test account'. Required: this tool exists " +
				"for a declared debugging purpose, not a general bypass of filter_policy, and the " +
				"reason is carried into the stamp so that purpose travels with the numbers.",
		),
} as const;

export const posthogQueryDebugSchema = z.object(posthogQueryDebugInput);

export type PosthogQueryDebugInput = z.infer<typeof posthogQueryDebugSchema>;

export function createPosthogQueryDebugAction(
	port: PostHogPort,
): ActionDefinition<typeof posthogQueryDebugSchema, string> {
	return defineAction({
		id: "posthog_query_debug",
		domain: "integrations",
		description:
			"Run one guarded query twice against a 'required'-policy connection — as given, and with only " +
			"filterTestAccounts flipped to false — and render total, filtered and difference together. The " +
			"unfiltered number is never emitted alone. Requires a `reason`, carried into the stamp. Full " +
			"notes: docs/guides/tools/posthog_query_debug.md",
		schema: posthogQueryDebugSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: (out) => out,
		run: async (args) => {
			const conn = await resolvePostHogConnection(port, args.connection);

			assertPolicyDeclared(conn);
			if (conn.filterPolicy !== "required") {
				// Nothing to compare against: 'not_applicable' has no test-account filter to
				// remove, so total and filtered are the same query. Send the caller to the plain
				// read rather than run two identical queries and label the pair "debug".
				throw new Error(
					`Connection '${conn.ref}' declares filter_policy '${conn.filterPolicy}', so there is no test-account filter to compare against. posthog_query_debug exists to compare a connection's filtered reads against its unfiltered ones; use posthog_query directly on this connection.`,
				);
			}

			// The filtered leg must clear the SAME guard posthog_query enforces. This tool adds a
			// second declared purpose for the connection; it does not weaken the first one.
			assertFilterApplied(conn, args.query);
			const filteredQuery = args.query;
			const totalQuery = withTestAccountsFlag(args.query, false);

			const target = { ref: conn.ref, host: conn.host };
			const [filteredResult, totalResult] = await Promise.all([
				port.runQuery(target, conn.projectId, filteredQuery),
				port.runQuery(target, conn.projectId, totalQuery),
			]).catch((err) => {
				throw withHogqlPropertyHint(err);
			});

			const stamp = stampFor(conn);
			const header = [
				`connection:    ${stamp.connection}`,
				`project:       ${stamp.project_id}`,
				`region:        ${stamp.region}`,
				`filter policy: ${stamp.filter_policy} — DEBUG READ, INCLUDES TEST ACCOUNTS`,
				`reason:        ${args.reason}`,
				`pulled at:     ${stamp.pulled_at}`,
			].join("\n");

			return `${header}\n\n${renderComparison(filteredResult, totalResult)}`;
		},
	});
}
