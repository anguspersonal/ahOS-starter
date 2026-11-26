/**
 * Shared loader for the upload workflow step.
 *
 * In production we load compiled JS from dist/.
 * In dev/test we fall back to TS via ts-node/register.
 */

let executeUploadStep;

async function loadUploadStep() {
  if (executeUploadStep) return { executeUploadStep };

  try {
    const uploadModule = require('../../dist/workflows/steps/upload');
    executeUploadStep = uploadModule.executeUploadStep || uploadModule.default;
    if (!executeUploadStep) {
      throw new Error('executeUploadStep not found in upload module');
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Upload Loader] Failed to load compiled upload module:', err);
      throw new Error(
        'Upload module not found. Ensure TypeScript is compiled: npm run build. ' +
          `Error: ${err.message}`
      );
    }

    require('ts-node/register');
    const uploadModule = require('../../src/workflows/steps/upload');
    executeUploadStep = uploadModule.executeUploadStep || uploadModule.default;
    if (!executeUploadStep) {
      throw new Error('executeUploadStep not found in upload module');
    }
  }

  return { executeUploadStep };
}

module.exports = { loadUploadStep };

