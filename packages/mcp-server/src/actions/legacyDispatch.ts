import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ApprovalDeniedError,
	canonicalJson,
	evaluateGate,
	getActionApprovalStore,
	getActionScope,
	isPendingApproval,
	recordActionAudit,
	sha256Hex,
	type ActionApprovalLifecycleStore,
	type ActionAuditRecord,
	type ActionContext,
	type NeedsApproval,
} from "@ahkms/core";
import {
	executeApproved,
	rejectApproval,
	type ApprovedRunContext,
	type CallableApprovedRunner,
} from "@ahkms/core/actions";
import { getCurrentUserId } from "../identity.js";
import { buildPendingApprovalResult, type McpToolHandlerExtra } from "./adapters/mcp.js";
import { createInClientApprover, type ElicitationServer } from "./inClientApproval.js";
import { defaultSessionTraceTracker } from "./sessionTrace.js";

export type LegacyToolHandler = (
	args: any,
	extra?: McpToolHandlerExtra,
) => Promise<any>;

export interface WrapLegacyHandlerOptions {
	needsApproval?: NeedsApproval;
	gate?: NeedsApproval;
	server?: ElicitationServer;
}

const LEGACY_APPROVAL_SYMBOL: unique symbol = Symbol("ahos.legacyApproval");

/**
 * Legacy `register()` names whose handlers already delegate through `toMcpTool(...)` / `executeAction`.
 * `makeRegistrar` skips wrapping these (and any alias sharing their handler) so one call writes one ledger row.
 */
export const ACTION_BACKED_LEGACY_TOOLS: ReadonlySet<string> = new Set([
	"entity_create",
	"entity_delete",
	"entity_get",
	"entity_query",
	"entity_update",
	"entity_upsert",
]);

function extractIsErrorText(result: unknown): string {
	if (!result || typeof result !== "object") return "legacy tool returned isError";
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const firstText = content.find(
			(item) => item && typeof item === "object" && (item as { type?: string }).type === "text" && typeof (item as { text?: unknown }).text === "string",
		) as { text: string } | undefined;
		if (firstText) return firstText.text;
	}
	return "legacy tool returned isError";
}

/**
 * Builds an approved-call runner around a gated legacy wrapper.
 * Passes `ctx.approval` on the module-private Symbol of a fresh `extra` object
 * and throws when the legacy tool returns `{ isError: true }`.
 */
export function createLegacyRunner(
	wrappedHandler: (args: unknown, extra?: McpToolHandlerExtra) => Promise<unknown>,
): CallableApprovedRunner {
	const run = async (input: unknown, ctx: ApprovedRunContext): Promise<unknown> => {
		const extra: McpToolHandlerExtra = {
			[LEGACY_APPROVAL_SYMBOL]: ctx.approval,
		};
		const result = await wrappedHandler(input, extra);
		if (
			result &&
			typeof result === "object" &&
			(result as { isError?: unknown }).isError === true
		) {
			throw new Error(extractIsErrorText(result));
		}
		return result;
	};
	return Object.assign(run, { run });
}

/**
 * Wraps a legacy `register()` MCP tool handler so every call writes one `action_ledger`
 * record (`seam: "legacy_tool"`, `caller: "mcp"`) through `recordActionAudit`, and
 * evaluates `needsApproval` through `evaluateGate` when provided.
 */
export function wrapLegacyHandler<T extends (...args: any[]) => any>(
	canonicalName: string,
	handler: T,
	options?: WrapLegacyHandlerOptions | NeedsApproval,
): T {
	const needsApproval: NeedsApproval | undefined =
		typeof options === "boolean" || typeof options === "function"
			? options
			: (options?.needsApproval ?? options?.gate);
	const server: ElicitationServer | undefined =
		options && typeof options === "object" ? options.server : undefined;

	const wrapped = async (args: unknown, extra?: McpToolHandlerExtra) => {
		const startTime = Date.now();
		const requestId = randomUUID();
		const inputKeys = args && typeof args === "object" ? Object.keys(args) : [];

		let canonicalInput: string | null = null;
		try {
			canonicalInput = canonicalJson(args);
		} catch {
			canonicalInput = null;
		}

		let userId: string | null = null;
		try {
			userId = getCurrentUserId() ?? null;
		} catch {
			userId = null;
		}

		const rawClientId = extra?.authInfo?.clientId;
		const clientId = rawClientId && rawClientId.length > 0 ? rawClientId : null;
		const rawSessionId = extra?.sessionId;
		const sessionId = rawSessionId && rawSessionId.length > 0 ? rawSessionId : null;

		const approval =
			extra && typeof extra === "object"
				? (extra as Record<symbol, ActionContext["approval"]>)[LEGACY_APPROVAL_SYMBOL]
				: undefined;

		const scope = getActionScope();
		let parentCtx: ActionContext | undefined;
		try {
			parentCtx = scope.current();
		} catch {
			parentCtx = undefined;
		}
		const sessionTrace =
			parentCtx === undefined
				? defaultSessionTraceTracker.resolve(
						requestId,
						{ sessionId, userId, clientId },
						startTime,
					)
				: null;
		const parentRequestId =
			parentCtx !== undefined
				? (parentCtx.requestId ?? null)
				: (sessionTrace?.parentRequestId ?? null);
		const traceId =
			parentCtx !== undefined
				? (parentCtx.traceId ?? parentCtx.requestId ?? requestId)
				: (sessionTrace?.traceId ?? requestId);

		const scopeCtx: ActionContext = {
			caller: "mcp",
			requestId,
			parentRequestId,
			traceId,
			userId: userId ?? undefined,
			clientId: clientId ?? undefined,
			sessionId: sessionId ?? undefined,
			...(approval !== undefined ? { approval } : {}),
		};

		let gateHash: string | undefined;
		let decisionId: string | undefined;
		if (needsApproval !== undefined) {
			try {
				const gateResult = await evaluateGate({
					actionId: canonicalName,
					needsApproval,
					input: args,
					ctx: scopeCtx,
				});
				gateHash = gateResult.inputSha256;
				decisionId = gateResult.decisionId;
			} catch (err) {
				const durationMs = Date.now() - startTime;
				const digest = canonicalInput !== null ? await sha256Hex(canonicalInput) : null;
				if (isPendingApproval(err)) {
					const inputSha256 = err.inputSha256 ?? digest;
					const record: ActionAuditRecord = {
						actionId: canonicalName,
						seam: "legacy_tool",
						caller: "mcp",
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
					await recordActionAudit(record);

					const approver = createInClientApprover(server, extra);
					if (!approver) {
						return buildPendingApprovalResult(err.decisionId, canonicalName);
					}
					const answer = await approver
						.ask({
							decisionId: err.decisionId,
							actionId: canonicalName,
							input: args,
							caller: "mcp",
						})
						.catch(() => "unanswered" as const);
					if (answer === "unanswered") {
						return buildPendingApprovalResult(err.decisionId, canonicalName);
					}
					const store = getActionApprovalStore() as ActionApprovalLifecycleStore;
					if (answer === "reject") {
						await rejectApproval(err.decisionId, {
							store,
							userId: userId ?? "",
							notes: `declined in client ${approver.clientId}`,
						});
						const denied = new ApprovalDeniedError(
							canonicalName,
							`declined in client ${approver.clientId}; nothing ran — do not retry unless the owner asks`,
							inputSha256 ?? undefined,
							err.decisionId,
						);
						await recordActionAudit({
							...record,
							outcome: "denied",
							durationMs: Date.now() - startTime,
							errorMessage: denied.message.slice(0, 500),
						});
						return {
							isError: true,
							content: [{ type: "text", text: denied.message }],
						};
					}
					const runner = createLegacyRunner(wrapped);
					const out = await executeApproved(err.decisionId, {
						store,
						resolve: (id) => (id === canonicalName ? runner : undefined),
						approvedBy: {
							userId: userId ?? "",
							via: "client",
							clientId: approver.clientId,
						},
					});
					if (out.status === "failed") {
						return {
							isError: true,
							content: [{ type: "text", text: out.error }],
						};
					}
					return out.result;
				}

				if (err instanceof ApprovalDeniedError) {
					const errorMessage = err.message ? err.message.slice(0, 500) : null;
					const record: ActionAuditRecord = {
						actionId: canonicalName,
						seam: "legacy_tool",
						caller: "mcp",
						requestId,
						parentRequestId,
						traceId,
						userId,
						clientId,
						sessionId,
						outcome: "denied",
						durationMs,
						errorMessage,
						inputKeys,
						inputSha256: err.inputSha256 ?? digest,
						...(err.decisionId !== undefined ? { decisionId: err.decisionId } : {}),
					};
					await recordActionAudit(record);
					return {
						isError: true,
						content: [{ type: "text", text: err.message }],
					};
				}

				const rawMsg = err instanceof Error ? err.message : String(err);
				const errorMessage = rawMsg ? rawMsg.slice(0, 500) : null;
				const record: ActionAuditRecord = {
					actionId: canonicalName,
					seam: "legacy_tool",
					caller: "mcp",
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
					inputSha256: digest,
				};
				await recordActionAudit(record);
				throw err;
			}
		}

		const handlerExtra =
			approval !== undefined && extra && typeof extra === "object"
				? (() => {
						const copy = { ...extra };
						delete (copy as Record<symbol, unknown>)[LEGACY_APPROVAL_SYMBOL];
						return copy;
					})()
				: extra;

		try {
			const result = await scope.run(scopeCtx, () => handler(args, handlerExtra));
			const durationMs = Date.now() - startTime;
			const isErr = Boolean(
				result && typeof result === "object" && (result as { isError?: unknown }).isError === true,
			);
			const errorMessage = isErr ? extractIsErrorText(result).slice(0, 500) : null;
			const digest = gateHash ?? (canonicalInput !== null ? await sha256Hex(canonicalInput) : null);

			const record: ActionAuditRecord = {
				actionId: canonicalName,
				seam: "legacy_tool",
				caller: "mcp",
				requestId,
				parentRequestId,
				traceId,
				userId,
				clientId,
				sessionId,
				outcome: isErr ? "error" : "success",
				durationMs,
				errorMessage,
				inputKeys,
				inputSha256: digest,
				...(decisionId !== undefined ? { decisionId } : {}),
			};
			await recordActionAudit(record);
			return result;
		} catch (err) {
			const durationMs = Date.now() - startTime;
			const rawMsg = err instanceof Error ? err.message : String(err);
			const errorMessage = rawMsg ? rawMsg.slice(0, 500) : null;
			const digest = gateHash ?? (canonicalInput !== null ? await sha256Hex(canonicalInput) : null);

			const record: ActionAuditRecord = {
				actionId: canonicalName,
				seam: "legacy_tool",
				caller: "mcp",
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
				inputSha256: digest,
				...(decisionId !== undefined ? { decisionId } : {}),
			};
			await recordActionAudit(record);
			throw err;
		}
	};

	return wrapped as unknown as T;
}

type LegacyToolsRegistrar = (
	server: McpServer,
) => Map<string, { actionId: string; seam: string }>;

let legacyToolsRegistrar: LegacyToolsRegistrar | null = null;
let registeredServerRegistryGetter: (() => import("@ahkms/core").ActionRegistry) | null = null;
let legacyDispatchers: Map<string, LegacyToolHandler> | null = null;
const pendingDispatcherOverrides = new Map<string, LegacyToolHandler>();
let isBuildingLegacyDispatchers = false;

export function setLegacyToolsRegistrar(
	registrar: LegacyToolsRegistrar,
	getRegistry?: () => import("@ahkms/core").ActionRegistry,
): void {
	legacyToolsRegistrar = registrar;
	if (getRegistry) {
		registeredServerRegistryGetter = getRegistry;
	}
}

export function getRegisteredServerRegistry(): import("@ahkms/core").ActionRegistry | undefined {
	return registeredServerRegistryGetter?.();
}

export function recordLegacyDispatcher(
	canonicalName: string,
	wrappedHandler: LegacyToolHandler,
): void {
	if (isBuildingLegacyDispatchers) return;
	if (legacyDispatchers) {
		if (legacyDispatchers.has(canonicalName)) {
			legacyDispatchers.set(canonicalName, wrappedHandler);
		}
	} else {
		pendingDispatcherOverrides.set(canonicalName, wrappedHandler);
	}
}

/**
 * Lazily builds (once per process) a map from canonical legacy tool name to its
 * gated wrapper, without holding any session's low-level server.
 */
export function ensureLegacyDispatchers(): ReadonlyMap<string, LegacyToolHandler> {
	if (legacyDispatchers) {
		return legacyDispatchers;
	}
	if (!legacyToolsRegistrar) {
		return new Map();
	}
	const captured = new Map<string, LegacyToolHandler>();
	const stub = {
		registerTool(name: string, _config: unknown, handler: LegacyToolHandler) {
			captured.set(name, handler);
		},
	};
	isBuildingLegacyDispatchers = true;
	let registered: Map<string, { actionId: string; seam: string }>;
	try {
		registered = legacyToolsRegistrar(stub as unknown as McpServer);
	} finally {
		isBuildingLegacyDispatchers = false;
	}
	const map = new Map<string, LegacyToolHandler>();
	for (const [name, entry] of registered.entries()) {
		if (entry.seam === "legacy_tool" && entry.actionId === name) {
			const wrapped = captured.get(name);
			if (wrapped) {
				map.set(name, wrapped);
			}
		}
	}
	for (const [name, wrapper] of pendingDispatcherOverrides.entries()) {
		if (map.has(name)) {
			map.set(name, wrapper);
		}
	}
	pendingDispatcherOverrides.clear();
	legacyDispatchers = map;
	return legacyDispatchers;
}
