import type { NeedsApproval } from "@ahkms/core";

/**
 * Legacy `register()` tool approval gates keyed by canonical tool name (which covers every alias).
 * When a tool family migrates to a `@ahkms/core` action (#1338), its entry moves onto the action's
 * `needsApproval` in the same PR.
 */
export const LEGACY_GATES: Readonly<Record<string, NeedsApproval>> = {};
