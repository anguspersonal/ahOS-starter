import type { DocumentDuplicatesInput } from "../domain/capture.js";
import type {
	ArtifactRepository,
	ClusterRow,
	DocumentDuplicatesResult,
} from "../../ports/artifacts.js";
import { groupClusters, QUERY_TITLE_CAP } from "./documentDuplicates.js";

export type DocumentDuplicatesRepository = Pick<
	ArtifactRepository,
	"duplicateClusters"
>;

/**
 * Formats an RPC error into actionable caller guidance (57014 timeout, 54000 seed cap, missing migration 119).
 */
export function describeRpcError(
	error: { code?: string; message: string },
	args: DocumentDuplicatesInput,
): string {
	if (error.code === "57014") {
		const narrower = args.query
			? "a longer `query`, a `connector`, or a lower `limit`"
			: "`query` (a title) or `connector`, or lower `limit`";
		return `document_duplicates timed out in the database (statement timeout, 57014). Narrow the run: pass ${narrower}.`;
	}
	if (error.code === "54000") {
		return `document_duplicates: ${error.message}. Narrow the query (a longer title fragment) or pass \`connector\`; a query run reads at most ${QUERY_TITLE_CAP} matching titles.`;
	}
	const missing =
		error.code === "PGRST202" ||
		error.code === "42883" ||
		(/document_duplicate_clusters/.test(error.message) &&
			/could not find|does not exist/i.test(error.message));
	return missing
		? `document_duplicates failed: ${error.message}. The document_duplicate_clusters RPC is missing: apply migration 119.`
		: `document_duplicates failed: ${error.message}`;
}

export async function documentDuplicatesCore(
	artifacts: DocumentDuplicatesRepository,
	args: DocumentDuplicatesInput,
	userId?: string,
): Promise<DocumentDuplicatesResult> {
	let rows: ClusterRow[];
	try {
		rows = await artifacts.duplicateClusters({
			userId,
			query: args.query ?? null,
			connector: args.connector ?? null,
			min_cluster: args.min_cluster ?? 2,
			limit: args.limit ?? 20,
			include_archived: args.include_archived ?? false,
		});
	} catch (err) {
		if (err instanceof Error && err.name === "AdapterUnavailableError") throw err;
		const rpcErr =
			err && typeof err === "object" && "message" in err
				? (err as { code?: string; message: string })
				: { message: String(err) };
		throw new Error(describeRpcError(rpcErr, args));
	}
	return { rows, clusters: groupClusters(rows), args };
}
