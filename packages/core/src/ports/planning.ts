/** One change. `collection` is checked by the API, which names the legal ones on refusal. */
export type PlanningOp =
	| {
			collection: string;
			op: "patch";
			id: string;
			value: Record<string, unknown>;
	  }
	| { collection: string; op: "upsert"; value: Record<string, unknown> }
	| { collection: string; op: "remove"; id: string };

export type PlanningSlugRegistry = {
	domains?: string[];
	goals?: string[];
	projectParents?: string[];
};

export type PlanningIndex = {
	snapshotId: string;
	label: string | null;
	createdAt: string;
	writable: string[];
	collections?: Record<string, number | "object">;
	data?: Record<string, unknown>;
	domains?: string[];
	goals?: string[];
	projectParents?: string[];
};

export type PlanningWriteResult = {
	snapshotId: string;
	label: string | null;
	createdAt: string;
	applied: string[];
	/** Warnings about the records this write touched. */
	warnings: { code: string; severity: string; subject: string; message: string }[];
	/**
	 * How many OTHER validator warnings the model is carrying.
	 */
	standingWarnings: number;
};

export interface PlanningPort {
	read(collections?: readonly string[]): Promise<PlanningIndex>;
	edit(args: {
		ops: readonly PlanningOp[];
		label?: string;
		baseSnapshotId?: string;
	}): Promise<PlanningWriteResult>;
}
