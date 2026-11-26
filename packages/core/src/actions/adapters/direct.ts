import type { z } from "zod";
import type {
	ActionAuditRecord,
	ActionAuditSink,
	ActionContext,
	ActionDefinition,
} from "../types.js";
import { canonicalJson, sha256Hex } from "../inputHash.js";
import { getActionScope } from "../scope.js";
import { ApprovalDeniedError, evaluateGate, getActionApprovalStore, isPendingApproval, type ActionApprovalLifecycleStore, type InClientApprover } from "../gate.js";

function getIsomorphicUUID(): string {
	if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Standard stderr audit sink formatting audit events identically to console.error.
 */
export const stderrAuditSink: ActionAuditSink = (record: ActionAuditRecord) => {
	console.error(
		`[audit:action] ${record.actionId} caller=${record.caller} requestId=${record.requestId} durationMs=${record.durationMs} success=${record.outcome === "success"} outcome=${record.outcome}`,
	);
};

let defaultAuditSink: ActionAuditSink = stderrAuditSink;

/**
 * Sets the default action audit sink used when an action execution does not supply a custom sink.
 */
export function setDefaultAuditSink(sink: ActionAuditSink): void {
	defaultAuditSink = sink;
}

/**
 * Invokes an audit sink safely, reporting any throw or rejection to stderr naming the requestId,
 * and never throwing or altering execution flow.
 */
export async function recordActionAudit(
	record: ActionAuditRecord,
	sink?: ActionAuditSink,
): Promise<void> {
	const activeSink = sink ?? defaultAuditSink;
	try {
		await activeSink(record);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`[audit:action] audit sink error for requestId=${record.requestId}: ${message}`,
		);
	}
}

export interface ExecuteActionOptions {
	context?: Partial<ActionContext>;
	skipValidation?: boolean;
	auditSink?: ActionAuditSink;
	inClientApproval?: InClientApprover;
}

/**
 * Execute an ActionDefinition directly with typed input and output (ADR-100).
 * Bypasses protocol envelopes (MCP / HTTP) for internal callers, tests, and workers.
 * Centralised audit logging is recorded for every call and outcome (ADR-104 L1, L2, L10).
 */
export async function executeAction<
	TInputSchema extends z.ZodTypeAny,
	TOutput,
>(
	action: ActionDefinition<TInputSchema, TOutput>,
	input: z.input<TInputSchema>,
	options?: ExecuteActionOptions,
): Promise<TOutput> {
	const startTime = Date.now();
	const scope = getActionScope();
	let parentCtx: ActionContext | undefined;
	try {
		parentCtx = scope.current();
	} catch {
		parentCtx = undefined;
	}

	const inputKeys =
		input && typeof input === "object" ? Object.keys(input) : [];
	const clientId = options?.context?.clientId ? options.context.clientId : null;
	const sessionId = options?.context?.sessionId ? options.context.sessionId : null;
	const userId = options?.context?.userId ?? null;
	const caller = options?.context?.caller ?? "worker";
	const requestId = options?.context?.requestId ?? getIsomorphicUUID();
	const parentRequestId =
		options?.context?.parentRequestId !== undefined
			? options.context.parentRequestId
			: (parentCtx?.requestId ?? null);
	const traceId =
		options?.context?.traceId ??
		parentCtx?.traceId ??
		parentCtx?.requestId ??
		requestId;

	let parsedInput: z.infer<TInputSchema>;
	try {
		parsedInput = options?.skipValidation
			? (input as z.infer<TInputSchema>)
			: action.schema.parse(input);
	} catch (err) {
		const durationMs = Date.now() - startTime;
		const rawMsg = err instanceof Error ? err.message : String(err);
		const errorMessage = rawMsg ? rawMsg.slice(0, 500) : null;
		const record: ActionAuditRecord = {
			actionId: action.id,
			seam: "action",
			caller,
			requestId,
			parentRequestId,
			traceId,
			userId,
			clientId,
			sessionId,
			outcome: "validation_error",
			durationMs,
			errorMessage,
			inputKeys,
			inputSha256: null,
		};
		await recordActionAudit(record, options?.auditSink);
		throw err;
	}

	let canonicalInput: string;
	try {
		canonicalInput = canonicalJson(parsedInput);
	} catch (err) {
		const durationMs = Date.now() - startTime;
		const rawMsg = err instanceof Error ? err.message : String(err);
		const errorMessage = rawMsg ? rawMsg.slice(0, 500) : null;
		const record: ActionAuditRecord = {
			actionId: action.id,
			seam: "action",
			caller,
			requestId,
			parentRequestId,
			traceId,
			userId,
			clientId,
			sessionId,
			outcome: "error",
			durationMs,
			errorMessage,
			inputKeys,
			inputSha256: null,
		};
		await recordActionAudit(record, options?.auditSink);
		throw err;
	}

	const domain =
		options?.context?.domain ??
		(parsedInput && typeof parsedInput === "object" && "domain" in parsedInput
			? (parsedInput as { domain?: "work" | "angus" }).domain
			: undefined);

	const ctx: ActionContext = {
		caller,
		requestId,
		parentRequestId,
		traceId,
		userId: options?.context?.userId,
		clientId: options?.context?.clientId,
		sessionId: options?.context?.sessionId,
		domain,
		metadata: options?.context?.metadata,
		approval: options?.context?.approval,
	};

	let gateHash: string | undefined;
	let decisionId: string | undefined;
	try {
		const gateResult = await evaluateGate({
			actionId: action.id,
			needsApproval: action.needsApproval,
			input: parsedInput,
			ctx,
		});
		gateHash = gateResult.inputSha256;
		decisionId = gateResult.decisionId;
	} catch (err) {
		const durationMs = Date.now() - startTime;
		if (isPendingApproval(err)) {
			const inputSha256 = err.inputSha256 ?? (await sha256Hex(canonicalInput));
			const record: ActionAuditRecord = {
				actionId: action.id,
				seam: "action",
				caller,
				requestId,
				parentRequestId,
				traceId,
				userId,
				clientId,
				sessionId,
				outcome: "pending_approval",
				durationMs,
				errorMessage: null,
				inputKeys,
				inputSha256,
				decisionId: err.decisionId,
			};
			await recordActionAudit(record, options?.auditSink);
			const approver = options?.inClientApproval;
			if (!approver) throw err;
			const answer = await approver.ask({ decisionId: err.decisionId, actionId: action.id, input: parsedInput, caller }).catch(() => "unanswered" as const);
			if (answer === "unanswered") throw err;
			const { actionResolver, executeApproved, rejectApproval } = await import("../approvals.js");
			const store = getActionApprovalStore() as ActionApprovalLifecycleStore;
			if (answer === "reject") {
				await rejectApproval(err.decisionId, { store, userId: userId ?? "", notes: `declined in client ${approver.clientId}` });
				const denied = new ApprovalDeniedError(action.id, `declined in client ${approver.clientId}; nothing ran — do not retry unless the owner asks`, inputSha256, err.decisionId);
				await recordActionAudit({ ...record, outcome: "denied", durationMs: Date.now() - startTime, errorMessage: denied.message.slice(0, 500) }, options?.auditSink);
				throw denied;
			}
			const out = await executeApproved(err.decisionId, {
				store,
				resolve: actionResolver((id) => (id === action.id ? action : undefined), { auditSink: options?.auditSink }),
				approvedBy: { userId: userId ?? "", via: "client", clientId: approver.clientId },
			});
			if (out.status === "failed") throw new Error(out.error);
			return out.result as TOutput;
		}
		const rawMsg = err instanceof Error ? err.message : String(err);
		const errorMessage = rawMsg ? rawMsg.slice(0, 500) : null;
		const isDenied = err instanceof ApprovalDeniedError;
		const inputSha256 =
			(isDenied ? err.inputSha256 : undefined) ?? (await sha256Hex(canonicalInput));
		const deniedDecisionId = isDenied ? err.decisionId : undefined;
		const record: ActionAuditRecord = {
			actionId: action.id,
			seam: "action",
			caller,
			requestId,
			parentRequestId,
			traceId,
			userId,
			clientId,
			sessionId,
			outcome: isDenied ? "denied" : "error",
			durationMs,
			errorMessage,
			inputKeys,
			inputSha256,
			...(deniedDecisionId !== undefined ? { decisionId: deniedDecisionId } : {}),
		};
		await recordActionAudit(record, options?.auditSink);
		throw err;
	}

	try {
		const result = await scope.run(ctx, () => action.run(parsedInput, ctx));
		const durationMs = Date.now() - startTime;
		const inputSha256 = gateHash ?? (await sha256Hex(canonicalInput));
		const record: ActionAuditRecord = {
			actionId: action.id,
			seam: "action",
			caller,
			requestId,
			parentRequestId,
			traceId,
			userId,
			clientId,
			sessionId,
			outcome: "success",
			durationMs,
			errorMessage: null,
			inputKeys,
			inputSha256,
			...(decisionId !== undefined ? { decisionId } : {}),
		};
		await recordActionAudit(record, options?.auditSink);
		return result;
	} catch (err) {
		const durationMs = Date.now() - startTime;
		const rawMsg = err instanceof Error ? err.message : String(err);
		const errorMessage = rawMsg ? rawMsg.slice(0, 500) : null;
		const inputSha256 = gateHash ?? (await sha256Hex(canonicalInput));
		const record: ActionAuditRecord = {
			actionId: action.id,
			seam: "action",
			caller,
			requestId,
			parentRequestId,
			traceId,
			userId,
			clientId,
			sessionId,
			outcome: "error",
			durationMs,
			errorMessage,
			inputKeys,
			inputSha256,
			...(decisionId !== undefined ? { decisionId } : {}),
		};
		await recordActionAudit(record, options?.auditSink);
		throw err;
	}
}
