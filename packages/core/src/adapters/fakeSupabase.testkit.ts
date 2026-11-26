/**
 * Test kit: a recording fake of the `@supabase/supabase-js` query builder.
 *
 * It records every call (table, operation, payload, filters, options) so tests
 * can assert on table names, conflict targets and WHERE clauses, and answers
 * each call from a caller-supplied `respond` function. Excluded from the build.
 */

export interface RecordedCall {
	table: string;
	op: "select" | "insert" | "upsert" | "update" | "delete";
	payload?: unknown;
	options?: Record<string, unknown>;
	filters: Array<{ method: string; args: unknown[] }>;
	selected?: string;
	single?: "single" | "maybeSingle";
}

export interface FakeResponse {
	data?: unknown;
	error?: { message: string; code?: string } | null;
	count?: number | null;
}

export type Responder = (call: RecordedCall) => FakeResponse | Promise<FakeResponse>;

export function createFakeSupabase(respond: Responder = () => ({ data: [], error: null })) {
	const calls: RecordedCall[] = [];
	const rpcCalls: Array<{ fn: string; args: unknown }> = [];
	let rpcResponder: (fn: string, args: unknown) => FakeResponse = () => ({ data: 1, error: null });

	function builder(table: string) {
		const call: RecordedCall = { table, op: "select", filters: [] };
		calls.push(call);
		const api: any = {};
		const record = (method: string) => (...args: unknown[]) => {
			call.filters.push({ method, args });
			return api;
		};
		for (const m of ["eq", "neq", "in", "lt", "lte", "gt", "gte", "not", "or", "order", "range", "limit", "is", "ilike", "like", "contains"]) {
			api[m] = record(m);
		}
		api.select = (cols?: string, options?: Record<string, unknown>) => {
			if (call.op === "select") call.options = options;
			call.selected = cols;
			return api;
		};
		api.insert = (payload: unknown, options?: Record<string, unknown>) => {
			call.op = "insert";
			call.payload = payload;
			call.options = options;
			return api;
		};
		api.upsert = (payload: unknown, options?: Record<string, unknown>) => {
			call.op = "upsert";
			call.payload = payload;
			call.options = options;
			return api;
		};
		api.update = (payload: unknown, options?: Record<string, unknown>) => {
			call.op = "update";
			call.payload = payload;
			call.options = options;
			return api;
		};
		api.delete = () => {
			call.op = "delete";
			return api;
		};
		api.maybeSingle = () => {
			call.single = "maybeSingle";
			return api;
		};
		api.single = () => {
			call.single = "single";
			return api;
		};
		api.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
			Promise.resolve(respond(call)).then((r) => {
				let data = r.data;
				if (call.single && Array.isArray(data)) data = data[0] ?? null;
				return { data: data ?? null, error: r.error ?? null, count: r.count ?? null };
			}).then(resolve, reject);
		return api;
	}

	return {
		client: {
			from: (table: string) => builder(table),
			rpc: (fn: string, args: unknown) => {
				rpcCalls.push({ fn, args });
				const r = rpcResponder(fn, args);
				return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
			},
		} as any,
		calls,
		rpcCalls,
		setRpcResponder(fn: (name: string, args: unknown) => FakeResponse) {
			rpcResponder = fn;
		},
		filtersOf(call: RecordedCall, method: string) {
			return call.filters.filter((f) => f.method === method).map((f) => f.args);
		},
	};
}
