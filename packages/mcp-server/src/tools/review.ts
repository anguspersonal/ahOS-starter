import { z } from "zod";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { embed, embedBatch } from "../embeddings.js";
import {
	createReviewListAction,
	createReviewResolveAction,
	formatReviewListMcp,
	formatReviewResolveMcp,
	reviewListInput,
	reviewListSchema,
	reviewResolveInput,
	reviewResolveSchema,
	type ReviewCandidateEntity,
	type ReviewDecisionItem,
	type ReviewListResult,
	type ReviewResolveResult,
	type ReviewListInput,
	type ReviewResolveInput,
} from "@ahkms/core";
import {
	reviewListCore as coreReviewList,
	reviewResolveCore as coreReviewResolve,
} from "@ahkms/core/actions";
import {
	createSupabaseDecisionRepository,
	createSupabaseEmbeddingStore,
	createSupabaseEntityMergeAdapter,
	createSupabaseEntityRepository,
	type EntitiesSupabaseClient,
	type EntityMergeSupabaseClient,
} from "@ahkms/core/adapters";

export {
	reviewListInput,
	reviewListSchema,
	reviewResolveInput,
	reviewResolveSchema,
	formatReviewListMcp,
	formatReviewResolveMcp,
	type ReviewCandidateEntity,
	type ReviewDecisionItem,
	type ReviewListResult,
	type ReviewResolveResult,
	type ReviewListInput,
	type ReviewResolveInput,
};

function buildServerReviewDeps() {
	return {
		decisions: createSupabaseDecisionRepository(supabase),
		entities: createSupabaseEntityRepository({
			client: supabase as unknown as EntitiesSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		merge: createSupabaseEntityMergeAdapter({
			client: supabase as unknown as EntityMergeSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		embedding:
			typeof embed === "function"
				? {
						embed: (text: string) => embed(text),
						embedBatch: (texts: string[]) => embedBatch(texts),
					}
				: null,
		embeddingStore: createSupabaseEmbeddingStore(supabase),
		resolveUserId: getCurrentUserId,
	};
}

export async function reviewListCore(
	args: z.infer<typeof reviewListSchema>,
	injectedUserId?: string,
): Promise<ReviewListResult> {
	return coreReviewList(buildServerReviewDeps(), args, injectedUserId);
}

export async function reviewResolveCore(
	args: z.infer<typeof reviewResolveSchema>,
	injectedUserId?: string,
): Promise<ReviewResolveResult> {
	return coreReviewResolve(buildServerReviewDeps(), args, injectedUserId);
}

export const reviewListAction = createReviewListAction({
	reviewList: reviewListCore,
});
export const reviewResolveAction = createReviewResolveAction({
	reviewResolve: reviewResolveCore,
});

export async function reviewListHandler(
	args: z.input<typeof reviewListSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	return toMcpTool(reviewListAction).handler(args);
}

export async function reviewResolveHandler(
	args: z.input<typeof reviewResolveSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	return toMcpTool(reviewResolveAction).handler(args);
}
