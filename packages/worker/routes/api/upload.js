/**
 * Upload API Route
 * Handles file uploads to Supabase Storage via the worker
 * 
 * POST /api/upload
 * - Accepts multipart/form-data with file and metadata
 * - Authenticates user via Bearer token
 * - Calls executeUploadStep() for upload with retry logic
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();

const { loadUploadStep } = require('../_shared/loadUploadStep');
const { loadOrchestrator, triggerWorkflowProcessing } = require('../_shared/triggerWorkflowProcessing');

// Load ID value objects (try dist first, then src with ts-node in dev)
let WorkflowId, StepId;
try {
  const ids = require('../../dist/workflows/ids');
  WorkflowId = ids.WorkflowId;
  StepId = ids.StepId;
} catch (e) {
  try {
    require('ts-node/register');
    const ids = require('../../src/workflows/ids');
    WorkflowId = ids.WorkflowId;
    StepId = ids.StepId;
  } catch (e2) {
    throw new Error('Failed to load workflow ids module: ' + (e2 && e2.message));
  }
}

// Supabase client for auth verification
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Configure multer for memory storage (files stored in memory as Buffer)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

/**
 * Verify the user's access token
 * @param {string} authHeader - Authorization header value
 * @returns {Promise<{user: object|null, error: string|null}>}
 */
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return { user: null, error: error?.message || 'Invalid token' };
    }

    return { user, error: null };
  } catch (err) {
    console.error('Token verification error:', err);
    return { user: null, error: 'Token verification failed' };
  }
}

/**
 * Authenticate the request and validate the uploaded file.
 * @param {object} req
 * @returns {Promise<{ ok: true, data: { user: object, file: object } } | { ok: false, error: string, statusCode: number }>}
 */
async function verifyRequest(req) {
  const { user, error: authError } = await verifyToken(req.headers.authorization);
  if (authError) {
    return { ok: false, statusCode: 401, error: authError };
  }
  if (!req.file) {
    return { ok: false, statusCode: 400, error: 'No file provided' };
  }
  return { ok: true, data: { user, file: req.file } };
}

/**
 * Resolve (or create) the workflow and step records for this upload.
 * @param {object} user
 * @param {object} file - multer file object
 * @param {object} body - request body
 * @param {object} headers - request headers
 * @returns {Promise<{ ok: true, data: { stepData: object, normalizedPlatform: string } } | { ok: false, error: string, statusCode: number }>}
 */
async function ensureWorkflowAndStep(user, file, body, headers) {
  const { originalname, mimetype, size } = file;
  const workflowId = body.workflowId || null;
  // Normalize userTextContent: prefer userTextContent, fallback to text
  const userTextContent = body.userTextContent || body.text || null;
  // URL capture: pass through so create_artifact can store it on the artifact
  const captureUrl = typeof body.captureUrl === 'string' && body.captureUrl.trim()
    ? body.captureUrl.trim()
    : null;

  const clientPlatformRaw = typeof body.clientPlatform === 'string'
    ? body.clientPlatform
    : (typeof headers['x-client-platform'] === 'string' ? headers['x-client-platform'] : null);

  const normalizedPlatform = (
    clientPlatformRaw === 'ios' ||
    clientPlatformRaw === 'android' ||
    clientPlatformRaw === 'worker' ||
    clientPlatformRaw === 'web'
  ) ? clientPlatformRaw : 'web';

  const { data: stepData, error: stepError } = await supabase
    .from('workflow_steps')
    .insert({
      workflow_id: workflowId || await createWorkflow(user.id, normalizedPlatform),
      step_type: 'upload',
      step_name: 'File Upload',
      step_order: 0,
      status: 'pending',
      input: {
        fileName: originalname,
        mimeType: mimetype,
        size: size,
        clientPlatform: normalizedPlatform,
        ...(userTextContent ? { userTextContent } : {}),
        ...(captureUrl ? { captureUrl } : {}),
      },
    })
    .select()
    .single();

  if (stepError) {
    console.error('[Upload API] Failed to create workflow step:', stepError);
    return { ok: false, statusCode: 500, error: 'Failed to create workflow step' };
  }

  return { ok: true, data: { stepData, normalizedPlatform } };
}

/**
 * Execute the upload step and optionally run the orchestrator.
 * @param {object} stepData
 * @param {object} file - multer file object
 * @param {object} userContext
 * @param {object} body - request body
 * @param {object} query - request query params
 * @returns {Promise<{ ok: true, data: { result: object, orchestratorResult: object|null, effectiveMode: string|null } } | { ok: false, error: string, statusCode: number, extra?: object }>}
 */
async function runUploadAndOrchestrator(stepData, file, userContext, body, query) {
  const { executeUploadStep } = await loadUploadStep();

  let workflowIdVal, stepIdVal;
  try {
    workflowIdVal = WorkflowId.parse(stepData.workflow_id);
    stepIdVal = StepId.parse(stepData.id);
  } catch (parseErr) {
    console.error('[Upload API] Invalid workflow or step ID:', parseErr?.message);
    return { ok: false, statusCode: 400, error: 'Invalid workflow or step ID', extra: { details: parseErr?.message } };
  }

  const fileObject = {
    name: file.originalname,
    size: file.size,
    type: file.mimetype,
    data: file.buffer,
  };

  const result = await executeUploadStep(stepData, fileObject, userContext, workflowIdVal, stepIdVal);

  if (!result.success) {
    return { ok: false, statusCode: 400, error: result.error, extra: { workflowStepId: stepData.id } };
  }

  // Preferred: orchestratorMode=full|fast-return. Back-compat: runOrchestrator=true.
  const orchestratorModeRaw = typeof body.orchestratorMode === 'string'
    ? body.orchestratorMode.trim()
    : null;

  if (orchestratorModeRaw && orchestratorModeRaw !== 'full' && orchestratorModeRaw !== 'fast-return') {
    return { ok: false, statusCode: 400, error: `Invalid orchestratorMode: ${orchestratorModeRaw}. Expected 'full' or 'fast-return'.` };
  }

  // FormData sends strings, so check for string 'true'
  const runOrchestratorLegacy = body.runOrchestrator === 'true' || query?.orchestrate === 'true';
  const effectiveMode = orchestratorModeRaw || (runOrchestratorLegacy ? 'full' : null);

  const createDerivedArtifactsRaw = body.createDerivedArtifacts;
  const captureOptions = createDerivedArtifactsRaw !== undefined
    ? { create_derived_artifacts: createDerivedArtifactsRaw === 'true' || createDerivedArtifactsRaw === true }
    : undefined;

  let orchestratorResult = null;

  if (effectiveMode) {
    console.log('[Upload API] Running orchestrator for workflow:', stepData.workflow_id, { mode: effectiveMode, captureOptions });
    try {
      const { executeWorkflow } = await loadOrchestrator();
      const workflowOptions = {
        ...(effectiveMode === 'fast-return' ? { returnAfterStep: 'create_artifact' } : {}),
        ...(captureOptions ? { captureOptions } : {}),
      };
      // Run orchestrator — upload step already complete, so file=null
      orchestratorResult = await executeWorkflow(stepData.workflow_id, null, userContext, workflowOptions);

      // Durability guarantee for fast-return: only succeed once artifactId exists.
      if (effectiveMode === 'fast-return' && (!orchestratorResult || !orchestratorResult.artifactId)) {
        return {
          ok: false,
          statusCode: 500,
          error: 'Fast-return orchestration did not produce artifactId',
          extra: {
            workflowId: stepData.workflow_id,
            objectPath: result.objectPath,
            fileMetadata: result.fileMetadata,
            orchestrator: orchestratorResult,
          },
        };
      }
      console.log('[Upload API] Orchestrator result:', orchestratorResult);
    } catch (orchErr) {
      console.error('[Upload API] Orchestrator error (non-fatal):', orchErr);
      orchestratorResult = { error: orchErr.message, status: 'failed' };
    }
  }

  return { ok: true, data: { result, orchestratorResult, effectiveMode } };
}

/**
 * POST /api/upload
 * Upload a file to Supabase Storage
 *
 * Headers:
 *   Authorization: Bearer <access_token>
 *
 * Body (multipart/form-data):
 *   file: The file to upload
 *   workflowId: (optional) ID of existing workflow
 *
 * Response:
 *   200: { success: true, objectPath, fileMetadata }
 *   400: { error: "..." }
 *   401: { error: "Unauthorized" }
 *   500: { error: "..." }
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const reqCheck = await verifyRequest(req);
    if (!reqCheck.ok) {
      return res.status(reqCheck.statusCode).json({ success: false, error: reqCheck.error });
    }
    const { user, file } = reqCheck.data;

    console.log('[Upload API] Received file:', {
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      userId: user.id,
    });

    const stepCheck = await ensureWorkflowAndStep(user, file, req.body, req.headers);
    if (!stepCheck.ok) {
      return res.status(stepCheck.statusCode).json({ success: false, error: stepCheck.error });
    }
    const { stepData, normalizedPlatform } = stepCheck.data;

    const userContext = {
      userId: user.id,
      uploadTime: new Date(),
      deviceInfo: {
        platform: normalizedPlatform,
        version: req.headers['user-agent'] || 'unknown',
      },
    };

    const uploadCheck = await runUploadAndOrchestrator(stepData, file, userContext, req.body, req.query);
    if (!uploadCheck.ok) {
      return res.status(uploadCheck.statusCode).json({
        success: false,
        error: uploadCheck.error,
        ...(uploadCheck.extra || {}),
      });
    }
    const { result, orchestratorResult, effectiveMode } = uploadCheck.data;

    const responseBody = {
      success: true,
      objectPath: result.objectPath,
      fileMetadata: result.fileMetadata,
      workflowStepId: stepData.id,
      workflowId: stepData.workflow_id,
      orchestrator: orchestratorResult,
    };

    // For fast-return flows, trigger async continuation after responding.
    if (effectiveMode === 'fast-return') {
      triggerWorkflowProcessing(stepData.workflow_id);
    }

    return res.json(responseBody);
  } catch (err) {
    console.error('[Upload API] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/**
 * Create a new workflow for the user
 * @param {string} userId 
 * @returns {Promise<string>} The workflow ID
 */
async function createWorkflow(userId, platform) {
  // Generate UUID explicitly (gen_random_uuid() default sometimes doesn't apply)
  const { randomUUID } = require('crypto');
  const workflowId = randomUUID();

  const triggerSource = platform === 'ios' || platform === 'android'
    ? 'phone_app'
    : platform === 'worker'
      ? 'api'
      : 'web_upload';
  
  const { data, error } = await supabase
    .from('workflows')
    .insert({
      id: workflowId,  // Explicitly set UUID
      user_id: userId,
      workflow_type: 'artifact_capture',
      status: 'in_progress',
      metadata: { trigger_source: triggerSource },
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Upload API] Failed to create workflow:', error);
    throw new Error('Failed to create workflow');
  }

  return data.id;
}

/**
 * GET /api/upload/signed-url
 * Generate a signed URL for accessing a file
 * 
 * Query params:
 *   path: The object path in storage
 *   expiresIn: (optional) Expiration time in seconds (default: 3600)
 */
router.get('/signed-url', async (req, res) => {
  try {
    // Verify authentication
    const { user, error: authError } = await verifyToken(req.headers.authorization);
    
    if (authError) {
      return res.status(401).json({ success: false, error: authError });
    }

    const { path, expiresIn = 3600 } = req.query;

    if (!path) {
      return res.status(400).json({ success: false, error: 'Missing path parameter' });
    }

    // Verify the user owns this file (path should start with userId)
    if (!path.startsWith(user.id)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Generate signed URL
    const { data, error } = await supabase.storage
      .from('user-uploads')
      .createSignedUrl(path, parseInt(expiresIn));

    if (error) {
      console.error('[Upload API] Failed to create signed URL:', error);
      return res.status(500).json({ success: false, error: 'Failed to create signed URL' });
    }

    return res.json({ success: true, signedUrl: data.signedUrl });
  } catch (err) {
    console.error('[Upload API] Error creating signed URL:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;

