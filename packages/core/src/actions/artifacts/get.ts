import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	DEFAULT_CAPTURE_PREFERENCES,
	resolveSynthesisRole as defaultResolveSynthesisRole,
	resolveTrust as defaultResolveTrust,
	type CapturePreferences,
} from "../../domain/capturePreferences.js";
import type { ArtifactRepository, ArtifactRow } from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { ExternalLinkRepository } from "../../ports/externalLinks.js";
import { pointerDetailLines } from "./documentPointer.js";

export const getArtifactInput = {
	id: z.string().uuid().describe("Artifact id returned by capture or search."),
} as const;

export const getArtifactSchema = z.object(getArtifactInput);
export type ArtifactGetInput = z.input<typeof getArtifactSchema>;

export type ArtifactGetResult =
	| { found: false; text: string }
	| { found: true; artifact: ArtifactRow; text: string };

export interface ArtifactGetPorts {
	artifacts: Pick<ArtifactRepository, "getById" | "getLinkedEntities">;
	externalLinks: Pick<ExternalLinkRepository, "getExternalLinks">;
	config: Pick<ConfigRepository, "loadCapturePreferences">;
	resolveTrust?: typeof defaultResolveTrust;
	resolveSynthesisRole?: typeof defaultResolveSynthesisRole;
}

/**
 * Fetch an artifact plus its linked entities/derived-links/provenance and render the same
 * text block artifact_get has always returned. Factored out (#588, #1511) so artifact_get_file
 * can compose on top of it — one query, one text format — instead of duplicating this.
 * Returns `found: false` with the exact "No artifact <id>." text artifact_get has always
 * used for a missing/foreign-owned id, so both tools' not-found shape stays identical.
 */
export async function loadArtifactFromPorts(
	id: string,
	ports: ArtifactGetPorts,
): Promise<ArtifactGetResult> {
	const artifact = await ports.artifacts.getById(id);
	if (!artifact) {
		return { found: false, text: `No artifact ${id}.` };
	}

	const linkedEntities = await ports.artifacts.getLinkedEntities(id);
	const entities = linkedEntities
		.map((e) => `${e.title} (${e.entity_type})`)
		.join(", ");

	const externalLinks = await ports.externalLinks.getExternalLinks(id);
	const derived = externalLinks
		.map(
			(l) =>
				`${l.kind}@${l.provider} → ${l.external_url || l.external_id}`,
		)
		.join(", ");

	const rawPrefs = ports.config.loadCapturePreferences
		? await ports.config.loadCapturePreferences()
		: DEFAULT_CAPTURE_PREFERENCES;
	const prefs: CapturePreferences = {
		...DEFAULT_CAPTURE_PREFERENCES,
		...rawPrefs,
	};
	const computeTrust = ports.resolveTrust ?? defaultResolveTrust;
	const computeRole = ports.resolveSynthesisRole ?? defaultResolveSynthesisRole;

	const trust = computeTrust(prefs, {
		surface: artifact.surface,
		source_channel: artifact.source_channel,
		trust_override: artifact.trust_override,
	});
	const role = computeRole(prefs, {
		surface: artifact.surface,
		source_channel: artifact.source_channel,
		title: artifact.title,
		plain_text: artifact.plain_text,
		description: artifact.description,
		tags: artifact.tags,
	});
	const provenance =
		`Provenance: channel=${artifact.source_channel ?? "?"}` +
		` surface=${artifact.surface ?? "?"}` +
		` trust=${trust}${artifact.trust_override ? " (override)" : ""}` +
		` role=${role}`;

	const pointerLines =
		artifact.storage_bucket === "external" ? pointerDetailLines(artifact) : [];

	const text = [
		`Artifact ${artifact.id}`,
		`Title: ${artifact.title ?? "(untitled)"}`,
		artifact.description ? `Description: ${artifact.description}` : null,
		`Stage: ${artifact.lifecycle_stage ?? "?"}  Source: ${artifact.source_url ?? artifact.source ?? "?"}`,
		provenance,
		...pointerLines,
		artifact.source_drive_file_id ? `Drive file: ${artifact.source_drive_file_id}` : null,
		artifact.source_parent_folder_path || artifact.source_parent_folder_ids?.length
			? `Drive parent folders: ${artifact.source_parent_folder_path ?? "(unknown)"}${artifact.source_parent_folder_ids?.length ? ` [${artifact.source_parent_folder_ids.join(", ")}]` : ""}`
			: null,
		artifact.routing_decision
			? `Routing: ${artifact.routing_decision}${artifact.routing_confidence !== null && artifact.routing_confidence !== undefined ? ` (${artifact.routing_confidence})` : ""}${artifact.routing_reason ? ` — ${artifact.routing_reason}` : ""}`
			: null,
		artifact.drive_action
			? `Drive action: ${artifact.drive_action}${artifact.drive_action_at ? ` @ ${artifact.drive_action_at}` : ""}`
			: null,
		artifact.tags?.length ? `Tags: ${artifact.tags.join(", ")}` : null,
		entities ? `Entities: ${entities}` : null,
		derived ? `Derived: ${derived}` : null,
		"",
		artifact.plain_text ?? "(no text content)",
	]
		.filter((l) => l !== null)
		.join("\n");

	return { found: true, artifact, text };
}

export function createArtifactGetAction(
	ports: ArtifactGetPorts,
): ActionDefinition<typeof getArtifactSchema, ArtifactGetResult> {
	return defineAction({
		id: "artifact_get",
		domain: "artifacts",
		description:
			"Fetch a single artifact's full content and its linked PARAMPS entities by id. For a discovered " +
			"pointer it also prints the link, connector, external id, owner, content hash with its kind " +
			"(md5 or modified_time) and the modified-at-source time.",
		schema: getArtifactSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args) => loadArtifactFromPorts(args.id, ports),
		formatMcp: (output) => output.text,
	});
}
