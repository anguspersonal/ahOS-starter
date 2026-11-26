import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
	executeAction,
	type ActionAuditSink,
	type ActionRegistry,
} from "@ahkms/core/actions";
import { getCurrentUserId } from "../identity.js";
import { serverRegistry } from "./serverRegistry.js";

export type CliResultOutcome =
	| "ok"
	| "invalid"
	| "denied"
	| "pending_approval"
	| "error";

export interface CliResultEnvelope {
	outcome: CliResultOutcome;
	actionId: string | null;
	requestId: string;
	data?: unknown;
	error?: string;
}

export interface RunActionCliDeps {
	registry?: ActionRegistry;
	getUserId?: () => string;
	auditSink?: ActionAuditSink;
	stdout?: (line: string) => void;
	requestId?: string;
}

function classifyErrorOutcome(err: unknown): CliResultOutcome {
	if (err instanceof ZodError) {
		return "invalid";
	}
	if (err && typeof err === "object" && "name" in err) {
		const name = String((err as { name?: unknown }).name);
		if (name === "ZodError") return "invalid";
		if (name === "ApprovalDeniedError") return "denied";
		if (name === "PendingApprovalError") return "pending_approval";
	}
	return "error";
}

/**
 * Execute a registered action from CLI arguments (`[id, jsonInput]`) via `executeAction`
 * with `caller: "cli"`, writing the JSON envelope to stdout and returning exit code
 * `0` on `"ok"` or `1` on any failure outcome (ADR-100, ADR-104).
 */
export async function runActionCli(
	argv: string[],
	deps: RunActionCliDeps = {},
): Promise<number> {
	const writeOut = deps.stdout ?? ((line: string) => console.log(line));
	const requestId = deps.requestId ?? randomUUID();
	const [actionId, rawJson = "{}"] = argv;

	if (!actionId || typeof actionId !== "string" || !actionId.trim()) {
		const payload: CliResultEnvelope = {
			outcome: "invalid",
			actionId: null,
			requestId,
			error: "Usage: npm run action -- <action_id> '<json>'",
		};
		writeOut(JSON.stringify(payload));
		return 1;
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(rawJson);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const payload: CliResultEnvelope = {
			outcome: "invalid",
			actionId,
			requestId,
			error: `Invalid JSON input: ${msg}`,
		};
		writeOut(JSON.stringify(payload));
		return 1;
	}

	const registry = deps.registry ?? serverRegistry();
	const action = registry.get(actionId);
	if (!action) {
		const payload: CliResultEnvelope = {
			outcome: "invalid",
			actionId,
			requestId,
			error: `Unknown action: ${actionId}`,
		};
		writeOut(JSON.stringify(payload));
		return 1;
	}

	const resolveUserId = deps.getUserId ?? getCurrentUserId;
	let userId: string;
	try {
		userId = resolveUserId();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const payload: CliResultEnvelope = {
			outcome: "error",
			actionId,
			requestId,
			error: msg,
		};
		writeOut(JSON.stringify(payload));
		return 1;
	}

	try {
		const data = await executeAction(action, parsedJson, {
			context: {
				userId,
				caller: "cli",
				requestId,
			},
			auditSink: deps.auditSink,
		});
		const payload: CliResultEnvelope = {
			outcome: "ok",
			actionId,
			requestId,
			data,
		};
		writeOut(JSON.stringify(payload));
		return 0;
	} catch (err) {
		const outcome = classifyErrorOutcome(err);
		const msg = err instanceof Error ? err.message : String(err);
		const payload: CliResultEnvelope = {
			outcome,
			actionId,
			requestId,
			error: msg,
		};
		writeOut(JSON.stringify(payload));
		return 1;
	}
}
