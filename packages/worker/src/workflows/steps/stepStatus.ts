import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import type { WorkflowStep } from './types';
import type { StepId } from './types';

export async function updateStepStatus(
  stepId: StepId,
  status: WorkflowStep['status'],
  updates: Partial<WorkflowStep>
): Promise<void> {
  try {
    const { error } = await supabase
      .from('workflow_steps')
      .update({
        status,
        ...updates,
      })
      .eq('id', stepId.value);

    if (error) {
      logger.error('Failed to update step status', { stepId: stepId.value, status, error });
    }
  } catch (err) {
    logger.error('Error updating step status', { stepId: stepId.value, status, err });
  }
}
