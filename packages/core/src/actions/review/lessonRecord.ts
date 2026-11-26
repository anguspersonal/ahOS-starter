import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import type { GenericSupabaseClient } from "../github/issueCreate.js";
import { subjectKey } from "./subjectKey.js";

export const reviewLessonCategories = [
	"not_wanted",
	"wrong",
	"not_now",
	"duplicate",
] as const;

export const reviewLessonRecordInputSchema = z.object({
	decision_id: z.string().uuid(),
	category: z.enum(reviewLessonCategories),
	summary: z.string().min(1).max(500),
	cooldown_days: z.number().int().min(1).max(365).optional(),
	forever: z.boolean().optional(),
});

export type ReviewLessonRecordInput = z.infer<typeof reviewLessonRecordInputSchema>;

export const reviewLessonRecordOutputSchema = z.object({
	id: z.string(),
	subject_key: z.string(),
	cooling_off_until: z.string().nullable(),
});

export type ReviewLessonRecordOutput = z.infer<typeof reviewLessonRecordOutputSchema>;

export interface ReviewLessonActionDependencies {
	supabase: GenericSupabaseClient;
	getUserId?: () => string;
	now?: () => Date;
}

export async function executeReviewLessonRecord(
	input: ReviewLessonRecordInput,
	context: ActionContext,
	deps: ReviewLessonActionDependencies,
): Promise<ReviewLessonRecordOutput> {
	const userId = context.userId ?? deps.getUserId?.();
	if (!userId) {
		throw new Error("Missing user context: userId is required.");
	}

	const { data: decision, error: readError } = await deps.supabase
		.from("system_decisions")
		.select("id, user_id, status, decision_type, decision_payload")
		.eq("id", input.decision_id)
		.eq("user_id", userId)
		.maybeSingle();

	if (readError) {
		throw new Error(readError.message);
	}
	if (!decision || decision.user_id !== userId) {
		const notFound = new Error(`Decision not found: ${input.decision_id}`);
		(notFound as any).status = 404;
		throw notFound;
	}
	if (decision.status !== "rejected") {
		throw new Error("only a rejected suggestion can carry a lesson");
	}

	const derivedKey = subjectKey(
		String(decision.decision_type ?? ""),
		(decision.decision_payload as Record<string, unknown> | null) ?? null,
	);

	const nowDate = deps.now ? deps.now() : new Date();
	const coolingOffUntil =
		input.forever === true
			? null
			: new Date(
					nowDate.getTime() + (input.cooldown_days ?? 14) * 24 * 60 * 60 * 1000,
				).toISOString();

	const { data: inserted, error: insertError } = await deps.supabase
		.from("review_lessons")
		.insert({
			user_id: userId,
			decision_id: input.decision_id,
			decision_type: String(decision.decision_type),
			subject_key: derivedKey,
			category: input.category,
			summary: input.summary,
			cooling_off_until: coolingOffUntil,
		})
		.select("id, subject_key, cooling_off_until")
		.single();

	if (insertError) {
		throw new Error(insertError.message);
	}

	return {
		id: String(inserted?.id ?? ""),
		subject_key: String(inserted?.subject_key ?? derivedKey),
		cooling_off_until:
			inserted && "cooling_off_until" in inserted
				? (inserted.cooling_off_until as string | null)
				: coolingOffUntil,
	};
}

export function createReviewLessonRecordAction(
	deps: ReviewLessonActionDependencies,
): ActionDefinition<typeof reviewLessonRecordInputSchema, ReviewLessonRecordOutput> {
	return defineAction<typeof reviewLessonRecordInputSchema, ReviewLessonRecordOutput>({
		id: "review_lesson_record",
		name: "review_lesson_record",
		description:
			"Record a lesson and cooling-off window (or forever) on a rejected system decision so producers do not re-propose the same suggestion.",
		domain: "governance",
		schema: reviewLessonRecordInputSchema,
		outputSchema: reviewLessonRecordOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		formatMcp(result) {
			return JSON.stringify(result, null, 2);
		},
		async run(input, context) {
			return executeReviewLessonRecord(input, context, deps);
		},
	});
}
