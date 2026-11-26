/**
 * Unit tests for Create Artifact Step
 *
 * Regression coverage for #131: artifacts created via this step (the
 * web_upload / phone_app / api ingestion path) must never get a null title.
 */

import { executeCreateArtifactStep } from '../../../../src/workflows/steps/createArtifact';
import { supabase } from '../../../../src/utils/supabase';
import {
  createMockUserContext,
  createMockFileMetadata,
  createMockWorkflowStep,
  TEST_WORKFLOW_ID,
} from '../../../helpers/fixtures';
import { WorkflowId, StepId } from '../../../../src/workflows/steps/types';
import { resetMockData, setMockData, getMockData } from '../../../__mocks__/supabase';

jest.mock('../../../../src/utils/supabase');

const workflowId = WorkflowId.parse(TEST_WORKFLOW_ID);
const stepId = StepId.parse(1);

describe('Create Artifact Step — title derivation (#131)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    // Row for updateStepStatus()'s .eq('id', ...) update to match against.
    setMockData('workflow_steps', [createMockWorkflowStep({ id: 1, workflow_id: TEST_WORKFLOW_ID })]);
    setMockData('workflows', [{ id: TEST_WORKFLOW_ID, source_artifact_id: null }]);
  });

  it('derives the title from the first line of pasted text (web_upload with text)', async () => {
    const result = await executeCreateArtifactStep({
      step: createMockWorkflowStep(),
      objectPath: 'user-123/note.txt',
      fileMetadata: createMockFileMetadata({ fileName: 'capture-abc123.txt', mimeType: 'text/plain' }),
      userTextContent: 'Connection Crew @12 March 2026 16:30\n\nRest of the transcript body...',
      userContext: createMockUserContext({ deviceInfo: { platform: 'web', version: '1.0' } }),
      workflowId,
      stepId,
    });

    expect(result.success).toBe(true);
    const [artifact] = getMockData('artifacts');
    expect(artifact.title).toBe('Connection Crew @12 March 2026 16:30');
    expect(artifact.source).toBe('web_upload');
  });

  it('falls back to the filename (extension stripped) when there is no text content', async () => {
    const result = await executeCreateArtifactStep({
      step: createMockWorkflowStep(),
      objectPath: 'user-123/report.pdf',
      fileMetadata: createMockFileMetadata({
        fileName: 'Quarterly Report.pdf',
        mimeType: 'application/pdf',
        size: 5000,
      }),
      userTextContent: null,
      userContext: createMockUserContext({ deviceInfo: { platform: 'web', version: '1.0' } }),
      workflowId,
      stepId,
    });

    expect(result.success).toBe(true);
    const [artifact] = getMockData('artifacts');
    expect(artifact.title).toBe('Quarterly Report');
    expect(artifact.title).not.toBeNull();
  });

  it('derives the title from the filename (not the URL) for a URL capture with no pasted text', async () => {
    // Every current caller (orchestrator.ts's upload step, and the sole
    // production entry point at packages/web/app/api/knowledge/capture/route.ts)
    // always synthesizes a non-empty filename before upload — for URL
    // captures specifically, `url-capture-${uuid}.txt`. So the title always
    // resolves via the filename branch of deriveArtifactTitle; the raw
    // `captureUrl` is never used as the title itself, only preserved
    // separately in `content`/`plain_text`. This pins that real, reachable
    // behavior rather than the URL-fallback branch, which no caller can hit.
    const result = await executeCreateArtifactStep({
      step: createMockWorkflowStep(),
      objectPath: 'user-123/url-capture.txt',
      fileMetadata: createMockFileMetadata({ fileName: 'url-capture-xyz789.txt', mimeType: 'text/plain', size: 0 }),
      userTextContent: null,
      userContext: createMockUserContext({ deviceInfo: { platform: 'web', version: '1.0' } }),
      workflowId,
      stepId,
      captureUrl: 'https://example.com/some-article',
    });

    expect(result.success).toBe(true);
    const [artifact] = getMockData('artifacts');
    expect(artifact.title).toBe('url-capture-xyz789');
    expect(artifact.content).toEqual({ url: 'https://example.com/some-article' });
    expect(artifact.plain_text).toBe('https://example.com/some-article');
  });

  it('never inserts a null or empty-string title, even for whitespace-only text', async () => {
    const result = await executeCreateArtifactStep({
      step: createMockWorkflowStep(),
      objectPath: 'user-123/blank.txt',
      fileMetadata: createMockFileMetadata({ fileName: 'notes.txt', mimeType: 'text/plain', size: 200 }),
      userTextContent: '   \n   \n   ',
      userContext: createMockUserContext({ deviceInfo: { platform: 'web', version: '1.0' } }),
      workflowId,
      stepId,
    });

    expect(result.success).toBe(true);
    const [artifact] = getMockData('artifacts');
    expect(artifact.title).toBe('notes');
    expect(artifact.title).not.toBeNull();
    expect(artifact.title).not.toBe('');
  });

  it('derives a title for the phone_app source the same way as web_upload', async () => {
    const result = await executeCreateArtifactStep({
      step: createMockWorkflowStep(),
      objectPath: 'user-123/mobile-note.txt',
      fileMetadata: createMockFileMetadata({ fileName: 'capture-mobile.txt', mimeType: 'text/plain' }),
      userTextContent: 'Quick voice memo transcript\nSecond line',
      userContext: createMockUserContext({ deviceInfo: { platform: 'ios', version: '1.0' } }),
      workflowId,
      stepId,
    });

    expect(result.success).toBe(true);
    const [artifact] = getMockData('artifacts');
    expect(artifact.title).toBe('Quick voice memo transcript');
    expect(artifact.source).toBe('phone_app');
  });

  it('truncates an overly long first line to a bounded title length', async () => {
    const longLine = 'A'.repeat(300);
    const result = await executeCreateArtifactStep({
      step: createMockWorkflowStep(),
      objectPath: 'user-123/long.txt',
      fileMetadata: createMockFileMetadata({ fileName: 'capture-long.txt', mimeType: 'text/plain' }),
      userTextContent: longLine,
      userContext: createMockUserContext({ deviceInfo: { platform: 'web', version: '1.0' } }),
      workflowId,
      stepId,
    });

    expect(result.success).toBe(true);
    const [artifact] = getMockData('artifacts');
    expect(artifact.title.length).toBeLessThanOrEqual(120);
  });
});
