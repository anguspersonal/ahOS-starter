import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
	executeAction,
	getActionScope,
	isPendingApproval,
	type ActionAuditSink,
	type ActionContext,
} from "@ahkms/core";
import type { ActionAnnotations, ActionDefinition } from "../types.js";
import { getCurrentUserId } from "../../identity.js";
import { createInClientApprover, type ElicitationServer } from "../inClientApproval.js";
import { defaultSessionTraceTracker } from "../sessionTrace.js";

export interface McpToolAdapterOptions {
	auditSink?: ActionAuditSink;
	server?: ElicitationServer;
}

export interface McpToolHandlerExtra {
	authInfo?: {
		clientId?: string;
		[key: string]: unknown;
	};
	sessionId?: string;
	requestId?: string | number;
	signal?: AbortSignal;
	[key: string]: unknown;
}

export interface McpToolAdapterConfig {
	description: string;
	inputSchema: any;
	annotations: Required<ActionAnnotations>;
}

export interface McpToolAdapterResult {
	name: string;
	config: McpToolAdapterConfig;
	handler: (
		args: unknown,
		extra?: McpToolHandlerExtra,
	) => Promise<{
		content: { type: "text"; text: string }[];
		structuredContent?: Record<string, unknown>;
	}>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function buildStructuredContent<TInputSchema, TOutput>(
	action: ActionDefinition<TInputSchema, TOutput>,
	result: TOutput,
): Record<string, unknown> | undefined {
	let raw: Record<string, unknown> | undefined;
	if (action.mcpStructured) {
		raw = action.mcpStructured(result);
		if (raw === undefined) {
			return undefined;
		}
	} else {
		if (typeof result === "string" || result === undefined) {
			return undefined;
		}
		raw = isPlainObject(result) ? result : { result };
	}

	try {
		const parsed = JSON.parse(JSON.stringify(raw));
		return isPlainObject(parsed) ? parsed : undefined;
	} catch (err) {
		console.warn(
			`[toMcpTool] Failed to serialize structuredContent for action "${action.id}": ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}

export function buildPendingApprovalResult(
	decisionId: string,
	actionId: string,
): {
	content: { type: "text"; text: string }[];
	structuredContent: {
		status: "pending_approval";
		decision_id: string;
		action_id: string;
	};
} {
	const structuredContent = {
		status: "pending_approval" as const,
		decision_id: decisionId,
		action_id: actionId,
	};
	const line1 = JSON.stringify(structuredContent);
	const line2 =
		"Parked for owner approval in the ahOS Approvals inbox; do not retry this call.";
	return {
		content: [{ type: "text", text: `${line1}\n${line2}` }],
		structuredContent,
	};
}

/**
 * Converts an ActionDefinition into an MCP tool configuration and handler (ADR-100).
 *
 * Handles context derivation, input schema forwarding, output serialization,
 * error propagation, and centralized audit logging via executeAction (ADR-104).
 */
export function toMcpTool<TInputSchema extends z.ZodTypeAny, TOutput>(
	action: ActionDefinition<TInputSchema, TOutput>,
	options?: McpToolAdapterOptions,
): McpToolAdapterResult {
	const annotations: Required<ActionAnnotations> = {
		readOnlyHint: action.annotations?.readOnlyHint ?? false,
		destructiveHint: action.annotations?.destructiveHint ?? false,
		idempotentHint: action.annotations?.idempotentHint ?? false,
		openWorldHint: action.annotations?.openWorldHint ?? false,
	};

	// Use shape if available, or fallback to the schema directly
	const inputSchema = (action.schema as { shape?: unknown }).shape ?? action.schema;

	const handler = async (
		args: unknown,
		extra?: McpToolHandlerExtra,
	): Promise<{
		content: { type: "text"; text: string }[];
		structuredContent?: Record<string, unknown>;
	}> => {
		let userId: string | undefined;
		try {
			userId = getCurrentUserId();
		} catch {
			// Environment might not have KMS_USER_ID in some test contexts
		}

		const domain =
			args && typeof args === "object" && "domain" in args
				? (args as { domain?: "work" | "angus" }).domain
				: undefined;

		const requestId = randomUUID();
		const clientId = extra?.authInfo?.clientId || undefined;
		const sessionId = extra?.sessionId || undefined;

		let parentCtx: ActionContext | undefined;
		try {
			parentCtx = getActionScope().current();
		} catch {
			parentCtx = undefined;
		}
		const sessionTrace =
			parentCtx === undefined
				? defaultSessionTraceTracker.resolve(requestId, {
						sessionId,
						userId,
						clientId,
					})
				: undefined;

		let result: TOutput;
		try {
			result = await executeAction(action, args as z.input<TInputSchema>, {
				skipValidation: true,
				auditSink: options?.auditSink,
				...(options?.server
					? { inClientApproval: createInClientApprover(options.server, extra) }
					: {}),
				context: {
					caller: "mcp",
					requestId,
					userId,
					domain,
					clientId,
					sessionId,
					...(sessionTrace
						? {
								traceId: sessionTrace.traceId,
								parentRequestId: sessionTrace.parentRequestId,
							}
						: {}),
				},
			});
		} catch (err) {
			if (isPendingApproval(err)) {
				return buildPendingApprovalResult(err.decisionId, err.actionId);
			}
			if (err instanceof Error) {
				Object.defineProperty(err, "message", {
					value: err.message + " [request_id=" + requestId + "]",
					writable: true,
					configurable: true,
				});
				throw err;
			}
			throw new Error(String(err) + " [request_id=" + requestId + "]");
		}

		const text = action.formatMcp
			? action.formatMcp(result)
			: typeof result === "string"
				? result
				: JSON.stringify(result, null, 2);

		const structuredContent = buildStructuredContent(action, result);
		return structuredContent !== undefined
			? { content: [{ type: "text", text }], structuredContent }
			: { content: [{ type: "text", text }] };
	};

	return {
		name: action.id,
		config: {
			description: action.description,
			inputSchema,
			annotations,
		},
		handler,
	};
}

