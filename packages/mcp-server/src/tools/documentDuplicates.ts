import type { z } from "zod";
import {
	createCoreArtifactsPort,
	createDocumentDuplicatesAction,
	describeRpcError,
	documentDuplicatesInput,
	documentDuplicatesSchema,
	explainCanonical,
	FAMILY_READ_CAP,
	formatClusters,
	formatDocumentDuplicatesMcp,
	groupClusters,
	MEMBERS_PER_CLUSTER,
	QUERY_TITLE_CAP,
	type Cluster,
	type ClusterRow,
	type DocumentDuplicatesInput,
	type DocumentDuplicatesResult,
} from "@ahkms/core";
import {
	createSupabaseArtifactRepository,
	type ArtifactSupabaseClient,
} from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";

export {
	describeRpcError,
	documentDuplicatesInput,
	documentDuplicatesSchema,
	explainCanonical,
	FAMILY_READ_CAP,
	formatClusters,
	formatDocumentDuplicatesMcp,
	groupClusters,
	MEMBERS_PER_CLUSTER,
	QUERY_TITLE_CAP,
	type Cluster,
	type ClusterRow,
	type DocumentDuplicatesInput,
	type DocumentDuplicatesResult,
};

export async function documentDuplicatesCore(
	args: z.infer<typeof documentDuplicatesSchema>,
	injectedUserId?: string,
): Promise<DocumentDuplicatesResult> {
	return createCoreArtifactsPort({
		ownerId: getCurrentUserId,
		artifacts: (userId) =>
			createSupabaseArtifactRepository({
				client: supabase as unknown as ArtifactSupabaseClient,
				ownerId: () => userId ?? getCurrentUserId(),
			}),
	}).documentDuplicates(args, injectedUserId);
}

export const documentDuplicatesAction = createDocumentDuplicatesAction(
	{ documentDuplicates: documentDuplicatesCore },
	{
		formatMcp: formatDocumentDuplicatesMcp,
	},
);

export async function documentDuplicatesHandler(
	args: z.infer<typeof documentDuplicatesSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	return toMcpTool(documentDuplicatesAction).handler(args);
}
