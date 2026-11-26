/**
 * In-memory set of workflow IDs currently being executed on this worker process.
 * Used by the status endpoint to distinguish "in progress" from "stuck" (DB says
 * in_progress but worker is not running this workflow, e.g. after crash or timeout).
 */

const running = new Set<string>();

export function add(workflowId: string): void {
  running.add(workflowId);
}

export function remove(workflowId: string): void {
  running.delete(workflowId);
}

export function has(workflowId: string): boolean {
  return running.has(workflowId);
}
