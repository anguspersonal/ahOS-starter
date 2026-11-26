import {
	backfillEmbeddingsInput,
	backfillEmbeddingsSchema,
	createArtifactEmbedBackfillAction,
	formatArtifactEmbedBackfillMcp,
	type ArtifactEmbedBackfillInput,
} from "@ahkms/core";
import { runEmbeddingBackfill } from "../embeddings/backfill.js";

export { backfillEmbeddingsInput, backfillEmbeddingsSchema };

export async function backfillEmbeddingsHandler(
	args: ArtifactEmbedBackfillInput,
): Promise<{ content: { type: "text"; text: string }[] }> {
	const action = createArtifactEmbedBackfillAction({
		runTableBackfill: ({ table, batchSize, maxBatches, dryRun }) =>
			runEmbeddingBackfill({ batchSize, maxBatches, dryRun, table }),
	});
	const result = await action.run(args ?? {}, { caller: "mcp", requestId: "backfill-handler" });
	return { content: [{ type: "text", text: formatArtifactEmbedBackfillMcp(result) }] };
}
