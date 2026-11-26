import type {
	PlanningIndex,
	PlanningOp,
	PlanningPort,
	PlanningWriteResult,
} from "../../ports/planning.js";

export type { PlanningIndex, PlanningOp, PlanningPort, PlanningWriteResult };

// Client for the Work planning document at planning.example.com/planning.
//
// THROUGH THE APP'S API, NEVER THE DATABASE. The document lives as JSONB in
// product_design.planning_snapshots in the Work Supabase project, and ahkms can
// already read that project. Writing it directly would be less code and is the wrong
// call: `POST /api/planning/snapshots` strips `budget` out of the payload before insert,
// because snapshots are team-readable and the planning doc's finances are not, and that
// rule exists in that route handler and nowhere else. An INSERT from here would put
// financial figures into a team-readable table while the control meant to prevent it
// carried on looking correct in the webapp. #871 was re-scoped to reads-only on exactly
// this finding; example-org/web-app#114 is the write path that replaced it.
//
// OPS, NOT DOCUMENTS. The snapshot endpoint takes the whole ~90KB document, so a caller
// changing one field overwrites every field a human changed while it was thinking.
// `PATCH /api/planning/document` applies ops server-side against the state current at
// request time, all-or-nothing, so the window in which a concurrent edit is lost is one
// request rather than however long an agent session held the document.

export interface PlanningAdapterOptions {
	baseUrl: string | (() => string | Promise<string>);
	getToken: () => string | Promise<string>;
}

export function createPlanningAdapter(options: PlanningAdapterOptions): PlanningPort {
	async function call<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<T> {
		const token = await options.getToken();
		const rawBaseUrl =
			typeof options.baseUrl === "function" ? await options.baseUrl() : options.baseUrl;
		const baseUrl = rawBaseUrl.replace(/\/+$/, "");
		const res = await fetch(`${baseUrl}${path}`, {
			method: init.method ?? "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});

		if (!res.ok) {
			// The body is included deliberately. The API's refusals are written to be
			// actionable — which collection is not writable and what the legal ones are,
			// which id did not resolve, which snapshot is current on a 409 — and a bare
			// "400 Bad Request" throws that away.
			const detail = (await res.text().catch(() => "")).slice(0, 900);
			throw new Error(
				`Planning API ${res.status} on ${init.method ?? "GET"} ${path}: ${detail}`,
			);
		}

		return (await res.json()) as T;
	}

	return {
		/**
		 * Read the document. With no collections this returns an INDEX — snapshot metadata plus
		 * a row count per collection — rather than the document, because the document does not
		 * fit comfortably in a chat context and a caller that pulls it all to read one field has
		 * spent its budget before it starts.
		 */
		async read(collections?: readonly string[]): Promise<PlanningIndex> {
			const query =
				collections && collections.length > 0
					? `?collections=${encodeURIComponent(collections.join(","))}`
					: "";
			return call<PlanningIndex>(`/api/planning/document${query}`);
		},

		/** Apply ops and save the result as a new snapshot. All of them land, or none do. */
		async edit(args: {
			ops: readonly PlanningOp[];
			label?: string;
			baseSnapshotId?: string;
		}): Promise<PlanningWriteResult> {
			return call<PlanningWriteResult>("/api/planning/document", {
				method: "PATCH",
				body: {
					ops: args.ops,
					...(args.label ? { label: args.label } : {}),
					...(args.baseSnapshotId ? { baseSnapshotId: args.baseSnapshotId } : {}),
				},
			});
		},
	};
}
