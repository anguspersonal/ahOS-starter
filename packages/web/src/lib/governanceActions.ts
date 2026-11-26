import {
  decisionReviewSchema,
  type DecisionReviewInput,
  type SystemDecisionRow,
  type DecisionReviewResult,
} from "@ahkms/core";
import { type ClientActionDefinition } from "./actionClient.js";
import { supabase } from "./supabase.js";

export const clientDecisionReviewSchema = decisionReviewSchema;
export type ClientDecisionReviewInput = DecisionReviewInput;
export type ClientSystemDecisionRow = SystemDecisionRow;
export type ClientDecisionReviewResult = DecisionReviewResult;

export async function listPendingDecisionsDirect(
  input: ClientDecisionReviewInput,
  userId?: string,
): Promise<ClientDecisionReviewResult> {
  let query = supabase
    .from("system_decisions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 20);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  if (input.status) {
    query = query.eq("status", input.status);
  } else {
    query = query.eq("status", "pending");
  }

  if (input.blocking_only) {
    query = query.eq("blocking", true);
  }

  if (input.stage) {
    query = query.eq("stage", input.stage);
  }

  if (input.review_type) {
    query = query.eq("review_type", input.review_type);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list pending decisions: ${error.message}`);
  }

  return {
    operation: "list_pending",
    count: data?.length ?? 0,
    decisions: (data ?? []) as ClientSystemDecisionRow[],
  };
}

export async function getDecisionDirect(
  id: string,
  userId?: string,
): Promise<ClientDecisionReviewResult> {
  let query = supabase.from("system_decisions").select("*").eq("id", id);
  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query.single();
  if (error) {
    throw new Error(`Failed to get decision ${id}: ${error.message}`);
  }

  return {
    operation: "get",
    decision: data as ClientSystemDecisionRow,
  };
}

export const decisionReviewActionClient: ClientActionDefinition<
  ClientDecisionReviewInput,
  ClientDecisionReviewResult
> = {
  id: "decision_review",
  name: "System Decision Review",
  description:
    "Review, inspect, approve, reject, modify, or bulk-resolve autonomous system decisions in ahOS (issue #1218).",
  schema: clientDecisionReviewSchema,
};
