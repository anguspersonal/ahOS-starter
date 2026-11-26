import { executeAction, type ExecuteActionOptions } from "./adapters/direct.js";
import type { ActionApprovalLifecycleStore } from "./gate.js";
import { inputSha256 } from "./inputHash.js";
import type { ActionCaller, ActionContext, ActionDefinition } from "./types.js";

export class ApprovalConflictError extends Error {
	readonly status = 409;
	readonly decisionId: string;
	constructor(decisionId: string) {
		super(`Decision ${decisionId} is not pending (already resolved, expired or claimed)`);
		this.name = "ApprovalConflictError";
		this.decisionId = decisionId;
	}
}

export type ApprovedRunContext = Pick<ActionContext, "caller" | "userId" | "approval">;

/** Runner for an approved call; signals failure only by throwing or rejecting. */
export type ApprovedRunner<TOutput = unknown> =
	| ((input: unknown, context: ApprovedRunContext) => Promise<TOutput>)
	| { run(input: unknown, context: ApprovedRunContext): Promise<TOutput> };

export interface CallableApprovedRunner<TOutput = unknown> {
	(input: unknown, context: ApprovedRunContext): Promise<TOutput>;
	run(input: unknown, context: ApprovedRunContext): Promise<TOutput>;
}

export type ActionLookup =
	| ((actionId: string) => ActionDefinition<any, any> | undefined)
	| { get(actionId: string): ActionDefinition<any, any> | undefined };

export function actionResolver(
	lookup: ActionLookup,
	options?: Omit<ExecuteActionOptions, "context">,
): (actionId: string) => CallableApprovedRunner | undefined {
	const find = typeof lookup === "function" ? lookup : (id: string) => lookup.get(id);
	return (actionId: string): CallableApprovedRunner | undefined => {
		const action = find(actionId);
		if (!action) return undefined;
		const run = (input: unknown, context: ApprovedRunContext) =>
			executeAction(action, input, { ...options, context });
		return Object.assign(run, { run });
	};
}

export type ApprovedBy =
	| { userId: string; via: "web_inbox" }
	| { userId: string; via: "client"; clientId: string }
	| { userId: string; via: "slack" };

export interface ExecuteApprovedDeps<TResult = unknown> {
	store: ActionApprovalLifecycleStore;
	resolve: (actionId: string) => ApprovedRunner<TResult> | undefined;
	approvedBy: ApprovedBy;
}

export type ExecuteApprovedResult<TResult = unknown> =
	| { status: "executed"; result: TResult }
	| { status: "failed"; error: string };

function formatNotes(by: ApprovedBy): string {
	if (by.via === "web_inbox") return "approved in the web inbox";
	return by.via === "client" ? `approved in client ${by.clientId}` : `approved in ${by.via}`;
}

export async function executeApproved<TResult = unknown>(
	decisionId: string,
	{ store, resolve, approvedBy }: ExecuteApprovedDeps<TResult>,
): Promise<ExecuteApprovedResult<TResult>> {
	const claimed = await store.claim(decisionId, approvedBy.userId, formatNotes(approvedBy));
	if (!claimed) throw new ApprovalConflictError(decisionId);

	const fail = async (error: string): Promise<ExecuteApprovedResult<TResult>> => {
		await store.finish(decisionId, { outcome: "failed", error }, error);
		return { status: "failed", error };
	};

	const currentHash = await inputSha256(claimed.input).catch(() => null);
	if (currentHash !== claimed.inputSha256) return fail("input changed since the request");

	const runner = resolve(claimed.actionId);
	if (!runner) return fail(`no action or tool named ${claimed.actionId} is registered`);

	const context: ApprovedRunContext = {
		caller: claimed.caller as ActionCaller,
		userId: claimed.userId,
		approval: { decisionId: claimed.decisionId, actionId: claimed.actionId, inputSha256: claimed.inputSha256 },
	};

	let result: TResult;
	try {
		result = typeof runner === "function" ? await runner(claimed.input, context) : await runner.run(claimed.input, context);
	} catch (err) {
		return fail((err instanceof Error ? err.message : String(err)).slice(0, 500));
	}
	await store.finish(decisionId, { outcome: "executed" });
	return { status: "executed", result };
}

export interface RejectApprovalDeps {
	store: Pick<ActionApprovalLifecycleStore, "reject">;
	userId: string;
	notes?: string | null;
}

export async function rejectApproval(
	decisionId: string,
	{ store, userId, notes }: RejectApprovalDeps,
): Promise<{ status: "rejected"; decision_id: string }> {
	if (!(await store.reject(decisionId, userId, notes ?? null))) throw new ApprovalConflictError(decisionId);
	return { status: "rejected", decision_id: decisionId };
}
