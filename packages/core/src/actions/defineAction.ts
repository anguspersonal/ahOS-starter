import type { z } from "zod";
import type {
	ActionContext,
	ActionDefinition,
	DefineActionOptions,
} from "./types.js";
import { normaliseExposure } from "./exposure.js";

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
 * Helper to construct a standard ActionContext with sensible defaults.
 */
export function createActionContext(
	overrides?: Partial<ActionContext>,
): ActionContext {
	return {
		caller: overrides?.caller ?? "test",
		requestId: overrides?.requestId ?? getIsomorphicUUID(),
		domain: overrides?.domain,
		userId: overrides?.userId,
		metadata: overrides?.metadata,
	};
}

/**
 * Factory to define a typed application action (ADR-100).
 *
 * Enforces validation, establishes single-source-of-truth action contracts,
 * and enables multi-surface execution across MCP tools, HTTP routes, and UI clients.
 */
export function defineAction<
	TInputSchema extends z.ZodTypeAny,
	TOutput,
>(
	options: DefineActionOptions<TInputSchema, TOutput>,
): ActionDefinition<TInputSchema, TOutput> {
	if (!options.id || typeof options.id !== "string") {
		throw new Error("Action id must be a non-empty string");
	}
	if (!options.description || typeof options.description !== "string") {
		throw new Error(`Action "${options.id}" description must be a non-empty string`);
	}
	if (!options.schema) {
		throw new Error(`Action "${options.id}" requires an input schema`);
	}
	if (typeof options.run !== "function") {
		throw new Error(`Action "${options.id}" requires an async run function`);
	}

	if (options.formerIds !== undefined) {
		if (!Array.isArray(options.formerIds)) {
			throw new Error(`Action "${options.id}" formerIds must be an array`);
		}
		const seen = new Set<string>();
		const ACTION_ID_REGEX = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
		for (const f of options.formerIds) {
			if (!f || typeof f !== "object") {
				throw new Error(`Action "${options.id}" formerId entry must be an object with id and until`);
			}
			if (typeof f.id !== "string" || !ACTION_ID_REGEX.test(f.id)) {
				throw new Error(
					`Action "${options.id}" former id "${f?.id}" must be snake_case (matching ^[a-z][a-z0-9]*(_[a-z0-9]+)*$)`,
				);
			}
			if (f.id === options.id) {
				throw new Error(
					`Action "${options.id}" former id "${f.id}" cannot equal its live id`,
				);
			}
			if (seen.has(f.id)) {
				throw new Error(
					`Action "${options.id}" has duplicate former id "${f.id}"`,
				);
			}
			seen.add(f.id);
			if (typeof f.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f.until) || isNaN(Date.parse(f.until))) {
				throw new Error(
					`Action "${options.id}" former id "${f.id}" has invalid until date "${f.until}": must be an ISO date (YYYY-MM-DD)`,
				);
			}
		}
	}

	const expose = normaliseExposure(options.id, options.expose);

	return {
		id: options.id,
		name: options.name ?? options.id,
		description: options.description,
		domain: options.domain,
		schema: options.schema,
		outputSchema: options.outputSchema,
		annotations: {
			readOnlyHint: options.annotations?.readOnlyHint ?? false,
			destructiveHint: options.annotations?.destructiveHint ?? false,
			idempotentHint: options.annotations?.idempotentHint ?? false,
			openWorldHint: options.annotations?.openWorldHint ?? false,
		},
		expose,
		formerIds: options.formerIds,
		needsApproval: options.needsApproval,
		run: options.run,
		formatMcp: options.formatMcp,
		mcpStructured: options.mcpStructured,
	};
}
