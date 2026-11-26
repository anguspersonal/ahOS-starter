import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JobPipelineReadResult } from "@ahkms/core";

vi.mock("../lib/supabase.js", () => ({
  supabase: {
    from: vi.fn(),
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: "test-jobhunt-token",
            user: { id: "00000000-0000-4000-a000-000000000001" },
          },
        },
      })),
    },
  },
}));

import {
  completeJobHuntTask,
  fetchJobPipeline,
  filterAndSortApplications,
  isPendingApprovalResponse,
  mapApplicationToPill,
  rescheduleJobHuntTask,
  toTaskDueDateIso,
  updateApplicationStage,
  upsertJobApplication,
} from "../lib/jobHuntActions.js";
import { buildApplicationUpsertPayload } from "../components/jobhunt/ApplicationUpsertForm.js";
import { JobHuntCanvas } from "../components/jobhunt/JobHuntCanvas.js";
import { getTabFromPathname, TAB_PATHS } from "../lib/router.js";

const cleanRender = (el: React.ReactElement): string =>
  renderToString(el).replace(/<!-- -->/g, "");

const APP_1_ID = "11111111-1111-4111-8111-111111111111";
const APP_2_ID = "22222222-2222-4222-8222-222222222222";
const APP_3_ID = "33333333-3333-4333-8333-333333333333";
const APP_4_ID = "44444444-4444-4444-8444-444444444444";
const TASK_1_ID = "aaaa1111-1111-4111-8111-111111111111";
const TASK_2_ID = "bbbb2222-2222-4222-8222-222222222222";
const ORG_1_ID = "cccc1111-1111-4111-8111-111111111111";
const SITE_1_ID = "dddd1111-1111-4111-8111-111111111111";
const REC_1_ID = "eeee1111-1111-4111-8111-111111111111";
const CV_1_ID = "ffff1111-1111-4111-8111-111111111111";

const FIXTURE_PIPELINE: JobPipelineReadResult = {
  as_of: "2026-11-22",
  total_count: 27,
  filtered_count: 4,
  metrics: {
    total: 27,
    submitted: 18,
    reached_interview: 2,
    rejected: 7,
    silent: 9,
    to_review: 6,
    drafting: 3,
    interview_rate: 2 / 18,
    by_channel: {
      jumpstart: {
        total: 7,
        submitted: 5,
        reached_interview: 2,
        rejected: 3,
        silent: 0,
        to_review: 2,
        drafting: 0,
        interview_rate: 2 / 5,
      },
      company_site: {
        total: 7,
        submitted: 6,
        reached_interview: 0,
        rejected: 3,
        silent: 3,
        to_review: 0,
        drafting: 1,
        interview_rate: 0,
      },
      dex_jobs: {
        total: 6,
        submitted: 6,
        reached_interview: 0,
        rejected: 0,
        silent: 6,
        to_review: 0,
        drafting: 0,
        interview_rate: 0,
      },
      cord: {
        total: 1,
        submitted: 1,
        reached_interview: 0,
        rejected: 1,
        silent: 0,
        to_review: 0,
        drafting: 0,
        interview_rate: 0,
      },
    },
    by_category: {
      product: {
        total: 5,
        submitted: 3,
        reached_interview: 1,
        rejected: 0,
        silent: 2,
        to_review: 2,
        drafting: 0,
        interview_rate: 1 / 3,
      },
      ops_chief_of_staff: {
        total: 4,
        submitted: 2,
        reached_interview: 1,
        rejected: 1,
        silent: 0,
        to_review: 2,
        drafting: 0,
        interview_rate: 1 / 2,
      },
      ai_engineering: {
        total: 8,
        submitted: 6,
        reached_interview: 0,
        rejected: 1,
        silent: 5,
        to_review: 2,
        drafting: 0,
        interview_rate: 0,
      },
      data_leadership: {
        total: 7,
        submitted: 5,
        reached_interview: 0,
        rejected: 3,
        silent: 2,
        to_review: 0,
        drafting: 2,
        interview_rate: 0,
      },
      solutions: {
        total: 2,
        submitted: 2,
        reached_interview: 0,
        rejected: 2,
        silent: 0,
        to_review: 0,
        drafting: 0,
        interview_rate: 0,
      },
    },
  },
  applications: [
    {
      id: APP_1_ID,
      title: "WORK-SELF · Founding Product Lead",
      organisation: { id: ORG_1_ID, title: "WORK-SELF" },
      organisation_name: "WORK-SELF",
      job_site: { id: SITE_1_ID, title: "Jumpstart" },
      applicant_id: null,
      recruiters: [{ id: REC_1_ID, title: "Kabir Bali" }],
      hiring_contacts: [],
      cv: { id: CV_1_ID, title: "Founding Product CV v3" },
      role_title: "Founding Product Lead",
      role_category: "product",
      channel: "jumpstart",
      ats: null,
      stage: "screening",
      entity_status: "in_progress",
      applied_on: "2026-11-15",
      date_precision: "month",
      closed_on: null,
      last_inbound_at: "2026-11-21",
      last_action_at: "2026-11-21T10:00:00.000Z",
      platform_ref: null,
      salary_band: null,
      salary_expectation_submitted: null,
      priority_level: 6,
      source: "owner",
      notes: "Book screening slot with Wolf",
      stage_history: [
        {
          stage: "screening",
          at: "2026-11-21T10:00:00.000Z",
          note: "Wolf sent booking link",
        },
      ],
      submitted: true,
      reached_interview: true,
      silent: false,
      cadence: {
        daysElapsed: null,
        silent: false,
        action: "none",
        milestoneDays: null,
        chaseNumber: null,
        shouldAutoClose: false,
        nextStage: null,
        nextStatus: null,
        taskSpec: null,
      },
      open_task: {
        id: TASK_1_ID,
        title: "Book the call",
        status: "todo",
        priority_level: 6,
        energy_mode: "admin",
        source: "owner",
        due_date: "2026-11-22T09:00:00.000Z",
        completed_at: null,
      },
      tasks: [],
      artifacts: [],
    },
    {
      id: APP_2_ID,
      title: "36 Labs · Lead Product Engineer",
      organisation: { id: null as unknown as string, title: "36 Labs" },
      organisation_name: "36 Labs",
      job_site: { id: "site-jj", title: "Jack & Jill" },
      applicant_id: null,
      recruiters: [],
      hiring_contacts: [],
      cv: null,
      role_title: "Lead Product Engineer",
      role_category: "product",
      channel: "jack_and_jill",
      ats: null,
      stage: "matched",
      entity_status: "proposed",
      applied_on: null,
      date_precision: null,
      closed_on: null,
      last_inbound_at: null,
      last_action_at: "2026-11-22T08:00:00.000Z",
      platform_ref: null,
      salary_band: "£90k-£140k",
      salary_expectation_submitted: null,
      priority_level: 4,
      source: "agent_proposed",
      notes: "Jack's top pick",
      stage_history: [
        { stage: "matched", at: "2026-11-22T08:00:00.000Z", note: "In digest" },
      ],
      submitted: false,
      reached_interview: false,
      silent: false,
      cadence: {
        daysElapsed: null,
        silent: false,
        action: "none",
        milestoneDays: null,
        chaseNumber: null,
        shouldAutoClose: false,
        nextStage: null,
        nextStatus: null,
        taskSpec: null,
      },
      open_task: {
        id: TASK_2_ID,
        title: "Decide: apply or pass",
        status: "todo",
        priority_level: 4,
        energy_mode: "quick_win",
        source: "agent_proposed",
        due_date: "2026-11-25T09:00:00.000Z",
        completed_at: null,
      },
      tasks: [],
      artifacts: [],
    },
    {
      id: APP_3_ID,
      title: "Cohere · Applied AI Engineer",
      organisation: null,
      organisation_name: "Cohere",
      job_site: null,
      applicant_id: null,
      recruiters: [],
      hiring_contacts: [],
      cv: null,
      role_title: "Applied AI Engineer",
      role_category: "ai_engineering",
      channel: "company_site",
      ats: "ashby",
      stage: "applied",
      entity_status: "in_progress",
      applied_on: "2026-10-05",
      date_precision: "day",
      closed_on: null,
      last_inbound_at: null,
      last_action_at: "2026-10-05T10:00:00.000Z",
      platform_ref: "B28-00397",
      salary_band: null,
      salary_expectation_submitted: null,
      priority_level: 3,
      source: "owner",
      notes: "Auto-acknowledged",
      stage_history: [
        { stage: "applied", at: "2026-10-05T10:00:00.000Z", note: "Submitted" },
      ],
      submitted: true,
      reached_interview: false,
      silent: true,
      cadence: {
        daysElapsed: 48,
        silent: true,
        action: "auto_close",
        milestoneDays: 42,
        chaseNumber: null,
        shouldAutoClose: true,
        nextStage: "closed_no_reply",
        nextStatus: "cancelled",
        taskSpec: null,
      },
      open_task: null,
      tasks: [],
      artifacts: [],
    },
    {
      id: APP_4_ID,
      title: "Stackfix · Founding Applied AI Engineer",
      organisation: null,
      organisation_name: "Stackfix",
      job_site: null,
      applicant_id: null,
      recruiters: [],
      hiring_contacts: [],
      cv: null,
      role_title: "Founding Applied AI Engineer",
      role_category: "ai_engineering",
      channel: "cord",
      ats: null,
      stage: "rejected",
      entity_status: "cancelled",
      applied_on: "2026-10-06",
      date_precision: "day",
      closed_on: "2026-10-09",
      last_inbound_at: "2026-10-09",
      last_action_at: "2026-10-09T12:00:00.000Z",
      platform_ref: null,
      salary_band: null,
      salary_expectation_submitted: null,
      priority_level: 2,
      source: "owner",
      notes: "Declined after review",
      stage_history: [],
      submitted: true,
      reached_interview: false,
      silent: false,
      cadence: {
        daysElapsed: null,
        silent: false,
        action: "none",
        milestoneDays: null,
        chaseNumber: null,
        shouldAutoClose: false,
        nextStage: null,
        nextStatus: null,
        taskSpec: null,
      },
      open_task: null,
      tasks: [],
      artifacts: [],
    },
  ],
  needs_attention: [],
  organisations: [
    {
      id: ORG_1_ID,
      title: "WORK-SELF",
      application_count: 1,
      submitted_count: 1,
      stages: { screening: 1 },
    },
  ],
  job_sites: [
    {
      channel: "jumpstart",
      job_site: { id: SITE_1_ID, title: "Jumpstart" },
      total: 7,
      submitted: 5,
      reached_interview: 2,
      rejected: 3,
      silent: 0,
      to_review: 2,
      drafting: 0,
      interview_rate: 2 / 5,
    },
  ],
  recruiters: [
    {
      id: REC_1_ID,
      title: "Kabir Bali",
      role: "recruiter",
      application_ids: [APP_1_ID],
      application_count: 1,
    },
  ],
};

FIXTURE_PIPELINE.needs_attention = [
  FIXTURE_PIPELINE.applications[1],
  FIXTURE_PIPELINE.applications[2],
];

describe("Job Hunt Web View (/job-hunt, #2439 P6)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("1. renders Appendix A totals, stacked charts with --jh-series-* vars, Next up cards, CV references, and silence/cadence badges", () => {
    const html = cleanRender(
      <JobHuntCanvas initialData={FIXTURE_PIPELINE} autoLoad={false} />,
    );

    expect(html).toContain('data-testid="job-hunt-canvas"');
    expect(html).toContain('data-testid="jh-needs-attention-badge"');
    expect(html).toContain("Needs attention: 2");

    // 5 KPI tiles
    expect(html).toContain('data-testid="jh-total-submitted"');
    expect(html).toContain(">18<");
    expect(html).toContain('data-testid="jh-total-interviews"');
    expect(html).toContain(">2<");
    expect(html).toContain('data-testid="jh-total-rejected"');
    expect(html).toContain(">7<");
    expect(html).toContain('data-testid="jh-total-silent"');
    expect(html).toContain(">9<");
    expect(html).toContain('data-testid="jh-total-to-review"');
    expect(html).toContain(">6<");

    // Charts and scoped series tokens
    expect(html).toContain('data-testid="jh-chart-channel"');
    expect(html).toContain('data-testid="jh-chart-category"');
    expect(html).toContain("--jh-series-interview");
    expect(html).toContain("--jh-series-rejected");
    expect(html).toContain("--jh-series-silent");
    expect(html).toContain('data-testid="jh-findings-strip"');

    // Applications table badges: CV reference, silent, 42d cadence, platform_ref
    expect(html).toContain("Founding Product CV v3");
    expect(html).toContain("Silent (≥14d)");
    expect(html).toContain("42d auto-close (48d)");
    expect(html).toContain("B28-00397");
    expect(html).toContain("Book the call");
    expect(html).toContain("Decide: apply or pass");
  });

  it("2. filters applications by status, category, and search, and switches across all 4 sub-tabs", () => {
    const reviewOnly = filterAndSortApplications(FIXTURE_PIPELINE.applications, {
      statusFilter: "review",
    });
    expect(reviewOnly.map((a) => a.organisation_name)).toEqual(["36 Labs"]);

    const silentOnly = filterAndSortApplications(FIXTURE_PIPELINE.applications, {
      statusFilter: "silent",
    });
    expect(silentOnly.map((a) => a.organisation_name)).toEqual(["Cohere"]);

    const productSearch = filterAndSortApplications(
      FIXTURE_PIPELINE.applications,
      {
        categoryFilter: "product",
        search: "wolf",
      },
    );
    expect(productSearch.map((a) => a.organisation_name)).toEqual(["WORK-SELF"]);

    const noMatch = filterAndSortApplications(FIXTURE_PIPELINE.applications, {
      search: "nonexistent-role",
    });
    expect(noMatch).toHaveLength(0);

    const refSearch = filterAndSortApplications(FIXTURE_PIPELINE.applications, {
      search: "B28-00397",
    });
    expect(refSearch.map((a) => a.organisation_name)).toEqual(["Cohere"]);

    const filteredHtml = cleanRender(
      <JobHuntCanvas
        initialData={FIXTURE_PIPELINE}
        initialStatusFilter="review"
        autoLoad={false}
      />,
    );
    expect(filteredHtml).toContain("36 Labs");
    expect(filteredHtml).not.toContain('data-testid="jh-app-row-' + APP_3_ID + '"');

    const orgHtml = cleanRender(
      <JobHuntCanvas
        initialData={FIXTURE_PIPELINE}
        initialTab="organisations"
        autoLoad={false}
      />,
    );
    expect(orgHtml).toContain('data-testid="jh-organisations-table"');
    expect(orgHtml).toContain("WORK-SELF");

    const sitesHtml = cleanRender(
      <JobHuntCanvas
        initialData={FIXTURE_PIPELINE}
        initialTab="job-sites"
        autoLoad={false}
      />,
    );
    expect(sitesHtml).toContain('data-testid="jh-job-sites-table"');
    expect(sitesHtml).toContain("40%");

    const recruitersHtml = cleanRender(
      <JobHuntCanvas
        initialData={FIXTURE_PIPELINE}
        initialTab="recruiters"
        autoLoad={false}
      />,
    );
    expect(recruitersHtml).toContain('data-testid="jh-recruiters-table"');
    expect(recruitersHtml).toContain("Kabir Bali");

    const formHtml = cleanRender(
      <JobHuntCanvas
        initialData={FIXTURE_PIPELINE}
        initialShowNewForm={true}
        autoLoad={false}
      />,
    );
    expect(formHtml).toContain('data-testid="jh-upsert-form"');
    expect(formHtml).toContain("CV entity UUID");
  });

  it("3. calls job_pipeline_read, job_application_upsert, and task_crud with normalized UTC Z due_date", async () => {
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (
          url: string,
          init?: { headers?: Record<string, string>; body?: string },
        ) => {
          const body = init?.body
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
          calls.push({ url, headers: init?.headers ?? {}, body });

          if (url.endsWith("/job_pipeline_read")) {
            return {
              ok: true,
              status: 200,
              json: async () => FIXTURE_PIPELINE,
            };
          }
          if (url.endsWith("/job_application_upsert")) {
            if (body.stage === "offer") {
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  status: "pending_approval",
                  decision_id: "dec-123",
                  action_id: "job_application_upsert",
                }),
              };
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                status: "updated",
                message: "Updated stage",
              }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              operation: body.operation ?? "update",
              task: { id: body.id },
            }),
          };
        },
      ),
    );

    const pipeline = await fetchJobPipeline({ include_closed: true });
    expect(pipeline.metrics.submitted).toBe(18);
    expect(calls[0]?.url).toBe(`${API_BASE}/job_pipeline_read`);
    expect(calls[0]?.headers["X-Action-Caller"]).toBe("ui");
    expect(calls[0]?.headers.Authorization).toBe("Bearer test-jobhunt-token");

    const stageRes = await updateApplicationStage({
      id: APP_1_ID,
      stage: "interviewing",
    });
    expect(stageRes.status).toBe("updated");
    expect(calls[1]?.url).toBe(`${API_BASE}/job_application_upsert`);
    expect(calls[1]?.body).toMatchObject({
      id: APP_1_ID,
      stage: "interviewing",
    });

    const pendingRes = await upsertJobApplication({
      id: APP_1_ID,
      stage: "offer",
    });
    expect(isPendingApprovalResponse(pendingRes)).toBe(true);

    await completeJobHuntTask(TASK_1_ID);
    expect(calls[3]?.url).toBe(`${API_BASE}/task_crud`);
    expect(calls[3]?.body).toEqual({
      operation: "complete",
      id: TASK_1_ID,
    });

    await rescheduleJobHuntTask(TASK_2_ID, "2026-11-27");
    expect(calls[4]?.url).toBe(`${API_BASE}/task_crud`);
    expect(calls[4]?.body).toEqual({
      operation: "update",
      id: TASK_2_ID,
      patch: { due_date: "2026-11-27T09:00:00.000Z" },
    });

    expect(toTaskDueDateIso("2026-12-01")).toBe("2026-12-01T09:00:00.000Z");
    expect(() => toTaskDueDateIso("")).toThrow(/empty/i);
    expect(() => toTaskDueDateIso("2026-02-31")).toThrow(/invalid/i);
  });

  it("4. registers /job-hunt and /jobhunt routes cleanly without window dependency", () => {
    expect(TAB_PATHS["job-hunt"]).toBe("/job-hunt");
    expect(getTabFromPathname("/job-hunt")).toBe("job-hunt");
    expect(getTabFromPathname("/jobhunt")).toBe("job-hunt");
    expect(getTabFromPathname()).toBe("documents");
  });

  it("5. keeps submitted withdrawals out of 'Not submitted' and omits blank applied_on unless clearing an existing date", () => {
    const submittedWithdrawn = {
      ...FIXTURE_PIPELINE.applications[2],
      id: "55555555-5555-4555-8555-555555555555",
      organisation_name: "SubmittedWithdrawCo",
      stage: "withdrawn" as const,
      applied_on: "2026-10-10",
      submitted: true,
      silent: false,
      open_task: null,
    };
    const unsubmittedWithdrawn = {
      ...FIXTURE_PIPELINE.applications[1],
      id: "66666666-6666-4666-8666-666666666666",
      organisation_name: "DraftWithdrawCo",
      stage: "withdrawn" as const,
      applied_on: null,
      submitted: false,
      silent: false,
      open_task: null,
    };

    expect(mapApplicationToPill(submittedWithdrawn).group).toBe("withdrawn");
    expect(mapApplicationToPill(unsubmittedWithdrawn).group).toBe("notsub");

    const combined = [
      ...FIXTURE_PIPELINE.applications,
      submittedWithdrawn,
      unsubmittedWithdrawn,
    ];
    expect(
      filterAndSortApplications(combined, { statusFilter: "notsub" }).map(
        (a) => a.organisation_name,
      ),
    ).toEqual(["DraftWithdrawCo"]);
    expect(
      filterAndSortApplications(combined, { statusFilter: "withdrawn" }).map(
        (a) => a.organisation_name,
      ),
    ).toEqual(["SubmittedWithdrawCo"]);

    const createAppliedPayload = buildApplicationUpsertPayload({
      editingApp: null,
      organisation: "Telemachus",
      roleTitle: "Special Projects",
      roleCategory: "ops_chief_of_staff",
      channel: "company_site",
      stage: "applied",
      appliedOn: "",
      jobSite: "",
      ats: "",
      platformRef: "",
      cvEntityId: "",
      notes: "",
    });
    expect(createAppliedPayload.applied_on).toBeUndefined();

    const clearExistingDatePayload = buildApplicationUpsertPayload({
      editingApp: FIXTURE_PIPELINE.applications[0],
      organisation: "WORK-SELF",
      roleTitle: "Founding Product Lead",
      roleCategory: "product",
      channel: "jumpstart",
      stage: "drafting",
      appliedOn: "",
      jobSite: "Jumpstart",
      ats: "",
      platformRef: "",
      cvEntityId: "",
      notes: "",
    });
    expect(clearExistingDatePayload.applied_on).toBeNull();
  });
});
