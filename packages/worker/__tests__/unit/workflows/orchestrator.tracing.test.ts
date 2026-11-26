/**
 * Regression tests for QA round-1 High on PR #782 (issue #764): the workflow's
 * root Sentry span was only ended on 2 of ~7 exit paths from `executeWorkflow`
 * -- every early `return` (a paused `awaiting_user` step, a fast-return, a
 * step that fails without throwing) left it open. Sentry only flushes a trace
 * once its root span ends, so an unended root drops the WHOLE trace, including
 * any child `workflow.step` spans that were already correctly ended. The
 * reviewer proved this empirically: replaying the `awaiting_user` shape
 * against the real SDK captured zero transactions.
 *
 * The fix routes every non-throw return in `executeWorkflow` through one
 * `finishSpanAndReturn` helper, so ending the span is structural rather than
 * a per-branch add-on. These tests exercise that against the REAL installed
 * Sentry SDK with a captured transport (same approach as
 * workflowMonitoring.test.ts), reusing orchestrator.test.ts's existing
 * mock-Supabase and mock-step-module harness -- because the defect is about
 * whether a transaction is emitted at all, which no amount of mocking Sentry
 * itself could prove.
 */

import * as Sentry from '@sentry/node';

import { executeWorkflow } from '../../../src/workflows/orchestrator';
import { executeUploadStep } from '../../../src/workflows/steps/upload';
import { executeCreateArtifactStep } from '../../../src/workflows/steps/createArtifact';
import { executeAnalyzeStep } from '../../../src/workflows/steps/analyze';
import { executeOrganizeEntitiesStep } from '../../../src/workflows/steps/organizeEntities';
import { executeExtractActionsStep } from '../../../src/workflows/steps/extractActions';
import { executeCreateDerivedArtifactStep } from '../../../src/workflows/steps/createDerived';
import { executeFinalizeStep } from '../../../src/workflows/steps/finalize';
import {
  createMockWorkflow,
  createMockFile,
  createMockUserContext,
  createMockFileMetadata,
  createMockWorkflowStep,
  TEST_WORKFLOW_ID,
  TEST_ARTIFACT_ID,
} from '../../helpers/fixtures';
import { resetMockData, setMockData, resetMockStorage, resetMockSupabase } from '../../__mocks__/supabase';

jest.mock('../../../src/workflows/steps/upload');
jest.mock('../../../src/workflows/steps/createArtifact');
jest.mock('../../../src/workflows/steps/analyze');
jest.mock('../../../src/workflows/steps/organizeEntities');
jest.mock('../../../src/workflows/steps/extractActions');
jest.mock('../../../src/workflows/steps/createDerived');
jest.mock('../../../src/workflows/steps/finalize');

const mockExecuteUploadStep = executeUploadStep as jest.MockedFunction<typeof executeUploadStep>;
const mockExecuteCreateArtifactStep = executeCreateArtifactStep as jest.MockedFunction<typeof executeCreateArtifactStep>;
const mockExecuteAnalyzeStep = executeAnalyzeStep as jest.MockedFunction<typeof executeAnalyzeStep>;
const mockExecuteOrganizeEntitiesStep = executeOrganizeEntitiesStep as jest.MockedFunction<typeof executeOrganizeEntitiesStep>;
const mockExecuteExtractActionsStep = executeExtractActionsStep as jest.MockedFunction<typeof executeExtractActionsStep>;
const mockExecuteCreateDerivedArtifactStep = executeCreateDerivedArtifactStep as jest.MockedFunction<typeof executeCreateDerivedArtifactStep>;
const mockExecuteFinalizeStep = executeFinalizeStep as jest.MockedFunction<typeof executeFinalizeStep>;

/** A completed `analyze` workflow_step row, pre-seeded so organize_entities/extract_actions
 * read a real AnalysisResult from the DB instead of taking their "missing analysisResult"
 * skip branch. Mirrors the shape `getAnalysisResultFromStepOutput` expects (`workflowContext.ts`). */
function createCompletedAnalyzeStep(analysisResultOverrides: Record<string, unknown> = {}) {
  return createMockWorkflowStep({
    id: 1,
    step_type: 'analyze',
    step_name: 'AI Content Analysis',
    step_order: 2,
    status: 'completed',
    output: {
      analysisResult: {
        intent: 'meeting_notes',
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
        confidence: 0.9,
        ...analysisResultOverrides,
      },
    },
  } as any);
}

/** Minimal shape of the envelope Sentry's transport receives, enough to find a transaction item. */
type CapturedEnvelope = [unknown, Array<[{ type?: string }, Record<string, any>]>];

function findWorkflowTransaction(envelopes: CapturedEnvelope[]): Record<string, any> | undefined {
  for (const [, items] of envelopes) {
    const transactionItem = items.find(
      ([itemHeader, itemBody]) =>
        itemHeader.type === 'transaction' && itemBody?.contexts?.trace?.op === 'workflow.execute',
    );
    if (transactionItem) {
      return transactionItem[1];
    }
  }
  return undefined;
}

describe('Workflow Orchestrator -- root span lifecycle (#764 round-1 High)', () => {
  let capturedEnvelopes: CapturedEnvelope[];
  const originalEnv = process.env;

  beforeAll(() => {
    Sentry.init({
      dsn: 'https://abc123@example.com/000004',
      tracesSampleRate: 1.0,
      transport: () =>
        ({
          send: (envelope: CapturedEnvelope) => {
            capturedEnvelopes.push(envelope);
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }) as any,
    });
  });

  beforeEach(() => {
    capturedEnvelopes = [];
    process.env = { ...originalEnv, SENTRY_DSN: 'https://abc123@example.com/123', SENTRY_TRACES_SAMPLE_RATE: '1.0' };

    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
    mockExecuteUploadStep.mockReset();
    mockExecuteCreateArtifactStep.mockReset();
    mockExecuteAnalyzeStep.mockReset();
    mockExecuteOrganizeEntitiesStep.mockReset();
    mockExecuteExtractActionsStep.mockReset();
    mockExecuteCreateDerivedArtifactStep.mockReset();
    mockExecuteFinalizeStep.mockReset();
    mockExecuteFinalizeStep.mockResolvedValue({
      success: true,
      notificationId: 'notification-123',
      summary: 'Workflow completed successfully',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
  });

  it('captures a workflow.execute transaction for a run that pauses for user clarification (awaiting_user)', async () => {
    const workflow = createMockWorkflow({
      id: TEST_WORKFLOW_ID,
      status: 'pending',
      source_artifact_id: TEST_ARTIFACT_ID,
    });
    setMockData('workflows', [workflow]);
    setMockData('workflow_steps', []);

    mockExecuteAnalyzeStep.mockResolvedValue({
      success: true,
      status: 'awaiting_user',
      confidence: 0.3,
      notificationId: 'notification-123',
      analysisResult: {
        intent: 'unclear',
        confidence: 0.3,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      },
    });

    const result = await executeWorkflow(TEST_WORKFLOW_ID);
    expect(result.status).toBe('awaiting_user');

    await Sentry.flush(1000);

    // Before the fix: this early return skipped both finishWorkflowTransaction
    // and finishWorkflowTransactionOnError, so the root span was never ended
    // and Sentry never flushed a transaction for this run at all -- reviewer
    // reproduced `captured: []` against this exact shape.
    const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
    expect(transactionEvent).toBeDefined();
    expect(transactionEvent?.contexts?.trace?.data?.final_status).toBe('awaiting_user');
  });

  it('captures a workflow.execute transaction for a step that fails without throwing (returned failure)', async () => {
    const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
    setMockData('workflows', [workflow]);
    setMockData('workflow_steps', []);

    mockExecuteUploadStep.mockResolvedValue({
      success: false,
      error: 'Upload failed',
    });

    const result = await executeWorkflow(TEST_WORKFLOW_ID, createMockFile(), createMockUserContext());
    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('upload');

    await Sentry.flush(1000);

    // Before the fix: `runStep`'s upload-failure branch returns { status:
    // 'failed' } without throwing, so it never reached the catch block's
    // finishWorkflowTransactionOnError either -- another silent trace drop.
    const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
    expect(transactionEvent).toBeDefined();
    expect(transactionEvent?.contexts?.trace?.data?.final_status).toBe('failed');
    expect(transactionEvent?.contexts?.trace?.status).toBe('internal_error');
  });

  it('still captures exactly one transaction for a normal completed run (no regression)', async () => {
    const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
    setMockData('workflows', [workflow]);
    setMockData('workflow_steps', []);

    mockExecuteUploadStep.mockResolvedValue({
      success: true,
      objectPath: 'user-123/test.jpg',
      fileMetadata: createMockFileMetadata(),
    });
    mockExecuteCreateArtifactStep.mockResolvedValue({
      success: true,
      artifactId: TEST_ARTIFACT_ID,
    });
    mockExecuteAnalyzeStep.mockResolvedValue({
      success: true,
      analysisResult: {
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      },
    });

    const result = await executeWorkflow(TEST_WORKFLOW_ID, createMockFile(), createMockUserContext());

    await Sentry.flush(1000);

    const workflowTransactions = capturedEnvelopes.flatMap(([, items]) =>
      items.filter(
        ([itemHeader, itemBody]) =>
          itemHeader.type === 'transaction' && itemBody?.contexts?.trace?.op === 'workflow.execute',
      ),
    );
    // Exactly one -- not zero (the bug) and not more than one (a double-finish).
    expect(workflowTransactions).toHaveLength(1);
    expect(workflowTransactions[0][1]?.contexts?.trace?.data?.final_status).toBe(result.status);
  });

  // Two residuals filed as issue #787 during round-2 QA confirmation of this
  // PR: the fast-return exit was fixed the same way as the shapes above but
  // never got its own test, and a step that fails without throwing was
  // (and, before this fix, still is) missing its own trackStepCompletion
  // call -- a defect this file's root-span fix could not have caught, since
  // it only asserts a transaction exists, never that it has children.
  describe('step span lifecycle and additional exit paths (#787)', () => {
    it('captures a workflow.execute transaction for the fast-return exit path (returnAfterStep)', async () => {
      const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);

      mockExecuteUploadStep.mockResolvedValue({
        success: true,
        objectPath: 'user-123/test.jpg',
        fileMetadata: createMockFileMetadata(),
      });
      mockExecuteCreateArtifactStep.mockResolvedValue({
        success: true,
        artifactId: TEST_ARTIFACT_ID,
      });

      const result = await executeWorkflow(TEST_WORKFLOW_ID, createMockFile(), createMockUserContext(), {
        returnAfterStep: 'create_artifact',
      });
      expect(result.status).toBe('partial');

      await Sentry.flush(1000);

      // Before this test existed: `tryReturnAfterStep`'s early return was
      // already routed through `finishSpanAndReturn` (same structural fix as
      // the two cases above), but nothing exercised it. #782's reviewer
      // mutated line 751 back to a bare `return earlyResult` and disabled the
      // `finally` safety net -- all 468 workflow tests, including the two
      // above, stayed green. This assertion is the one that would have caught it.
      const workflowTransactions = capturedEnvelopes.flatMap(([, items]) =>
        items.filter(
          ([itemHeader, itemBody]) =>
            itemHeader.type === 'transaction' && itemBody?.contexts?.trace?.op === 'workflow.execute',
        ),
      );
      expect(workflowTransactions).toHaveLength(1);
      expect(workflowTransactions[0][1]?.contexts?.trace?.data?.final_status).toBe('partial');
    });

    it('ends the step span for a step that fails without throwing (child span not lost)', async () => {
      const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);

      mockExecuteUploadStep.mockResolvedValue({
        success: false,
        error: 'Upload failed',
      });

      const result = await executeWorkflow(TEST_WORKFLOW_ID, createMockFile(), createMockUserContext());
      expect(result.status).toBe('failed');

      await Sentry.flush(1000);

      const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
      expect(transactionEvent).toBeDefined();

      // Before the fix: `runStep`'s upload-failure branch returned `{ status:
      // 'failed' }` without calling `trackStepCompletion`, so the step span
      // opened by `startStepSpan` was never ended. The root-span fix above
      // means the transaction now flushes regardless -- but with zero
      // children: correct workflow-level attributes, no indication of which
      // step failed or how long it ran.
      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      expect(stepSpans.length).toBeGreaterThan(0);

      const uploadSpan = stepSpans.find((s) => s.data?.step_type === 'upload');
      expect(uploadSpan).toBeDefined();
      expect(uploadSpan?.op).toBe('workflow.step');
      expect(uploadSpan?.data).toMatchObject({ status: 'failed', error: 'Upload failed' });
      expect(uploadSpan?.status).toBe('internal_error');
    });

    it('ends the step span for finalize failing without throwing (child span not lost)', async () => {
      // QA round 1 on this PR found that the upload test above did not
      // exercise the finalize half of the same fix: deleting the finalize
      // branch's trackStepCompletion block left all 729 worker tests green.
      // This walks the full happy path through to finalize (same mocks as
      // "still captures exactly one transaction for a normal completed run"
      // above) and forces only finalize to fail without throwing.
      const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);

      mockExecuteUploadStep.mockResolvedValue({
        success: true,
        objectPath: 'user-123/test.jpg',
        fileMetadata: createMockFileMetadata(),
      });
      mockExecuteCreateArtifactStep.mockResolvedValue({
        success: true,
        artifactId: TEST_ARTIFACT_ID,
      });
      mockExecuteAnalyzeStep.mockResolvedValue({
        success: true,
        analysisResult: {
          intent: 'meeting_notes',
          confidence: 0.9,
          entities_mentioned: [],
          actions_suggested: [],
          topics: [],
          sentiment: 'neutral',
        },
      });
      mockExecuteFinalizeStep.mockResolvedValue({
        success: false,
        error: 'Finalize failed',
      });

      const result = await executeWorkflow(TEST_WORKFLOW_ID, createMockFile(), createMockUserContext());
      expect(result.status).toBe('failed');
      expect(result.failedStep).toBe('finalize');

      await Sentry.flush(1000);

      const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
      expect(transactionEvent).toBeDefined();

      // Before the fix: `runStep`'s finalize-failure branch returned without
      // calling trackStepCompletion, exactly like the upload branch above --
      // the finalize step's span would never end.
      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      const finalizeSpan = stepSpans.find((s) => s.data?.step_type === 'finalize');
      expect(finalizeSpan).toBeDefined();
      expect(finalizeSpan?.op).toBe('workflow.step');
      expect(finalizeSpan?.data).toMatchObject({ status: 'failed', error: 'Finalize failed' });
      expect(finalizeSpan?.status).toBe('internal_error');
    });
  });

  // #794: organize_entities' own awaiting_user branch was missing the
  // trackStepCompletion call that #787 added to upload/finalize/analyze's
  // awaiting_user branches -- found while fixing #787, filed separately since
  // #787 didn't name it. #796: executeWorkflow's fallback trackStepCompletion
  // (the same one exercised by the #787 tests above when a step returns
  // `null`) stamped a literal 'completed' on every span it closed, so a step
  // that fails via `break` rather than `return` -- e.g. create_artifact's
  // missing-objectPath path -- got its span marked successful despite the DB
  // recording it as 'failed'.
  describe('organize_entities awaiting_user span and break-path failure outcomes (#794, #796)', () => {
    it('ends the organize_entities step span when it pauses for user disambiguation (awaiting_user) (#794)', async () => {
      const workflow = createMockWorkflow({
        id: TEST_WORKFLOW_ID,
        status: 'pending',
        source_artifact_id: TEST_ARTIFACT_ID,
      });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', [
        createCompletedAnalyzeStep({
          entities_mentioned: [{ name: 'Alice', type: 'people', confidence: 0.9 }],
        }),
      ]);

      mockExecuteOrganizeEntitiesStep.mockResolvedValue({
        success: true,
        status: 'awaiting_user',
        entitiesLinked: [],
        entitiesCreated: [],
        notificationsCreated: [],
      });

      const result = await executeWorkflow(TEST_WORKFLOW_ID);
      expect(result.status).toBe('awaiting_user');

      await Sentry.flush(1000);

      const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
      expect(transactionEvent).toBeDefined();

      // Before the fix: this early return skipped trackStepCompletion
      // entirely (unlike the `analyze` awaiting_user branch immediately
      // above it in orchestrator.ts), so the root span still ends and the
      // transaction still flushes -- but with organize_entities missing from
      // its children: no duration_ms, no status attribute.
      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      const organizeSpan = stepSpans.find((s) => s.data?.step_type === 'organize_entities');
      expect(organizeSpan).toBeDefined();
      expect(organizeSpan?.op).toBe('workflow.step');
      expect(organizeSpan?.data).toMatchObject({ status: 'awaiting_user' });
      expect(organizeSpan?.status).toBe('ok');
    });

    it('marks a break-path step failure with its real outcome, not a literal completed status (create_artifact missing objectPath) (#796)', async () => {
      const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);

      // Upload "succeeds" but returns no objectPath/fileMetadata, and the
      // freshly created create_artifact step has no `input` fallback either
      // -- reproducing the ":250-261" break site named in #796: `runStep`
      // marks the DB status 'failed' and `break`s (no throw, no return), so
      // this falls through to executeWorkflow's fallback trackStepCompletion.
      mockExecuteUploadStep.mockResolvedValue({ success: true });

      await executeWorkflow(TEST_WORKFLOW_ID, createMockFile(), createMockUserContext());

      await Sentry.flush(1000);

      const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
      expect(transactionEvent).toBeDefined();

      // Before the fix: the fallback stamped a literal 'completed' on every
      // span it closed, so this span would read 'completed'/'ok' despite the
      // step's own DB status being 'failed'.
      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      const createArtifactSpan = stepSpans.find((s) => s.data?.step_type === 'create_artifact');
      expect(createArtifactSpan).toBeDefined();
      expect(createArtifactSpan?.data).toMatchObject({ status: 'failed' });
      expect(createArtifactSpan?.status).toBe('internal_error');
    });

    it('marks organize_entities failing without throwing with a failed status, not completed (#796)', async () => {
      const workflow = createMockWorkflow({
        id: TEST_WORKFLOW_ID,
        status: 'pending',
        source_artifact_id: TEST_ARTIFACT_ID,
      });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', [
        createCompletedAnalyzeStep({
          entities_mentioned: [{ name: 'Alice', type: 'people', confidence: 0.9 }],
        }),
      ]);

      // The ":381-383" break site named in #796: organizeResult.success is
      // false, so the branch `skippedSteps.push(...)`es and falls through to
      // the shared `break` at the end of the switch case instead of
      // returning -- same fallback path as the create_artifact case above.
      mockExecuteOrganizeEntitiesStep.mockResolvedValue({
        success: false,
        entitiesLinked: [],
        entitiesCreated: [],
        notificationsCreated: [],
        error: 'Organize entities failed',
      });
      // organize_entities failing (via `break`, not `return`) doesn't halt
      // the workflow, so extract_actions/create_derived still run against
      // the same seeded analysisResult -- mocked to succeed so this test's
      // assertions stay scoped to the organize_entities span alone.
      mockExecuteExtractActionsStep.mockResolvedValue({ success: true, tasksCreated: [] });
      mockExecuteCreateDerivedArtifactStep.mockResolvedValue({ success: true });

      await executeWorkflow(TEST_WORKFLOW_ID);

      await Sentry.flush(1000);

      const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
      expect(transactionEvent).toBeDefined();

      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      const organizeSpan = stepSpans.find((s) => s.data?.step_type === 'organize_entities');
      expect(organizeSpan).toBeDefined();
      expect(organizeSpan?.data).toMatchObject({ status: 'failed' });
      expect(organizeSpan?.status).toBe('internal_error');
    });

    it('marks extract_actions failing without throwing with a failed status, not completed (#796)', async () => {
      const workflow = createMockWorkflow({
        id: TEST_WORKFLOW_ID,
        status: 'pending',
        source_artifact_id: TEST_ARTIFACT_ID,
      });
      setMockData('workflows', [workflow]);
      // No entities, so organize_entities takes its own "nothing to organize"
      // skip branch (already correctly marked 'skipped', not this test's
      // concern) without needing executeOrganizeEntitiesStep mocked.
      setMockData('workflow_steps', [
        createCompletedAnalyzeStep({
          entities_mentioned: [],
          actions_suggested: [{ title: 'Follow up' }],
        }),
      ]);

      // The ":429-431" break site named in #796: extractResult.success is
      // false, `skippedSteps.push(...)`, falls through to the shared break.
      mockExecuteExtractActionsStep.mockResolvedValue({
        success: false,
        tasksCreated: [],
        error: 'Extract actions failed',
      });
      // extract_actions failing doesn't halt the workflow either -- mock
      // create_derived to succeed so this test's assertions stay scoped to
      // the extract_actions span alone.
      mockExecuteCreateDerivedArtifactStep.mockResolvedValue({ success: true });

      await executeWorkflow(TEST_WORKFLOW_ID);

      await Sentry.flush(1000);

      const transactionEvent = findWorkflowTransaction(capturedEnvelopes);
      expect(transactionEvent).toBeDefined();

      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      const extractSpan = stepSpans.find((s) => s.data?.step_type === 'extract_actions');
      expect(extractSpan).toBeDefined();
      expect(extractSpan?.data).toMatchObject({ status: 'failed' });
      expect(extractSpan?.status).toBe('internal_error');
    });
  });
});
