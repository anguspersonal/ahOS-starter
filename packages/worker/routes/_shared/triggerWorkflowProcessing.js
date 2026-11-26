/**
 * Shared workflow processing trigger helper.
 *
 * Used by:
 * - Webhook handlers (workflow-created)
 * - API routes that need to kick off async continuation (e.g., fast-return uploads)
 *
 * Loads the orchestrator (compiled JS in production; TS via ts-node in dev)
 * and runs executeWorkflow(workflowId) in a fire-and-forget manner.
 */

let executeWorkflow;

async function loadOrchestrator() {
  if (executeWorkflow) return { executeWorkflow };

  try {
    // Try compiled JavaScript first (production / built environments)
    const orchestratorModule = require('../../dist/workflows/orchestrator');
    executeWorkflow = orchestratorModule.executeWorkflow || orchestratorModule.default;
    if (!executeWorkflow) {
      throw new Error('executeWorkflow not found in orchestrator module');
    }
  } catch (err) {
    // Fallback to TypeScript with ts-node (development only)
    if (process.env.NODE_ENV === 'production') {
      console.error('[Workflow Trigger] Failed to load compiled orchestrator module:', err);
      throw new Error(
        'Orchestrator module not found. Ensure TypeScript is compiled: npm run build. ' +
          `Error: ${err.message}`
      );
    }

    require('ts-node/register');
    const orchestratorModule = require('../../src/workflows/orchestrator');
    executeWorkflow = orchestratorModule.executeWorkflow || orchestratorModule.default;
    if (!executeWorkflow) {
      throw new Error('executeWorkflow not found in orchestrator module');
    }
  }

  return { executeWorkflow };
}

/**
 * Trigger workflow processing asynchronously.
 * Never throws (logs errors instead).
 */
function triggerWorkflowProcessing(workflowId) {
  // Use setImmediate so the caller can return HTTP responses first.
  setImmediate(async () => {
    try {
      const { executeWorkflow } = await loadOrchestrator();
      const result = await executeWorkflow(workflowId);
      console.log('[Workflow Trigger] Orchestrator result:', JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('[Workflow Trigger] Orchestrator error:', error);
    }
  });
}

module.exports = {
  loadOrchestrator,
  triggerWorkflowProcessing,
};

