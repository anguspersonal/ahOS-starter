import type { ActionAuditOutcome, ActionAuditSeam } from "../actions/types.js";

export interface LedgerQueryFilters {
	since?: string;
	until?: string;
	action_id?: string;
	caller?: string;
	client_id?: string;
	session_id?: string;
	request_id?: string;
	trace_id?: string;
	parent_request_id?: string;
	outcome?: ActionAuditOutcome;
	limit?: number;
}

export interface ActionLedgerRow {
	id: string;
	created_at: string;
	action_id: string;
	seam: ActionAuditSeam;
	caller: string;
	request_id: string;
	parent_request_id: string | null;
	trace_id: string | null;
	user_id: string | null;
	client_id: string | null;
	client_name: string | null;
	session_id: string | null;
	outcome: ActionAuditOutcome;
	duration_ms: number;
	error_message: string | null;
	input_keys: string[];
	input_sha256: string | null;
	decision_id?: string | null;
}

export interface ActionLedgerSummaryBucket {
	action_id: string;
	outcome: ActionAuditOutcome;
	count: number;
}

export interface ActionLedgerSummary {
	by_action: ActionLedgerSummaryBucket[];
	row_estimate: number;
	total_bytes: number;
}

export interface LedgerReadPort {
	queryRows(filters: LedgerQueryFilters): Promise<ActionLedgerRow[]>;
	querySummary(filters: Omit<LedgerQueryFilters, "limit">): Promise<ActionLedgerSummary>;
}
