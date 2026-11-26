import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

vi.mock("../lib/supabase.js", () => {
  return {
    isSupabaseConfigured: true,
    supabase: {
      from: vi.fn(),
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              access_token: "test-priority-inbox-token",
              user: { id: "00000000-0000-4000-a000-000000000001" },
            },
          },
        })),
      },
    },
  };
});

import {
  PriorityInboxCanvas,
  CURATED_INBOX_ROUTES,
  SWEPT_INBOX_ROUTES,
  DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT,
  DEFAULT_PRIORITY_INBOX_THREADS,
  buildGmailDraftUrl,
  captureDailyEmailFlowActionClient,
  filterAndPartitionInboxThreads,
  gmailUnsubscribeBatchActionClient,
  loadStoredDailyEmailFlowSnapshots,
  persistDailyEmailFlowSnapshot,
  reconcilePromotionWithProcessedState,
  selectActiveDomainFlow,
  submitTriageCorrection,
  submitUnsubscribeBatch,
  reviewLessonRecordActionClient,
  type PriorityInboxThread,
} from "../components/inbox/PriorityInboxCanvas.js";
import {
  DashboardCanvas,
  loadLatestStoredDailyEmailFlowSnapshot,
  parseStoredDailyEmailFlowSnapshot,
} from "../components/dashboard/DashboardCanvas.js";
import {
  applyProcessedDeltaToSnapshot,
  DAILY_EMAIL_FLOW_FORMULA,
  EMAIL_INTENT_CATEGORIES,
} from "@ahkms/core";
import { getTabFromPathname, TAB_PATHS } from "../lib/router.js";
import {
  getScreenState,
  resetScreenStateForTesting,
  setInboxScreen,
  setScreenTab,
} from "../lib/screenState.js";
import { supabase } from "../lib/supabase.js";

const cleanRender = (el: React.ReactElement): string =>
  renderToString(el).replace(/<!-- -->/g, "");

describe("Curated Priority Inbox View (#2014 / #1990)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    resetScreenStateForTesting();
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    resetScreenStateForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers the inbox tab in router.ts and screenState.ts", () => {
    expect(TAB_PATHS.inbox).toBe("/inbox");
    expect(getTabFromPathname("/inbox")).toBe("inbox");
    expect(getTabFromPathname("/priority-inbox")).toBe("inbox");

    setScreenTab("inbox");
    setInboxScreen({
      domain: "all",
      cut_line: 5,
      intent_filter: null,
      curated_count: 5,
      swept_count: 4,
      drawer_open: true,
    });

    const state = getScreenState();
    expect(state?.tab).toBe("inbox");
    expect(state?.path).toBe("/inbox");
    expect(state?.inbox).toEqual({
      domain: "all",
      cut_line: 5,
      intent_filter: null,
      curated_count: 5,
      swept_count: 4,
      drawer_open: true,
    });
  });

  it("renders domain filter toggle (All | Work | Personal), cut-line selector (default 5+), and all 8 intent badges", () => {
    const html = cleanRender(<PriorityInboxCanvas />);

    expect(html).toContain("Curated Priority Inbox");
    expect(html).toContain("5+ Cut-Line");
    expect(html).toContain('data-testid="domain-filter-all"');
    expect(html).toContain('data-testid="domain-filter-work"');
    expect(html).toContain('data-testid="domain-filter-personal"');
    expect(html).toContain("All");
    expect(html).toContain("Work");
    expect(html).toContain("Personal");

    // Verify all 8 semantic intent categories are represented in the filter bar and thread cards
    for (const category of EMAIL_INTENT_CATEGORIES) {
      expect(html).toContain(`data-testid="intent-filter-${category}"`);
      expect(html).toContain(`[${category}]`);
    }

    // Verify curated high-priority thread cards show 1..7 badge, sender, subject, snippet, and linked entities
    expect(html).toContain("P7 Critical (7/7)");
    expect(html).toContain("P6 Urgent (6/7)");
    expect(html).toContain("P5 High (5/7)");
    expect(html).toContain("Cut-line 5+ High (1..7)");
    expect(html).toContain("Dr. Sarah Chen");
    expect(html).toContain("Urgent: Clinical pilot sign-off &amp; MSA redlines before Friday");
    expect(html).toContain("Work Clinical Pilot");
    expect(html).toContain("Sign off Clinical Pilot MSA");
  });

  it("filters curated and swept threads by domain (All vs Work vs Personal)", () => {
    const allResult = filterAndPartitionInboxThreads(DEFAULT_PRIORITY_INBOX_THREADS, {
      domain: "all",
      cutLine: 5,
    });
    expect(allResult.curated).toHaveLength(5);
    expect(allResult.swept).toHaveLength(4);

    const workHtml = cleanRender(<PriorityInboxCanvas initialDomain="work" />);
    expect(workHtml).toContain("3 High-Priority (5+)");
    expect(workHtml).toContain("2 Swept (1..4)");
    expect(workHtml).toContain("Urgent: Clinical pilot sign-off");
    expect(workHtml).toContain("Board prep &amp; Q4 runway review rescheduled");
    expect(workHtml).not.toContain("Action required: signed completion statement");
    expect(workHtml).not.toContain("Top 10 AI growth playbooks this month");

    const personalHtml = cleanRender(<PriorityInboxCanvas initialDomain="personal" />);
    expect(personalHtml).toContain("2 High-Priority (5+)");
    expect(personalHtml).toContain("2 Swept (1..4)");
    expect(personalHtml).toContain("Action required: signed completion statement");
    expect(personalHtml).toContain("Commented on: Knowledge Graph Ontology v2 draft");
    expect(personalHtml).not.toContain("Urgent: Clinical pilot sign-off");
  });

  it("re-partitions curated vs swept threads when the priority cut-line threshold changes", () => {
    // Lowering cut-line to 4 promotes P4 thread (thread-hl-004) into curated
    const cutLine4 = filterAndPartitionInboxThreads(DEFAULT_PRIORITY_INBOX_THREADS, {
      domain: "all",
      cutLine: 4,
    });
    expect(cutLine4.curated.map((t) => t.id)).toContain("thread-hl-004");
    expect(cutLine4.swept.map((t) => t.id)).not.toContain("thread-hl-004");
    expect(cutLine4.curated).toHaveLength(6);
    expect(cutLine4.swept).toHaveLength(3);

    const htmlAt4 = cleanRender(<PriorityInboxCanvas initialCutLine={4} />);
    expect(htmlAt4).toContain("6 High-Priority (4+)");
    expect(htmlAt4).toContain("3 Swept (1..3)");

    // Raising cut-line to 6 moves P5 threads into the sweep audit drawer
    const cutLine6 = filterAndPartitionInboxThreads(DEFAULT_PRIORITY_INBOX_THREADS, {
      domain: "all",
      cutLine: 6,
    });
    expect(cutLine6.curated).toHaveLength(3);
    expect(cutLine6.swept).toHaveLength(6);
    expect(cutLine6.curated.every((t) => t.priority >= 6)).toBe(true);

    const htmlAt6 = cleanRender(<PriorityInboxCanvas initialCutLine={6} />);
    expect(htmlAt6).toContain("3 High-Priority (6+)");
    expect(htmlAt6).toContain("6 Swept (1..5)");
  });

  it("renders high-priority (>= cutLine) threads uncapped in priority-descending, newest-first order", () => {
    const manyHighPriorityThreads: PriorityInboxThread[] = Array.from(
      { length: 25 },
      (_, idx) => {
        const priority = 5 + (idx % 3); // 5, 6, or 7
        const hour = String(idx % 24).padStart(2, "0");
        return {
          id: `uncapped-thread-${idx + 1}`,
          threadId: `gmail-uncapped-${idx + 1}`,
          decisionId: `22222222-2222-4222-a222-${String(idx + 1).padStart(12, "0")}`,
          domain: idx % 2 === 0 ? "work" : "personal",
          sender: `Sender ${idx + 1} <sender${idx + 1}@example.com>`,
          subject: `Uncapped High Priority Subject #${idx + 1}`,
          snippet: `Important triage snippet for thread ${idx + 1}`,
          receivedAt: `2026-10-26T${hour}:00:00Z`,
          intentCategory: EMAIL_INTENT_CATEGORIES[idx % EMAIL_INTENT_CATEGORIES.length],
          priority,
          linkedEntities: [
            {
              id: `ent-${idx + 1}`,
              title: `Entity ${idx + 1}`,
              entityType: "project",
              hot: priority === 7,
            },
          ],
        };
      },
    );

    const partitioned = filterAndPartitionInboxThreads(manyHighPriorityThreads, {
      cutLine: 5,
    });
    expect(partitioned.curated).toHaveLength(25);

    // Verify priority-descending, then newest-first ordering
    for (let i = 1; i < partitioned.curated.length; i++) {
      const prev = partitioned.curated[i - 1];
      const curr = partitioned.curated[i];
      expect(prev.priority).toBeGreaterThanOrEqual(curr.priority);
      if (prev.priority === curr.priority) {
        expect(Date.parse(prev.receivedAt)).toBeGreaterThanOrEqual(
          Date.parse(curr.receivedAt),
        );
      }
    }

    const html = cleanRender(
      <PriorityInboxCanvas initialThreads={manyHighPriorityThreads} initialCutLine={5} />,
    );
    expect(html).toContain("25 High-Priority (5+)");
    for (let i = 1; i <= 25; i++) {
      expect(html).toContain(`Uncapped High Priority Subject #${i}`);
    }
  });

  it("supports collapsing and expanding the sweep audit drawer", () => {
    const openHtml = cleanRender(
      <PriorityInboxCanvas initialSweepDrawerOpen={true} />,
    );
    expect(openHtml).toContain('data-testid="sweep-audit-drawer-content"');
    expect(openHtml).toContain('data-testid="correct-thread-thread-hl-004"');

    const collapsedHtml = cleanRender(
      <PriorityInboxCanvas initialSweepDrawerOpen={false} />,
    );
    expect(collapsedHtml).not.toContain('data-testid="sweep-audit-drawer-content"');
    expect(collapsedHtml).toContain("Inspect Swept Threads (4)");
  });

  it("dispatches one-click correction to POST /api/actions/review_lesson_record and promotes the thread", async () => {
    expect(reviewLessonRecordActionClient.run).toBeUndefined();

    const sweptThread = DEFAULT_PRIORITY_INBOX_THREADS.find(
      (t) => t.id === "thread-hl-004",
    )!;
    expect(sweptThread.priority).toBe(4);

    const mockFetch = vi.fn(
      async (
        _url: string,
        _init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "lesson-uuid-999",
            subject_key: "email_triage:gmail-th-hl-004",
            cooling_off_until: "2026-11-09T15:00:00.000Z",
          }),
        } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await submitTriageCorrection({
      thread: sweptThread,
      cutLine: 5,
      newPriority: 6,
      newIntentCategory: "to_respond",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, callInit] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
    ];
    expect(calledUrl).toBe(`${API_BASE}/review_lesson_record`);
    expect(callInit.method).toBe("POST");

    const headers = callInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-priority-inbox-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Action-Caller"]).toBe("ui");

    const parsedBody = JSON.parse(callInit.body as string);
    expect(parsedBody).toEqual({
      decision_id: sweptThread.decisionId,
      category: "wrong",
      summary: expect.stringContaining("priority 4 -> 6, intent fyi -> to_respond"),
    });

    expect(result.lesson.id).toBe("lesson-uuid-999");
    expect(result.updatedThread.priority).toBe(6);
    expect(result.updatedThread.intentCategory).toBe("to_respond");
    expect(result.updatedThread.storageTier).toBe("tier_3_full_artifact");
    expect(result.updatedThread.gmailAction).toBe("keep_inbox");
    expect(result.updatedThread.corrected).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("renders Daily Email Flow Waterfall (Starting, New Today, Processed, End) for Personal, Work, and Combined", () => {
    const html = cleanRender(<PriorityInboxCanvas />);

    expect(html).toContain('data-testid="daily-email-flow-section"');
    expect(html).toContain('data-testid="daily-email-flow-breakdown-table"');
    expect(html).toContain(DAILY_EMAIL_FLOW_FORMULA);
    expect(html).toContain("Scope: in:inbox is:unread");

    // Combined (All) default: Starting 210 + New Today 40 - Processed 0 = End 250
    expect(html).toContain('data-testid="flow-all-starting"');
    expect(html).toContain('data-testid="flow-personal-starting"');
    expect(html).toContain('data-testid="flow-work-starting"');
    expect(html).toContain("Personal (angus)");
    expect(html).toContain("Work (work)");
    expect(html).toContain("Combined (All Inboxes)");

    // Domain selection helper returns per-inbox or combined metrics
    expect(selectActiveDomainFlow(DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT, "all")).toMatchObject({
      account: "all",
      starting: 210,
      new_today: 40,
      processed_today: 0,
      end: 250,
    });
    expect(selectActiveDomainFlow(DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT, "personal")).toMatchObject({
      account: "personal",
      starting: 130,
      new_today: 24,
      processed_today: 0,
      end: 154,
    });
    expect(selectActiveDomainFlow(DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT, "work")).toMatchObject({
      account: "work",
      starting: 80,
      new_today: 16,
      processed_today: 0,
      end: 96,
    });

    // When threads are processed, Processed goes up and End goes down
    const afterProcessing = applyProcessedDeltaToSnapshot(
      applyProcessedDeltaToSnapshot(DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT, "personal", 14, {
        isSwept: true,
      }),
      "work",
      6,
      { isSwept: false },
    );

    const updatedHtml = cleanRender(
      <PriorityInboxCanvas initialDailyFlow={afterProcessing} />,
    );
    expect(afterProcessing.personal.processed_today).toBe(14);
    expect(afterProcessing.personal.end).toBe(140);
    expect(afterProcessing.work.processed_today).toBe(6);
    expect(afterProcessing.work.end).toBe(90);
    expect(afterProcessing.combined.processed_today).toBe(20);
    expect(afterProcessing.combined.end).toBe(230);
    expect(updatedHtml).toContain("230");
  });

  it("surfaces the Daily Email Flow Waterfall card on DashboardCanvas", () => {
    const dashboardHtml = cleanRender(<DashboardCanvas autoLoad={false} />);
    expect(dashboardHtml).toContain('data-testid="kpi-daily-email-flow-section"');
    expect(dashboardHtml).toContain('data-testid="kpi-email-flow-card-personal"');
    expect(dashboardHtml).toContain('data-testid="kpi-email-flow-card-work"');
    expect(dashboardHtml).toContain('data-testid="kpi-email-flow-card-all"');
    expect(dashboardHtml).toContain("Personal Inbox (angus)");
    expect(dashboardHtml).toContain("Work Inbox (work)");
    expect(dashboardHtml).toContain("Combined (All Inboxes)");
  });

  it("persists Daily Email Flow Scorecard updates via POST /api/actions/capture and loads stored scorecards from public.artifacts", async () => {
    expect(captureDailyEmailFlowActionClient.id).toBe("capture");
    expect(captureDailyEmailFlowActionClient.run).toBeUndefined();

    const updatedSnapshot = applyProcessedDeltaToSnapshot(
      DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT,
      "personal",
      12,
      { isSwept: true },
    );

    const mockFetch = vi.fn(
      async (
        _url: string,
        _init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "artifact-email-flow-2026-11-07",
            title: "Daily Email Flow Scorecard — 2026-11-07",
            deduplicated: true,
            updated: true,
          }),
        } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const saved = await persistDailyEmailFlowSnapshot(updatedSnapshot);
    expect(saved.id).toBe("artifact-email-flow-2026-11-07");
    expect(saved.updated).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, callInit] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
    ];
    expect(calledUrl).toBe(`${API_BASE}/capture`);
    expect(callInit.method).toBe("POST");

    const parsedBody = JSON.parse(callInit.body as string);
    expect(parsedBody).toMatchObject({
      title: "Daily Email Flow Scorecard — 2026-11-07",
      content_subtype: "daily_email_flow_scorecard",
      surface: "kpi_snapshot",
      dedup_key: "kpi_email_daily:2026-11-07",
      tags: ["metrics", "kpi_snapshot", "email_flow", "date:2026-11-07"],
    });
    expect(parsedBody.processing_metadata.daily_email_flow.personal.processed_today).toBe(12);
    expect(parsedBody.processing_metadata.daily_email_flow.personal.end).toBe(142);
    expect(parsedBody.processing_metadata.daily_email_flow.combined.processed_today).toBe(12);
    expect(parsedBody.processing_metadata.daily_email_flow.combined.end).toBe(238);

    // Mock public.artifacts read for loadStoredDailyEmailFlowSnapshots
    const priorSnapshot = applyProcessedDeltaToSnapshot(
      {
        ...DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT,
        date_key: "2026-11-06",
      },
      "work",
      5,
    );
    const limitMock = vi.fn(async () => ({
      data: [
        {
          id: "art-2026-11-07",
          dedup_key: "kpi_email_daily:2026-11-07",
          surface: "kpi_snapshot",
          content_subtype: "daily_email_flow_scorecard",
          processing_metadata: {
            date_key: "2026-11-07",
            daily_email_flow: { ...updatedSnapshot, history: undefined },
          },
        },
        {
          id: "art-2026-11-06",
          dedup_key: "kpi_email_daily:2026-11-06",
          surface: "kpi_snapshot",
          content_subtype: "daily_email_flow_scorecard",
          processing_metadata: {
            date_key: "2026-11-06",
            daily_email_flow: { ...priorSnapshot, history: undefined },
          },
        },
      ],
      error: null,
    }));
    const orderMock = vi.fn(() => ({ limit: limitMock }));
    const eqMock = vi.fn(() => ({ order: orderMock }));
    const selectMock = vi.fn(() => ({ eq: eqMock }));
    vi.mocked(supabase.from).mockReturnValue({
      select: selectMock,
    } as never);

    const loaded = await loadStoredDailyEmailFlowSnapshots(14, {
      forceLoad: true,
    });
    expect(supabase.from).toHaveBeenCalledWith("artifacts");
    expect(eqMock).toHaveBeenCalledWith(
      "content_subtype",
      "daily_email_flow_scorecard",
    );
    expect(loaded).toHaveLength(2);
    expect(loaded[0].date_key).toBe("2026-11-07");
    expect(loaded[0].combined.processed_today).toBe(12);
    expect(loaded[0].combined.end).toBe(238);
    expect(loaded[0].history?.map((h) => h.date_key)).toEqual([
      "2026-11-06",
      "2026-11-07",
    ]);

    // Verify DashboardCanvas helper loads and parses the latest daily_email_flow_scorecard artifact
    const latestFromDashboard = await loadLatestStoredDailyEmailFlowSnapshot();
    expect(latestFromDashboard?.date_key).toBe("2026-11-07");
    expect(latestFromDashboard?.personal.processed_today).toBe(12);
    expect(latestFromDashboard?.combined.end).toBe(238);

    const parsedRow = parseStoredDailyEmailFlowSnapshot({
      id: "art-2026-11-07",
      dedup_key: "kpi_email_daily:2026-11-07",
      content_subtype: "daily_email_flow_scorecard",
      processing_metadata: {
        date_key: "2026-11-07",
        daily_email_flow: updatedSnapshot,
      },
    });
    expect(parsedRow?.combined.end).toBe(238);
  });

  it("reverses a swept thread's processed state and decrements dailyFlow when promoted above cutLine via One-Click Override", async () => {
    const sweptWorkThread = DEFAULT_PRIORITY_INBOX_THREADS.find(
      (t) => t.id === "thread-hl-004",
    )!;
    expect(sweptWorkThread.domain).toBe("work");
    expect(sweptWorkThread.priority).toBe(4);

    // 1. Simulate "Process Swept Batch" marking the 4 swept threads (2 work, 2 personal) processed
    const partitioned = filterAndPartitionInboxThreads(DEFAULT_PRIORITY_INBOX_THREADS, {
      cutLine: 5,
    });
    let processedMap: Record<string, boolean> = {};
    let flowAfterBatch = DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT;
    for (const swept of partitioned.swept) {
      processedMap[swept.id] = true;
      flowAfterBatch = applyProcessedDeltaToSnapshot(
        flowAfterBatch,
        swept.domain,
        1,
        { isSwept: true },
      );
    }

    expect(flowAfterBatch.work.processed_today).toBe(2);
    expect(flowAfterBatch.work.swept_today).toBe(2);
    expect(flowAfterBatch.work.end).toBe(94);
    expect(flowAfterBatch.combined.processed_today).toBe(4);
    expect(flowAfterBatch.combined.end).toBe(246);

    const htmlAfterBatch = cleanRender(
      <PriorityInboxCanvas
        initialDailyFlow={flowAfterBatch}
        initialProcessedThreadIds={processedMap}
        autoLoadDailyFlow={false}
      />,
    );
    expect(htmlAfterBatch).toContain("Process Swept Batch (0)");

    // 2. Promote `thread-hl-004` above cutLine (priority 4 -> 6) via submitTriageCorrection
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "lesson-uuid-promote",
        subject_key: "email_triage:gmail-th-hl-004",
        cooling_off_until: "2026-11-09T15:00:00.000Z",
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", mockFetch);

    const correction = await submitTriageCorrection({
      thread: sweptWorkThread,
      cutLine: 5,
      newPriority: 6,
      newIntentCategory: "to_respond",
    });
    expect(correction.updatedThread.priority).toBe(6);

    const reconciled = reconcilePromotionWithProcessedState(
      {
        processedThreadIds: processedMap,
        dailyFlow: flowAfterBatch,
      },
      correction.updatedThread,
      5,
    );

    expect(reconciled.reversed).toBe(true);
    expect(reconciled.processedThreadIds["thread-hl-004"]).toBeUndefined();
    expect(reconciled.dailyFlow.work.processed_today).toBe(1);
    expect(reconciled.dailyFlow.work.swept_today).toBe(1);
    expect(reconciled.dailyFlow.work.end).toBe(95);
    expect(reconciled.dailyFlow.combined.processed_today).toBe(3);
    expect(reconciled.dailyFlow.combined.end).toBe(247);
  });

  it("groups threads by ADR-118 routes (draft_reply, attention, review in curated; digest, unsubscribe_candidate, calendar, awaiting_reply, archive in swept)", () => {
    expect(CURATED_INBOX_ROUTES).toEqual([
      "draft_reply",
      "attention",
      "review",
    ]);
    expect(SWEPT_INBOX_ROUTES).toEqual([
      "digest",
      "unsubscribe_candidate",
      "calendar",
      "awaiting_reply",
      "archive",
    ]);

    // Include a low-priority (P3) thread gated into `review` by HITL policy — it must stay in curated `review`
    const threadsWithLowPriorityReview: PriorityInboxThread[] = [
      ...DEFAULT_PRIORITY_INBOX_THREADS,
      {
        id: "thread-hitl-review-low-prio",
        threadId: "gmail-th-hitl-low-prio",
        decisionId: "11111111-1111-4111-a111-000000000099",
        domain: "personal",
        sender: "HM Land Registry <noreply@example.com>",
        subject: "Statutory Notice: Title Register Update",
        snippet: "Please review the statutory title update notice within 14 days.",
        receivedAt: "2026-10-26T10:30:00Z",
        intentCategory: "fyi",
        priority: 3,
        confidence: 0.58,
        route: "review",
        naturalRoute: "digest",
        thinkingMode: "system_2",
        requiresHuman: true,
        hitlReasons: [
          "low_confidence:0.58<0.75",
          "high_stakes_keyword:statutory",
        ],
        rationale:
          "Low classifier confidence on a statutory land registry notice; held in review for human verification.",
        linkedEntities: [],
      },
    ];

    const partitioned = filterAndPartitionInboxThreads(
      threadsWithLowPriorityReview,
      { cutLine: 5 },
    );

    // 5 default curated + 1 low-priority `review` thread = 6 curated
    expect(partitioned.curated).toHaveLength(6);
    expect(partitioned.curatedByRoute.draft_reply.map((t) => t.id)).toEqual([
      "thread-hl-001",
      "thread-ps-001",
    ]);
    expect(partitioned.curatedByRoute.attention.map((t) => t.id)).toEqual([
      "thread-hl-002",
      "thread-hl-003",
    ]);
    expect(partitioned.curatedByRoute.review.map((t) => t.id)).toEqual([
      "thread-ps-002",
      "thread-hitl-review-low-prio",
    ]);

    // Swept routes: digest (1), unsubscribe_candidate (1), calendar (1), archive (1)
    expect(partitioned.swept).toHaveLength(4);
    expect(partitioned.sweptByRoute.digest.map((t) => t.id)).toEqual([
      "thread-hl-004",
    ]);
    expect(
      partitioned.sweptByRoute.unsubscribe_candidate.map((t) => t.id),
    ).toEqual(["thread-ps-004"]);
    expect(partitioned.sweptByRoute.calendar.map((t) => t.id)).toEqual([
      "thread-ps-003",
    ]);
    expect(partitioned.sweptByRoute.archive.map((t) => t.id)).toEqual([
      "thread-hl-005",
    ]);

    // Route filter isolates a single ADR-118 route
    const onlyDraftReply = filterAndPartitionInboxThreads(
      threadsWithLowPriorityReview,
      { cutLine: 5, routeFilter: "draft_reply" },
    );
    expect(onlyDraftReply.curated).toHaveLength(2);
    expect(onlyDraftReply.swept).toHaveLength(0);

    const html = cleanRender(
      <PriorityInboxCanvas
        initialThreads={threadsWithLowPriorityReview}
        autoLoadDailyFlow={false}
      />,
    );
    expect(html).toContain('data-testid="route-group-draft_reply"');
    expect(html).toContain('data-testid="route-group-attention"');
    expect(html).toContain('data-testid="route-group-review"');
    expect(html).toContain('data-testid="route-group-digest"');
    expect(html).toContain('data-testid="route-group-unsubscribe_candidate"');
    expect(html).toContain('data-testid="route-group-calendar"');
    expect(html).toContain('data-testid="route-group-archive"');
  });

  it("renders the daily attention-budget headline ('N of 15 today'), overflow badge on overBudget threads, and System 1/2 + rationale + hitlReasons pills", () => {
    const defaultHtml = cleanRender(
      <PriorityInboxCanvas autoLoadDailyFlow={false} />,
    );
    expect(defaultHtml).toContain('data-testid="attention-budget-headline"');
    expect(defaultHtml).toContain("Attention Budget: 5 of 15 today");
    expect(defaultHtml).not.toContain(
      'data-testid="attention-budget-overflow-badge"',
    );

    // Verify thinkingMode, rationale, and hitlReasons on curated cards
    expect(defaultHtml).toContain(
      'data-testid="thinking-mode-badge-thread-hl-001"',
    );
    expect(defaultHtml).toContain("System 2 (Deep HITL) [system_2]");
    expect(defaultHtml).toContain(
      'data-testid="thinking-mode-badge-thread-ps-003"',
    );
    expect(defaultHtml).toContain("System 1 (Fast Triage) [system_1]");
    expect(defaultHtml).toContain(
      'data-testid="thread-rationale-thread-hl-001"',
    );
    expect(defaultHtml).toContain(
      "Clinical partner requesting final MSA redline and Friday cohort timeline sign-off; System 2 prepared a reply draft.",
    );
    expect(defaultHtml).toContain(
      'data-testid="hitl-reason-thread-hl-001-route:draft_reply"',
    );
    expect(defaultHtml).toContain(
      'data-testid="hitl-reason-thread-ps-002-mid_confidence_high_stakes"',
    );

    // Render with an overflow thread (`overBudget: true`) and custom budget cap
    const overBudgetThreads: PriorityInboxThread[] =
      DEFAULT_PRIORITY_INBOX_THREADS.map((t, index) =>
        index === 4 ? { ...t, overBudget: true } : t,
      );

    const overflowHtml = cleanRender(
      <PriorityInboxCanvas
        initialThreads={overBudgetThreads}
        attentionBudget={4}
        autoLoadDailyFlow={false}
      />,
    );
    expect(overflowHtml).toContain("Attention Budget: 5 of 4 today");
    expect(overflowHtml).toContain(
      'data-testid="attention-budget-overflow-badge"',
    );
    expect(overflowHtml).toContain("Over Attention Budget (1 overflow)");
    expect(overflowHtml).toContain(
      'data-testid="over-budget-badge-thread-ps-002"',
    );
  });

  it("renders in-place draftReply preview and Gmail draft link on draft_reply cards while keeping send gated", () => {
    const html = cleanRender(<PriorityInboxCanvas autoLoadDailyFlow={false} />);

    // Both `draft_reply` threads render draft preview panels with draft body, draft ID, and gated send notice
    expect(html).toContain('data-testid="draft-preview-panel-thread-hl-001"');
    expect(html).toContain('data-testid="draft-id-badge-thread-hl-001"');
    expect(html).toContain("Draft ID: draft-hl-001");
    expect(html).toContain('data-testid="draft-send-gate-badge-thread-hl-001"');
    expect(html).toContain("Send Gated · Owner Review Required");
    expect(html).toContain('data-testid="draft-reply-body-thread-hl-001"');
    expect(html).toContain(
      "Thanks for sending over the MSA redlines. I have reviewed the data processing addendum and confirmed the Friday onboarding timeline for the first cohort.",
    );
    expect(html).toContain('data-testid="open-gmail-draft-thread-hl-001"');

    const hlDraftThread = DEFAULT_PRIORITY_INBOX_THREADS.find(
      (t) => t.id === "thread-hl-001",
    )!;
    expect(buildGmailDraftUrl(hlDraftThread)).toBe(
      "https://mail.google.com/mail/u/1/#drafts?compose=draft-hl-001",
    );

    const psDraftThread = DEFAULT_PRIORITY_INBOX_THREADS.find(
      (t) => t.id === "thread-ps-001",
    )!;
    expect(buildGmailDraftUrl(psDraftThread)).toBe(
      "https://mail.google.com/mail/u/0/#drafts?compose=draft-ps-001",
    );
  });

  it("dispatches one-click batch unsubscribe to POST /api/actions/gmail_unsubscribe_batch via executeActionClient", async () => {
    expect(gmailUnsubscribeBatchActionClient.id).toBe(
      "gmail_unsubscribe_batch",
    );
    expect(gmailUnsubscribeBatchActionClient.run).toBeUndefined();

    const html = cleanRender(<PriorityInboxCanvas autoLoadDailyFlow={false} />);
    expect(html).toContain('data-testid="unsubscribe-batch-bar"');
    expect(html).toContain('data-testid="unsubscribe-batch-btn"');
    expect(html).toContain("Unsubscribe &amp; Archive Batch (1)");

    const unsubCandidates = DEFAULT_PRIORITY_INBOX_THREADS.filter(
      (t) => t.route === "unsubscribe_candidate",
    );
    expect(unsubCandidates).toHaveLength(1);

    const mockFetch = vi.fn(
      async (
        _url: string,
        _init?: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            label: "ahOS/Unsubscribe",
            dry_run: false,
            requested_count: 1,
            processed_count: 1,
            labeled_count: 1,
            archived_count: 1,
            results: [
              {
                thread_id: "gmail-th-ps-004",
                message_id: "gmail-msg-ps-004",
                account: "personal",
                labeled: true,
                archived: true,
              },
            ],
            errors: [],
          }),
        } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const batchResult = await submitUnsubscribeBatch({
      threads: unsubCandidates,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, callInit] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
    ];
    expect(calledUrl).toBe(`${API_BASE}/gmail_unsubscribe_batch`);
    expect(callInit.method).toBe("POST");

    const parsedBody = JSON.parse(callInit.body as string);
    expect(parsedBody).toEqual({
      threads: [
        {
          thread_id: "gmail-th-ps-004",
          message_id: "gmail-msg-ps-004",
          account: "personal",
          domain: "personal",
          sender: "SaaS Weekly Digest <newsletter@example.com>",
          subject: "Top 10 AI growth playbooks this month",
          list_unsubscribe:
            "<mailto:unsubscribe@example.com>, <https://saasweekly.io/unsubscribe>",
          decision_id: "11111111-1111-4111-a111-111111111109",
        },
      ],
      dry_run: false,
    });
    expect(batchResult.output.labeled_count).toBe(1);
    expect(batchResult.output.label).toBe("ahOS/Unsubscribe");
    expect(batchResult.threadIds).toEqual(["thread-ps-004"]);
  });
});

