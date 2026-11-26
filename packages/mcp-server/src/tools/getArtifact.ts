import type { z } from "zod";
import {
	ARTIFACT_SELECT_COLUMNS,
	getArtifactInput,
	getArtifactSchema,
	loadArtifactFromPorts,
	type ArtifactGetResult,
	type ArtifactRow,
} from "@ahkms/core";
import {
	createSupabaseArtifactRepository,
	type ArtifactSupabaseClient,
} from "@ahkms/core/adapters";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { getExternalLinks } from "../links.js";
import { loadCapturePreferences, resolveTrust, resolveSynthesisRole } from "../captureConfig.js";

export { ARTIFACT_SELECT_COLUMNS, getArtifactInput, type ArtifactRow };

/**
 * Fetch an artifact plus its linked entities/derived-links/provenance and render the same
 * text block artifact_get has always returned. Factored out (#588, #1511) so artifact_get_file
 * can compose on top of it — one query, one text format — instead of duplicating this.
 * Returns `found: false` with the exact "No artifact <id>." text artifact_get has always
 * used for a missing/foreign-owned id, so both tools' not-found shape stays identical.
 */
export async function loadArtifact(id: string): Promise<ArtifactGetResult> {
	return loadArtifactFromPorts(id, {
		artifacts: createSupabaseArtifactRepository({
			client: supabase as unknown as ArtifactSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		externalLinks: { getExternalLinks },
		config: { loadCapturePreferences },
		resolveTrust,
		resolveSynthesisRole,
	});
}

export async function getArtifactHandler(
	args: z.infer<typeof getArtifactSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	const result = await loadArtifact(args.id);
	return { content: [{ type: "text", text: result.text }] };
}
