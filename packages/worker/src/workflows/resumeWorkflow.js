// src/workflows/resumeWorkflow.js
// Resumes a workflow after user feedback

const { supabase } = require('../db/client');
const { processWorkflow } = require('./orchestrator');

/**
 * Resume a workflow after user feedback/edit
 * @param {string} workflowId - The workflow ID to resume
 * @param {string|null} userEdit - User's edit/feedback (if any)
 * @returns {Promise<void>}
 */
async function resumeWorkflow(workflowId, userEdit) {
  let workflow = null;
  
  try {
    console.log(`Resuming workflow ${workflowId} with edit: ${userEdit || 'none'}`);
    
    // Fetch workflow object
    const { data: fetchedWorkflow, error: fetchError } = await supabase
      .from('workflow_runs')
      .select('*')
      .eq('id', workflowId)
      .single();
    
    if (fetchError || !fetchedWorkflow) {
      throw new Error(`Workflow not found: ${fetchError?.message || 'Unknown error'}`);
    }
    
    workflow = fetchedWorkflow;
    
    // Update workflow with user edit if provided
    if (userEdit) {
      const { error: updateError } = await supabase
        .from('workflow_runs')
        .update({ 
          metadata: {
            ...(workflow.metadata || {}),
            user_edit: userEdit
          },
          status: 'in_progress'
        })
        .eq('id', workflowId);
      
      if (updateError) {
        throw updateError;
      }
    }
    
    // Resume workflow processing
    // Note: file, userContext, and userTextContent would need to be retrieved from workflow metadata or source artifact
    // For now, passing null - these should be populated when full implementation is done
    await processWorkflow(workflow, null, null, userEdit || null);
    
  } catch (err) {
    console.error(`Error resuming workflow ${workflowId}:`, err);
    
    // Update workflow status to failed
    // Only update metadata if we successfully fetched the workflow
    const updateData = {
      status: 'failed',
      completed_at: new Date().toISOString(),
      last_message: err.message
    };
    
    if (workflow) {
      updateData.metadata = {
        ...(workflow.metadata || {}),
        error: err.message
      };
    } else {
      // If workflow wasn't fetched, just set error in metadata
      updateData.metadata = {
        error: err.message
      };
    }
    
    await supabase
      .from('workflow_runs')
      .update(updateData)
      .eq('id', workflowId);
    
    throw err;
  }
}

module.exports = { resumeWorkflow };

