import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { ACTION_AUDIT_OUTCOMES, type ActionDefinition } from "../types.js";
import type {
	ActionLedgerRow,
	ActionLedgerSummary,
	LedgerReadPort,
} from "../../ports/ledger.js";

export const ledgerQuerySchema = z.object({
	mode: z.enum(["rows", "summary"]).default("rows").describe("Query mode: 'rows' returns matching ledger rows; 'summary' returns counts by action and outcome plus table size."),
	since: z.string().datetime({ offset: true }).optional().describe("Inclusive lower bound on created_at (ISO 8601 datetime)."),
	until: z.string().datetime({ offset: true }).optional().describe("Exclusive upper bound on created_at (ISO 8601 datetime)."),
	action_id: z.string().optional().describe("Filter to a specific action_id (exact)."),
	caller: z.string().optional().describe("Filter to a specific caller surface (e.g. 'mcp', 'http', 'ui', 'worker')."),
	client_id: z.string().optional().describe("Filter to a specific OAuth client_id."),
	session_id: z.string().optional().describe("Filter to a specific session_id."),
	request_id: z.string().optional().describe("Filter to a specific request_id."),
	trace_id: z.string().optional().describe("Filter to a specific end-to-end trace_id."),
	parent_request_id: z.string().optional().describe("Filter to a specific parent_request_id."),
	outcome: z.enum(ACTION_AUDIT_OUTCOMES).optional().describe("Filter to a specific audit outcome."),
	limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of rows to return in 'rows' mode (1..500, default 100)."),
});

export type LedgerQueryInput = z.infer<typeof ledgerQuerySchema>;

export type LedgerQueryOutput =
	| {
			mode: "rows";
			rows: ActionLedgerRow[];
	  }
	| ({
			mode: "summary";
	  } & ActionLedgerSummary);

export function formatLedgerQueryMcp(output: LedgerQueryOutput): string {
	return JSON.stringify(output, null, 2);
}

export function createLedgerQueryAction(
	port: LedgerReadPort,
): ActionDefinition<typeof ledgerQuerySchema, LedgerQueryOutput> {
	return defineAction({
		id: "ledger_query",
		domain: "ops",
		description:
			"Query the append-only action_ledger by time window, action_id, caller, client_id, session_id, request_id, trace_id, parent_request_id, or outcome. Returns matching rows (enriched with OAuth client_name; rows record only input_keys and input_sha256, never input values) or a summary of counts by action and outcome with row_estimate and total_bytes.",
		schema: ledgerQuerySchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: LedgerQueryInput): Promise<LedgerQueryOutput> => {
			const mode = input.mode ?? "rows";
			if (mode === "summary") {
				const summary = await port.querySummary({
					since: input.since,
					until: input.until,
					action_id: input.action_id,
					caller: input.caller,
					client_id: input.client_id,
					session_id: input.session_id,
					request_id: input.request_id,
					trace_id: input.trace_id,
					parent_request_id: input.parent_request_id,
					outcome: input.outcome,
				});
				return {
					mode: "summary",
					...summary,
				};
			}

			const rows = await port.queryRows({
				since: input.since,
				until: input.until,
				action_id: input.action_id,
				caller: input.caller,
				client_id: input.client_id,
				session_id: input.session_id,
				request_id: input.request_id,
				trace_id: input.trace_id,
				parent_request_id: input.parent_request_id,
				outcome: input.outcome,
				limit: input.limit ?? 100,
			});
			return {
				mode: "rows",
				rows,
			};
		},
		formatMcp: formatLedgerQueryMcp,
	});
}
