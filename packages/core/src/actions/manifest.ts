import { z } from "zod";
import type { ActionDefinition, ActionDomain, ActionExposure, FormerId } from "./types.js";
import { EXPOSURE_OPT_OUT_REASONS } from "./types.js";
import { exposureOf } from "./exposure.js";
import type { ActionRegistry } from "./registry.js";

export interface ActionManifestEntry {
	description: string;
	domain: ActionDomain | null;
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
	expose: ActionExposure;
	input_schema: Record<string, unknown>;
	former_ids: FormerId[];
}

export interface ActionManifest {
	version: 1;
	actions: Record<string, ActionManifestEntry>;
}

const ACTION_ID_REGEX = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Validates action IDs, former IDs, date formats, and expiry windows (ADR-105 R10, R11).
 */
export function checkFormerIds(manifest: ActionManifest, nowInput?: string | Date): void {
	const nowDateStr =
		nowInput instanceof Date
			? nowInput.toISOString().slice(0, 10)
			: typeof nowInput === "string"
				? nowInput
				: new Date().toISOString().slice(0, 10);

	const liveIds = new Set(Object.keys(manifest.actions));
	const seenFormerIds = new Map<string, string>();

	for (const [actionId, entry] of Object.entries(manifest.actions)) {
		if (!ACTION_ID_REGEX.test(actionId)) {
			throw new Error(`Action id "${actionId}" is not snake_case (must match ^[a-z][a-z0-9]*(_[a-z0-9]+)*$)`);
		}

		for (const former of entry.former_ids || []) {
			if (!former || typeof former !== "object") {
				throw new Error(`Action "${actionId}" former_id entry must be an object with id and until`);
			}
			if (typeof former.id !== "string" || !ACTION_ID_REGEX.test(former.id)) {
				throw new Error(
					`Action "${actionId}" former id "${former.id}" is not snake_case (must match ^[a-z][a-z0-9]*(_[a-z0-9]+)*$)`,
				);
			}
			if (liveIds.has(former.id)) {
				throw new Error(`Former id "${former.id}" of "${actionId}" equals a live action id`);
			}
			if (seenFormerIds.has(former.id)) {
				throw new Error(
					`Former id "${former.id}" of "${actionId}" duplicates former id of "${seenFormerIds.get(former.id)}"`,
				);
			}
			seenFormerIds.set(former.id, actionId);

			if (typeof former.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(former.until) || isNaN(Date.parse(former.until))) {
				throw new Error(
					`Action "${actionId}" former id "${former.id}" until "${former.until}" is not an ISO date (YYYY-MM-DD)`,
				);
			}

			if (former.until < nowDateStr) {
				throw new Error(
					`remove former id ${former.id} of ${actionId}; its window closed on ${former.until}`,
				);
			}
		}
	}
}

/**
 * Validates manifest structural integrity, exposure reasons, and former IDs.
 */
export function validateActionManifest(manifest: ActionManifest, now?: string | Date): void {
	if (!manifest || manifest.version !== 1 || !manifest.actions || typeof manifest.actions !== "object") {
		throw new Error("Invalid manifest: must have version 1 and actions object");
	}

	checkFormerIds(manifest, now);

	for (const [actionId, entry] of Object.entries(manifest.actions)) {
		if (entry.expose?.reason !== undefined) {
			if (!EXPOSURE_OPT_OUT_REASONS.includes(entry.expose.reason as any)) {
				throw new Error(
					`Action "${actionId}" has invalid expose.reason "${entry.expose.reason}" (one of: ${EXPOSURE_OPT_OUT_REASONS.join(", ")})`,
				);
			}
			if (!entry.expose.note || typeof entry.expose.note !== "string" || entry.expose.note.trim().length === 0) {
				throw new Error(
					`Action "${actionId}" specifies expose.reason "${entry.expose.reason}" without a non-empty expose.note`,
				);
			}
		}
	}
}

/**
 * Builds the canonical ActionManifest data structure from an ActionRegistry (ADR-105 R2, R10).
 */
export function buildActionManifest(registry: ActionRegistry): ActionManifest {
	const actions: Record<string, ActionManifestEntry> = {};

	const sortedActions = registry.list().slice().sort((a, b) => a.id.localeCompare(b.id));

	for (const action of sortedActions) {
		const jsonSchema = z.toJSONSchema(action.schema, {
			target: "openapi-3.0",
			io: "input",
		}) as Record<string, unknown>;

		actions[action.id] = {
			description: action.description,
			domain: action.domain ?? null,
			annotations: {
				readOnlyHint: Boolean(action.annotations?.readOnlyHint),
				destructiveHint: Boolean(action.annotations?.destructiveHint),
				idempotentHint: Boolean(action.annotations?.idempotentHint),
				openWorldHint: Boolean(action.annotations?.openWorldHint),
			},
			expose: exposureOf(action),
			input_schema: jsonSchema,
			former_ids: action.formerIds ?? [],
		};
	}

	const manifest: ActionManifest = {
		version: 1,
		actions,
	};

	validateActionManifest(manifest);

	return manifest;
}

/**
 * Serialises an ActionManifest to single-line-per-action formatted JSON (ADR-105 R10).
 */
export function serialiseManifest(manifest: ActionManifest): string {
	validateActionManifest(manifest);

	const sortedIds = Object.keys(manifest.actions).sort();
	const lines = [
		'{"version":1,"actions":{',
		...sortedIds.map((id, index) => {
			const comma = index < sortedIds.length - 1 ? "," : "";
			return `"${id}":${JSON.stringify(manifest.actions[id])}${comma}`;
		}),
		"}}",
	];

	return lines.join("\n") + "\n";
}
