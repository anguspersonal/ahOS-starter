import { z } from "zod";
import { recordActionAudit } from "../adapters/direct.js";
import { defineAction } from "../defineAction.js";
import { getActionScope } from "../scope.js";
import type {
	ActionAuditSink,
	ActionContext,
	ActionDefinition,
} from "../types.js";
import { graphFilterAction } from "../ui/graphFilter.js";
import { viewScreenAction } from "../ui/viewScreen.js";

export const CLIENT_ACTION_RECORD_OUTCOMES = [
	"success",
	"error",
	"validation_error",
] as const;

export type ClientActionRecordOutcome =
	(typeof CLIENT_ACTION_RECORD_OUTCOMES)[number];

export const clientActionRecordItemSchema = z
	.object({
		action_id: z.string().min(1).describe("The client_local manifest action_id that executed in the browser."),
		request_id: z.string().uuid().describe("Client-generated UUID for the local execution."),
		trace_id: z.string().min(1).optional().describe("Optional end-to-end trace_id for the chat turn."),
		outcome: z.enum(CLIENT_ACTION_RECORD_OUTCOMES).describe("Outcome of the local action execution."),
		duration_ms: z.number().int().nonnegative().describe("Execution duration in milliseconds."),
		input_keys: z.array(z.string()).describe("Sorted top-level keys of the action input (values never leave the browser)."),
		input_sha256: z.string().min(1).describe("Lowercase hex SHA-256 of the canonical JSON input."),
	})
	.strict();

export const clientActionRecordEntrySchema = clientActionRecordItemSchema;

export const clientActionRecordSchema = z
	.object({
		records: z
			.array(clientActionRecordItemSchema)
			.min(1)
			.max(50)
			.describe("Batch of 1 to 50 client-local action execution records."),
	})
	.strict();

export type ClientActionRecordItem = z.infer<typeof clientActionRecordItemSchema>;
export type ClientActionRecordInput = z.infer<typeof clientActionRecordSchema>;

export interface ClientActionRecordOutput {
	recorded: number;
}

export const DEFAULT_CLIENT_LOCAL_ACTION_IDS: ReadonlySet<string> = new Set(
	[graphFilterAction, viewScreenAction]
		.filter((action) => action.expose?.reason === "client_local")
		.map((action) => action.id),
);

export interface ClientActionRecordDeps {
	auditSink?: ActionAuditSink;
	isClientLocalAction?: (actionId: string) => boolean;
	clientLocalActionIds?: ReadonlySet<string> | Iterable<string>;
}

const CLIENT_ACTION_RECORD_EXPOSE = {
	mcp: false,
	http: true,
	ui_agent: false,
	worker: false,
	reason: "app_internal" as const,
	note: "Called by the web app's clientActionRecorder to batch client_local audit records (ADR-105 R9, #1558).",
};

export function createClientActionRecordAction(
	depsOrSink?: ClientActionRecordDeps | ActionAuditSink,
): ActionDefinition<typeof clientActionRecordSchema, ClientActionRecordOutput> {
	const deps: ClientActionRecordDeps =
		typeof depsOrSink === "function"
			? { auditSink: depsOrSink }
			: (depsOrSink ?? {});

	const allowedSet = deps.clientLocalActionIds
		? new Set(deps.clientLocalActionIds)
		: DEFAULT_CLIENT_LOCAL_ACTION_IDS;

	const isClientLocal =
		deps.isClientLocalAction ?? ((actionId: string) => allowedSet.has(actionId));

	return defineAction({
		id: "client_action_record",
		domain: "ops",
		description:
			"Record a batch of 1 to 50 client-local UI action runs reported by the browser in-app agent into the append-only action_ledger with seam client_local.",
		schema: clientActionRecordSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		expose: CLIENT_ACTION_RECORD_EXPOSE,
		run: async (
			input: ClientActionRecordInput,
			ctx: ActionContext,
		): Promise<ClientActionRecordOutput> => {
			if (ctx.caller !== "ui_agent") {
				throw Object.assign(
					new Error("client_action_record requires caller ui_agent"),
					{ status: 403 },
				);
			}

			for (const entry of input.records) {
				if (!isClientLocal(entry.action_id)) {
					throw Object.assign(
						new Error(
							`Action "${entry.action_id}" is not a client_local manifest action`,
						),
						{ status: 400 },
					);
				}
			}

			const scope = getActionScope().current();
			for (const entry of input.records) {
				await recordActionAudit(
					{
						actionId: entry.action_id,
						seam: "client_local",
						caller: "ui_agent",
						requestId: entry.request_id,
						parentRequestId: ctx.parentRequestId ?? scope?.parentRequestId ?? null,
						traceId: entry.trace_id ?? ctx.traceId ?? scope?.traceId ?? null,
						userId: ctx.userId ?? null,
						clientId: ctx.clientId ? ctx.clientId : null,
						sessionId: ctx.sessionId ? ctx.sessionId : null,
						outcome: entry.outcome,
						durationMs: entry.duration_ms,
						errorMessage: null,
						inputKeys: [...entry.input_keys],
						inputSha256: entry.input_sha256,
					},
					deps.auditSink,
				);
			}

			return { recorded: input.records.length };
		},
	});
}

export const clientActionRecordAction = createClientActionRecordAction();
