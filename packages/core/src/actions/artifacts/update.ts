import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type {
	ArtifactPatch,
	ArtifactPatchedRow,
	ArtifactRepository,
} from "../../ports/artifacts.js";

export const artifactPatchFields = {
	source_url: z.string().url().nullable().optional().describe("Canonical source URL for the artifact."),
	source_drive_file_id: z.string().nullable().optional().describe("Drive file id, when the artifact came from Google Drive."),
	source_parent_folder_ids: z.array(z.string()).nullable().optional().describe("Drive parent folder ids, when available."),
	source_parent_folder_path: z.string().nullable().optional().describe("Human-readable Drive folder path, when available."),
	routing_decision: z
		.enum(["keep_in_place", "move_to_better_folder", "move_to_archive", "delete", "manual_review"])
		.nullable()
		.optional()
		.describe("Semantic routing decision chosen by the agent."),
	routing_confidence: z.number().min(0).max(1).nullable().optional().describe("Routing confidence from 0 to 1."),
	routing_reason: z.string().nullable().optional().describe("Natural-language reason for the routing decision."),
	drive_action: z.enum(["none", "move", "trash", "delete"]).nullable().optional().describe("Drive action that was actually taken."),
	drive_action_at: z.string().datetime().nullable().optional().describe("Timestamp when the Drive action was taken."),
	title: z.string().nullable().optional().describe("Artifact title."),
	description: z.string().nullable().optional().describe("Artifact description."),
	plain_text: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Artifact body text (markdown / plain text). Updating this refreshes embeddings, and for text/markdown or text/plain artifacts stored in Supabase Storage also syncs the storage blob, file_size, and content_fingerprint (binary media files like PDFs/images are left untouched).",
		),
	tags: z.array(z.string()).nullable().optional().describe("Artifact tags."),
	processing_status: z.string().nullable().optional().describe("Processing status."),
	lifecycle_stage: z.string().nullable().optional().describe("Lifecycle stage."),
	processing_metadata: z.record(z.string(), z.unknown()).nullable().optional().describe("Processing metadata JSON."),
	archived: z
		.boolean()
		.nullable()
		.optional()
		.describe("Soft-archive flag. Set false to restore a soft-deleted artifact (clears the archive stamps); set true to archive."),
	archived_reason: z
		.string()
		.nullable()
		.optional()
		.describe("Reason recorded when archiving. Cleared automatically on restore (archived: false)."),
};

export const artifactUpdateInput = {
	id: z.string().uuid().describe("Artifact id to update."),
	patch: z
		.object(artifactPatchFields)
		.partial()
		.refine((value) => Object.keys(value).length > 0, "Provide at least one field to update."),
} as const;

export const artifactUpdateSchema = z.object(artifactUpdateInput);
export type ArtifactUpdateInput = z.infer<typeof artifactUpdateSchema>;

export type ArtifactUpdateResult = {
	updated: boolean;
	artifact?: ArtifactPatchedRow;
	text: string;
};

export type ArtifactUpdatePort =
	| Pick<ArtifactRepository, "patch">
	| { artifacts: Pick<ArtifactRepository, "patch"> };

function resolveRepo(port: ArtifactUpdatePort): Pick<ArtifactRepository, "patch"> {
	return "artifacts" in port ? port.artifacts : port;
}

export function createArtifactUpdateAction(
	port: ArtifactUpdatePort,
): ActionDefinition<typeof artifactUpdateSchema, ArtifactUpdateResult> {
	const repo = resolveRepo(port);
	return defineAction({
		id: "artifact_update",
		domain: "artifacts",
		description:
			"Update one artifact row by id, including routing audit fields and Drive provenance columns. " +
			"Also the restore path for a soft-deleted artifact: pass archived: false to un-archive it (clears archived_at/archived_reason).",
		schema: artifactUpdateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<ArtifactUpdateResult> => {
			const supplied = Object.keys(args.patch).filter(
				(k) => (args.patch as Record<string, unknown>)[k] !== undefined,
			);
			if (supplied.length === 0) {
				return {
					updated: false,
					text: "No fields supplied. Provide at least one artifact field to update.",
				};
			}

			// Normalize the archive stamps so archived is the single lever the caller sets:
			// restore (archived:false) clears the stamps; archive (archived:true) stamps the time
			// if the caller didn't supply one — keeping state consistent with artifact_delete's soft path.
			const patch: ArtifactPatch = { ...args.patch };
			if (patch.archived === false) {
				patch.archived_at = null;
				patch.archived_reason = patch.archived_reason ?? null;
			} else if (patch.archived === true) {
				patch.archived_at = patch.archived_at ?? new Date().toISOString();
			}

			const data = await repo.patch(args.id, patch);

			const archiveNote =
				args.patch.archived === false
					? "; restored (un-archived)"
					: args.patch.archived === true
						? "; archived"
						: "";

			return {
				updated: true,
				artifact: data,
				text: `Updated artifact ${data.id}${data.routing_decision ? ` (routing: ${data.routing_decision})` : ""}${data.drive_action ? `; drive action: ${data.drive_action}` : ""}${archiveNote}.`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
