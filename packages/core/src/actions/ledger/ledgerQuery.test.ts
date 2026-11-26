import { describe, expect, it, vi } from "vitest";
import { createActionContext } from "../defineAction.js";
import { DEFAULT_ACTION_EXPOSURE } from "../exposure.js";
import { createLedgerQueryAction, ledgerQuerySchema } from "./ledgerQuery.js";
import type { ActionLedgerRow, LedgerReadPort } from "../../ports/ledger.js";

const SAMPLE_ROW: ActionLedgerRow = {
	id: "11111111-1111-1111-1111-111111111111",
	created_at: "2026-10-19T10:00:00Z",
	action_id: "capture",
	seam: "action",
	caller: "mcp",
	request_id: "req-1",
	parent_request_id: null,
	trace_id: "trace-1",
	user_id: "user-1",
	client_id: "client-1",
	client_name: "Claude Routine",
	session_id: "sess-1",
	outcome: "success",
	duration_ms: 42,
	error_message: null,
	input_keys: ["content", "content_type"],
	input_sha256: "a".repeat(64),
	decision_id: null,
};

describe("ledger_query action (#1476)", () => {
	it("1. validates schema defaults, bounds, outcomes, and exposure", () => {
		const parsedDefault = ledgerQuerySchema.parse({});
		expect(parsedDefault.mode).toBe("rows");
		expect(parsedDefault.limit).toBe(100);

		const parsedFull = ledgerQuerySchema.parse({
			mode: "summary",
			since: "2026-10-18T00:00:00Z",
			until: "2026-10-19T00:00:00Z",
			action_id: "capture",
			caller: "mcp",
			client_id: "client-1",
			session_id: "sess-1",
			request_id: "req-1",
			trace_id: "trace-1",
			parent_request_id: "req-0",
			outcome: "pending_approval",
			limit: 500,
		});
		expect(parsedFull.outcome).toBe("pending_approval");
		expect(parsedFull.trace_id).toBe("trace-1");
		expect(parsedFull.parent_request_id).toBe("req-0");

		expect(() => ledgerQuerySchema.parse({ limit: 0 })).toThrow();
		expect(() => ledgerQuerySchema.parse({ limit: 501 })).toThrow();
		expect(() => ledgerQuerySchema.parse({ since: "not-a-date" })).toThrow();
		expect(() => ledgerQuerySchema.parse({ outcome: "invalid" })).toThrow();

		const port: LedgerReadPort = {
			queryRows: vi.fn().mockResolvedValue([SAMPLE_ROW]),
			querySummary: vi.fn(),
		};
		const action = createLedgerQueryAction(port);
		expect(action.id).toBe("ledger_query");
		expect(action.annotations.readOnlyHint).toBe(true);
		expect(action.expose).toEqual(DEFAULT_ACTION_EXPOSURE);
	});

	it("2. delegates rows mode with filters and limit to port.queryRows", async () => {
		const port: LedgerReadPort = {
			queryRows: vi.fn().mockResolvedValue([SAMPLE_ROW]),
			querySummary: vi.fn(),
		};
		const action = createLedgerQueryAction(port);
		const result = await action.run(
			{
				mode: "rows",
				action_id: "capture",
				client_id: "client-1",
				trace_id: "trace-1",
				limit: 25,
			},
			createActionContext({ caller: "mcp", userId: "user-1" }),
		);

		expect(port.queryRows).toHaveBeenCalledWith({
			since: undefined,
			until: undefined,
			action_id: "capture",
			caller: undefined,
			client_id: "client-1",
			session_id: undefined,
			request_id: undefined,
			trace_id: "trace-1",
			parent_request_id: undefined,
			outcome: undefined,
			limit: 25,
		});
		expect(result).toEqual({
			mode: "rows",
			rows: [SAMPLE_ROW],
		});
	});

	it("3. delegates summary mode to port.querySummary", async () => {
		const port: LedgerReadPort = {
			queryRows: vi.fn(),
			querySummary: vi.fn().mockResolvedValue({
				by_action: [{ action_id: "capture", outcome: "success", count: 12 }],
				row_estimate: 120,
				total_bytes: 65536,
			}),
		};
		const action = createLedgerQueryAction(port);
		const result = await action.run(
			{
				mode: "summary",
				since: "2026-10-18T00:00:00Z",
				limit: 100,
			},
			createActionContext({ caller: "mcp", userId: "user-1" }),
		);

		expect(port.querySummary).toHaveBeenCalledWith({
			since: "2026-10-18T00:00:00Z",
			until: undefined,
			action_id: undefined,
			caller: undefined,
			client_id: undefined,
			session_id: undefined,
			request_id: undefined,
			trace_id: undefined,
			parent_request_id: undefined,
			outcome: undefined,
		});
		expect(result).toEqual({
			mode: "summary",
			by_action: [{ action_id: "capture", outcome: "success", count: 12 }],
			row_estimate: 120,
			total_bytes: 65536,
		});
	});
});
