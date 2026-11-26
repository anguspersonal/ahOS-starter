import {
	REVIEW_BAND_AUTO_APPLY_THRESHOLD,
	REVIEW_BAND_BLOCK_THRESHOLD,
	actionConfidenceSchema,
	type ActionConfidence,
	type ActionContext,
	type NeedsApproval,
} from "./types.js";
import { inputSha256 } from "./inputHash.js";

export {
	REVIEW_BAND_AUTO_APPLY_THRESHOLD,
	REVIEW_BAND_BLOCK_THRESHOLD,
	actionConfidenceSchema,
	type ActionConfidence,
};

export function needsReviewBandApproval(
	input: { confidence?: ActionConfidence } | unknown,
	_ctx?: ActionContext,
): boolean {
	if (!input || typeof input !== "object" || !("confidence" in input)) {
		return false;
	}
	const confidence = (input as { confidence?: ActionConfidence }).confidence;
	if (!confidence || typeof confidence.epistemic !== "number") {
		return false;
	}
	if (confidence.epistemic < REVIEW_BAND_BLOCK_THRESHOLD) {
		throw new ApprovalDeniedError(
			"review_band_gate",
			`Confidence ${confidence.epistemic} is below block threshold (${REVIEW_BAND_BLOCK_THRESHOLD.toFixed(2)})`,
		);
	}
	if (confidence.epistemic >= REVIEW_BAND_AUTO_APPLY_THRESHOLD) {
		return false;
	}
	return true;
}

export interface ApprovalRequest {
	actionId: string;
	input: unknown;
	inputSha256: string;
	caller: string;
	requestId: string;
	userId: string | null;
	clientId: string | null;
	sessionId: string | null;
}

export interface ActionApprovalStore {
	park(request: ApprovalRequest): Promise<{ decisionId: string }>;
}

export interface ClaimedApproval {
	decisionId: string;
	actionId: string;
	input: unknown;
	inputSha256: string;
	caller: string;
	userId: string;
}

export type ApprovalResolutionOutcome = "executed" | "failed";

export interface ApprovalFinishResolution {
	outcome?: ApprovalResolutionOutcome;
	status?: ApprovalResolutionOutcome;
	error?: string;
}

export interface ActionApprovalLifecycleStore extends ActionApprovalStore {
	claim(
		decisionId: string,
		approverUserId: string,
		notes?: string | null,
	): Promise<ClaimedApproval | null>;
	finish(
		decisionId: string,
		resolution: ApprovalResolutionOutcome | ApprovalFinishResolution,
		error?: string,
	): Promise<void>;
	reject(
		decisionId: string,
		approverUserId: string,
		notes?: string | null,
	): Promise<boolean>;
}

export interface PendingApprovalInboxRow {
	decision_id: string;
	action_id: string | null;
	input: unknown;
	input_keys: string[] | null;
	caller: string | null;
	client_id: string | null;
	session_id: string | null;
	created_at: string;
	expires_at: string | null;
}

export type PendingApprovalRow = PendingApprovalInboxRow;

export interface ApprovalInboxStore extends ActionApprovalLifecycleStore {
	listPending(userId: string, limit: number): Promise<PendingApprovalInboxRow[]>;
}

let activeApprovalStore: ActionApprovalStore | undefined;

export function setActionApprovalStore(store: ActionApprovalStore | undefined): void {
	activeApprovalStore = store;
}

export function getActionApprovalStore(): ActionApprovalStore | undefined {
	return activeApprovalStore;
}

export type InClientAnswer = "approve" | "reject" | "unanswered";

export interface InClientApprover {
	clientId: string;
	ask(request: {
		decisionId: string;
		actionId: string;
		input: unknown;
		caller: string;
	}): Promise<InClientAnswer>;
}

export class PendingApprovalError extends Error {
	readonly decisionId: string;
	readonly actionId: string;
	readonly inputSha256?: string;

	constructor(decisionId: string, actionId: string, hash?: string) {
		super(`Action "${actionId}" is parked awaiting owner approval (decisionId=${decisionId})`);
		this.name = "PendingApprovalError";
		this.decisionId = decisionId;
		this.actionId = actionId;
		this.inputSha256 = hash;
	}
}

export class ApprovalDeniedError extends Error {
	readonly actionId: string;
	readonly inputSha256?: string;
	readonly decisionId?: string;

	constructor(actionId: string, reason: string, hash?: string, decisionId?: string) {
		super(`Action "${actionId}" denied by approval gate: ${reason}`);
		this.name = "ApprovalDeniedError";
		this.actionId = actionId;
		this.inputSha256 = hash;
		this.decisionId = decisionId;
	}
}

export function isPendingApproval(err: unknown): err is PendingApprovalError {
	return err instanceof PendingApprovalError || (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "PendingApprovalError" &&
		typeof (err as { decisionId?: unknown }).decisionId === "string" &&
		typeof (err as { actionId?: unknown }).actionId === "string"
	);
}

export interface EvaluateGateArgs {
	actionId: string;
	needsApproval?: NeedsApproval;
	input: unknown;
	ctx: ActionContext;
}

export interface EvaluateGateResult {
	inputSha256?: string;
	decisionId?: string;
}

export async function evaluateGate({
	actionId,
	needsApproval,
	input,
	ctx,
}: EvaluateGateArgs): Promise<EvaluateGateResult> {
	if (!needsApproval || ctx.caller === "ui") {
		return {};
	}

	let gated = true;
	if (typeof needsApproval === "function") {
		try {
			gated = Boolean(await needsApproval(input, ctx));
		} catch (err) {
			if (err instanceof ApprovalDeniedError) {
				if (err.actionId === "review_band_gate") {
					throw new ApprovalDeniedError(
						actionId,
						err.message.replace(/^Action "review_band_gate" denied by approval gate: /, ""),
						err.inputSha256,
						err.decisionId,
					);
				}
				throw err;
			}
			gated = true;
		}
	}

	if (!gated) {
		return {};
	}

	const hash = await inputSha256(input);

	if (ctx.approval) {
		if (ctx.approval.actionId === actionId) {
			if (ctx.approval.inputSha256 === hash) {
				return { inputSha256: hash, decisionId: ctx.approval.decisionId };
			}
			throw new ApprovalDeniedError(
				actionId,
				"input does not match the approved request",
				hash,
				ctx.approval.decisionId,
			);
		}
		if (ctx.caller === "internal") {
			return { inputSha256: hash, decisionId: ctx.approval.decisionId };
		}
		throw new ApprovalDeniedError(
			actionId,
			`approval is scoped to action "${ctx.approval.actionId}"`,
			hash,
			ctx.approval.decisionId,
		);
	}

	if (!activeApprovalStore) {
		throw new ApprovalDeniedError(actionId, "no approval store is configured", hash);
	}

	const { decisionId } = await activeApprovalStore.park({
		actionId,
		input,
		inputSha256: hash,
		caller: ctx.caller,
		requestId: ctx.requestId,
		userId: ctx.userId ?? null,
		clientId: ctx.clientId ?? null,
		sessionId: ctx.sessionId ?? null,
	});

	throw new PendingApprovalError(decisionId, actionId, hash);
}
