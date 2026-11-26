// src/services/learning/feedback.js
// Handles user feedback and updates the system accordingly

const { supabase } = require('../../db/client');

/**
 * Handle user feedback for a notification
 * @param {string} notificationId - The notification ID
 * @param {string} userResponse - User's response/feedback
 * @returns {Promise<Object>} Result containing workflowId and userEdit if applicable
 */
async function handleUserFeedback(notificationId, userResponse) {
  try {
    console.log(`Handling feedback for notification ${notificationId}: ${userResponse}`);
    
    // Fetch the notification to get associated workflow
    const { data: notification, error: notifError } = await supabase
      .from('notifications')
      .select('*, workflows(*)')
      .eq('id', notificationId)
      .single();
    
    if (notifError || !notification) {
      throw new Error(`Notification ${notificationId} not found`);
    }
    
    // Update notification with user response
    const { error: updateError } = await supabase
      .from('notifications')
      .update({ 
        user_response: userResponse,
        responded_at: new Date().toISOString()
      })
      .eq('id', notificationId);
    
    if (updateError) {
      throw updateError;
    }
    
    // Extract user edit from response if applicable
    const userEdit = userResponse === 'approved' ? null : userResponse;
    
    return {
      workflowId: notification.workflow_id || notification.workflows?.id,
      userEdit: userEdit
    };
  } catch (err) {
    console.error('Error handling user feedback:', err);
    throw err;
  }
}

module.exports = { handleUserFeedback };

