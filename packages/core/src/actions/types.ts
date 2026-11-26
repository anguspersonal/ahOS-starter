import { z } from "zod";

export const REVIEW_BAND_BLOCK_THRESHOLD = 0.3;
export const REVIEW_BAND_AUTO_APPLY_THRESHOLD = 0.85;

export const actionConfidenceSchema = z
	.object({
		epistemic: z
			.number()
			.min(0)
			.max(1)
			.describe(
				"Epistemic truth/identity confidence (0.0-1.0). Calls in [0.30, 0.85) are parked for review; calls < 0.30 are blocked.",
			),
		ego_salience: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe("Optional node-worthiness score (0.0-1.0)."),
	})
	.optional()
	.describe(
		"Optional dual-axis confidence score (ADR-104). Calls with epistemic in [0.30, 0.85) are parked as action_approval decisions; calls < 0.30 are refused.",
	);

export type ActionConfidence = z.infer<typeof actionConfidenceSchema>;

/**
 * Caller surface executing the action.
 */
export type ActionCaller = "mcp" | "http" | "ui" | "ui_agent" | "worker" | "cli" | "test" | "a2a" | "internal";

/**
 * Invocation surfaces supported by the action registry (ADR-105 R3).
 */
export const ACTION_SURFACES = [
	"mcp",
	"http",
	"ui_agent",
	"worker",
	"cli",
	"a2a",
] as const;

export type ActionSurface = (typeof ACTION_SURFACES)[number];

/**
 * Closed list of reasons permitted when turning off a default-on surface (ADR-105 R4).
 */
export const EXPOSURE_OPT_OUT_REASONS = [
	"client_local",
	"owner_only",
	"app_internal",
	"legacy_twin",
	"owner_decision_pending",
] as const;

export type ExposureOptOutReason = (typeof EXPOSURE_OPT_OUT_REASONS)[number];

/**
 * Normalised exposure state across all action invocation surfaces.
 */
export interface ActionExposure {
	mcp: boolean;
	http: boolean;
	ui_agent: boolean;
	worker: boolean;
	cli: boolean;
	a2a: boolean;
	reason?: ExposureOptOutReason;
	note?: string;
}

/**
 * Options for configuring action exposure during defineAction.
 */
export interface ActionExposureInput {
	mcp?: boolean;
	http?: boolean;
	ui_agent?: boolean;
	worker?: boolean;
	cli?: boolean;
	a2a?: boolean;
	reason?: ExposureOptOutReason;
	note?: string;
}

/**
 * Functional domains in the Centralised Action Registry (CAR).
 */
export type ActionDomain =
	| "kg"
	| "artifacts"
	| "para"
	| "iam"
	| "chat"
	| "governance"
	| "workflows"
	| "integrations"
	| "ops"
	| "billing";

/**
 * Execution context provided to every action run handler (ADR-100).
 * Encapsulates identity, domain routing, and request tracing.
 */
export interface ActionContext {
	/** Authenticated user ID if present */
	userId?: string;
	/** Client ID (e.g. MCP client identifier) */
	clientId?: string;
	/** Session ID (e.g. MCP session identifier) */
	sessionId?: string;
	/** Domain routing discriminator: 'work' (Work) or 'angus' (personal) */
	domain?: "work" | "angus";
	/** Which surface triggered this invocation */
	caller: ActionCaller;
	/** Unique request correlation/trace ID */
	requestId: string;
	/** Parent action request ID when invoked inside another action's run */
	parentRequestId?: string | null;
	/** End-to-end trace ID inherited across nested action invocations */
	traceId?: string | null;
	/** Optional request metadata or caller headers */
	metadata?: Record<string, unknown>;
	/**
	 * Pre-authorized approval token for re-entering a gated action.
	 * Set only by in-process code, never from a request field or an input.
	 */
	approval?: {
		decisionId: string;
		actionId: string;
		inputSha256: string;
	};
}

/**
 * Approval policy for an action: either a static boolean or a predicate over parsed input and context.
 */
export type NeedsApproval<I = any> =
	| boolean
	| ((input: I, ctx: ActionContext) => boolean | Promise<boolean>);

/**
 * Behavioral annotations and hints for model planners and MCP wrappers.
 */
export interface ActionAnnotations {
	/** True if the action only reads and performs zero mutations */
	readOnlyHint?: boolean;
	/** True if the action performs irreversible mutations (deletions, destructive overwrites) */
	destructiveHint?: boolean;
	/** True if calling repeatedly with identical input yields identical side-effects */
	idempotentHint?: boolean;
	/** True if the action interacts with external third-party services (Gmail, Notion, Slack) */
	openWorldHint?: boolean;
}

/**
 * Deprecated alias preserved for an action until a specified date (ADR-105 R11).
 */
export interface FormerId {
	id: string;
	until: string;
}

/**
 * The core contract defining an application capability.
 * Separates pure domain execution from protocol-level serialization.
 */
export interface ActionDefinition<
	TInputSchema = any,
	TOutput = unknown,
> {
	/** Unique machine identifier (e.g. 'docs_get', 'capture', 'task_create') */
	id: string;
	/** Human-readable canonical name (defaults to id) */
	name: string;
	/** Clear description explaining behavior, preconditions, and constraints to agents and humans */
	description: string;
	/** CAR domain grouping */
	domain?: ActionDomain;
	/** Input validation schema */
	schema: TInputSchema;
	/** Optional output validation schema */
	outputSchema?: any;
	/** Behavioral annotations */
	annotations: ActionAnnotations;
	/** Exposure configuration across invocation surfaces (ADR-105) */
	expose?: ActionExposure;
	/** Deprecated former identifiers preserved until their specified expiry dates */
	formerIds?: FormerId[];
	/** Optional approval gate policy */
	needsApproval?: NeedsApproval<any>;
	/** Pure domain execution function returning structured typed output */
	run: (input: any, ctx: ActionContext) => Promise<TOutput>;
	/** Optional custom MCP text formatter. When omitted, JSON.stringify is used. */
	formatMcp?: (result: TOutput) => string;
	/** Optional hook to derive MCP structuredContent; returning undefined omits it. */
	mcpStructured?: (result: TOutput) => Record<string, unknown> | undefined;
}

/**
 * Configuration options passed to defineAction factory.
 */
export interface DefineActionOptions<
	TInputSchema = any,
	TOutput = unknown,
> {
	id: string;
	name?: string;
	description: string;
	domain?: ActionDomain;
	schema: TInputSchema;
	outputSchema?: any;
	annotations?: ActionAnnotations;
	/** Exposure configuration across invocation surfaces (ADR-105) */
	expose?: ActionExposureInput;
	/** Deprecated former identifiers preserved until their specified expiry dates */
	formerIds?: FormerId[];
	/** Optional approval gate policy */
	needsApproval?: NeedsApproval<any>;
	run: (input: any, ctx: ActionContext) => Promise<TOutput>;
	/** Optional custom MCP text formatter. When omitted, JSON.stringify is used. */
	formatMcp?: (result: TOutput) => string;
	/** Optional hook to derive MCP structuredContent; returning undefined omits it. */
	mcpStructured?: (result: TOutput) => Record<string, unknown> | undefined;
}

/**
 * Audit outcomes supported by the action ledger and audit sink.
 */
export const ACTION_AUDIT_OUTCOMES = [
	"success",
	"error",
	"validation_error",
	"denied",
	"pending_approval",
] as const;

export type ActionAuditOutcome = (typeof ACTION_AUDIT_OUTCOMES)[number];

export type ActionAuditSeam = "action" | "legacy_tool" | "client_local";

/**
 * Structured audit record emitted for every action execution attempt (ADR-104 L1, L2, L10).
 */
export interface ActionAuditRecord {
	actionId: string;
	seam: ActionAuditSeam;
	caller: string | null;
	requestId: string | null;
	parentRequestId?: string | null;
	traceId?: string | null;
	userId: string | null;
	clientId: string | null;
	sessionId: string | null;
	outcome: ActionAuditOutcome;
	durationMs: number;
	errorMessage: string | null;
	inputKeys: string[];
	inputSha256: string | null;
	decisionId?: string;
}

/**
 * Sink interface for recording action execution audit events.
 */
export type ActionAuditSink = (record: ActionAuditRecord) => void | Promise<void>;
