import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type {
	ArtifactRepository,
	ArtifactSummaryRow,
} from "../../ports/artifacts.js";

export const artifactDeleteInput = {
	ids: z.array(z.string().uuid()).min(1).describe("Artifact ids to delete."),
	archive_only: z
		.boolean()
		.optional()
		.describe(
			"Soft-delete (archive) instead of a hard row delete. Defaults to true — the safe path. " +
				"Only pass false when a real, irreversible row delete is intended.",
		),
	archived_reason: z
		.string()
		.nullable()
		.optional()
		.describe("Optional human-readable reason recorded on archived_reason for the soft-delete path."),
} as const;

export const artifactDeleteSchema = z.object(artifactDeleteInput);
export type ArtifactDeleteInput = z.infer<typeof artifactDeleteSchema>;

export type ArtifactDeleteResult = {
	archive_only: boolean;
	mutated: ArtifactSummaryRow[];
	text: string;
};

export type ArtifactDeletePort =
	| Pick<ArtifactRepository, "mutateByIds">
	| { artifacts: Pick<ArtifactRepository, "mutateByIds"> };

function resolveRepo(port: ArtifactDeletePort): Pick<ArtifactRepository, "mutateByIds"> {
	return "artifacts" in port ? port.artifacts : port;
}

export function createArtifactDeleteAction(
	port: ArtifactDeletePort,
): ActionDefinition<typeof artifactDeleteSchema, ArtifactDeleteResult> {
	const repo = resolveRepo(port);
	return defineAction({
		id: "artifact_delete",
		domain: "artifacts",
		description:
			"Delete artifacts by id. Defaults to a reversible soft-delete that archives the row; search " +
			"already excludes archived rows, and artifact_update restores them. `archive_only: false` is an " +
			"irreversible hard delete that cascades to the artifact's entity and external links. Full notes: " +
			"docs/guides/tools/artifact_delete.md",
		schema: artifactDeleteSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args) => {
			const archiveOnly = args.archive_only ?? true;
			const mutated = await repo.mutateByIds(
				args.ids,
				archiveOnly,
				args.archived_reason,
			);
			const verb = archiveOnly ? "Archived" : "Deleted";
			const rowsText = mutated
				.map((row) => `[${row.id}] ${row.title ?? "(untitled)"}`)
				.join(", ");
			return {
				archive_only: archiveOnly,
				mutated,
				text: `${verb} ${mutated.length} artifact${mutated.length === 1 ? "" : "s"}${rowsText ? `: ${rowsText}` : ""}.`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
