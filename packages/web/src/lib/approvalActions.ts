import { type PendingApprovalInboxRow, type PendingApprovalRow } from "@ahkms/core";
import { createApprovalActions, type ExecuteApprovedResult } from "@ahkms/core/actions";
import type { z } from "zod";
import { executeActionClient, type ClientActionDefinition } from "./actionClient.js";

const coreApprovalActions = createApprovalActions({
  getStore: () => undefined,
  resolve: () => undefined,
});

export const approvalListSchema = coreApprovalActions.approval_list.schema;
export const approvalApproveSchema = coreApprovalActions.approval_approve.schema;
export const approvalRejectSchema = coreApprovalActions.approval_reject.schema;

export type ApprovalListInput = z.input<typeof approvalListSchema>;
export type ApprovalApproveInput = z.infer<typeof approvalApproveSchema>;
export type ApprovalRejectInput = z.infer<typeof approvalRejectSchema>;
export type ApprovalRejectOutput = { status: "rejected"; decision_id: string };
export type { PendingApprovalInboxRow, PendingApprovalRow, ExecuteApprovedResult };

export const approvalListActionClient: ClientActionDefinition<
  ApprovalListInput,
  { approvals: PendingApprovalInboxRow[] }
> = {
  id: "approval_list",
  name: "approval_list",
  description: coreApprovalActions.approval_list.description,
  schema: approvalListSchema as unknown as z.ZodType<ApprovalListInput>,
};

export const approvalApproveActionClient: ClientActionDefinition<
  ApprovalApproveInput,
  ExecuteApprovedResult
> = {
  id: "approval_approve",
  name: "approval_approve",
  description: coreApprovalActions.approval_approve.description,
  schema: approvalApproveSchema,
};

export const approvalRejectActionClient: ClientActionDefinition<
  ApprovalRejectInput,
  ApprovalRejectOutput
> = {
  id: "approval_reject",
  name: "approval_reject",
  description: coreApprovalActions.approval_reject.description,
  schema: approvalRejectSchema,
};

export const approvalClientActions = [
  approvalListActionClient,
  approvalApproveActionClient,
  approvalRejectActionClient,
] as const;

export type ResolveParkedCallOutcome = ExecuteApprovedResult | ApprovalRejectOutput | string;

export function noticeFromResolution(outcome: ResolveParkedCallOutcome): string | null {
  if (typeof outcome === "string") return outcome;
  return outcome.status === "failed" ? outcome.error : null;
}

export async function listParkedCalls(limit?: number): Promise<PendingApprovalInboxRow[]> {
  const res = await executeActionClient(
    approvalListActionClient,
    limit === undefined ? {} : { limit },
    "ui",
  );
  return res.approvals ?? [];
}

export async function resolveParkedCall(
  kind: "approve" | "reject",
  decisionId: string,
): Promise<ResolveParkedCallOutcome> {
  try {
    return kind === "approve"
      ? await executeActionClient(approvalApproveActionClient, { decision_id: decisionId }, "ui")
      : await executeActionClient(approvalRejectActionClient, { decision_id: decisionId }, "ui");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
