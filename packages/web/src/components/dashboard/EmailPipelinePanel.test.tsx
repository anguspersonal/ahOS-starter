import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { buildEmailMetricsSeries, gmailTriageMetricsInputSchema, type GmailTriageMetricsOutput } from "@ahkms/core";

vi.mock("../../lib/supabase.js", () => ({ isSupabaseConfigured: false, supabase: null }));

import { EmailPipelinePanel, gmailTriageMetricsActionClient } from "./EmailPipelinePanel.js";

const now = new Date("2026-11-08T12:00:00Z");

function sample(attentionToday: number, withSnapshot = true): GmailTriageMetricsOutput {
  const decisions = Array.from({ length: attentionToday + 20 }, (_, i) => ({
    created_at: "2026-11-08T09:00:00Z",
    status: "auto_applied",
    thread_id: `t${i}`,
    account: i % 2 ? "personal" : "work",
    route: i < attentionToday ? "attention" : "archive",
    thinking_mode: i < 3 ? "system_2" : "system_1",
  }));
  const series = buildEmailMetricsSeries(
    decisions,
    withSnapshot
      ? [{ date: "2026-11-08", observed_at: "2026-11-08T11:00:00Z", accounts: { personal: { inbox: 42, unread: 17 } } }]
      : [],
    { now, days: 7, attentionBudget: 15 },
  );
  return { ...series, window_days: 7, generated_at: now.toISOString() };
}

describe("EmailPipelinePanel", () => {
  it("targets the gmail_triage_metrics action with the core input schema", () => {
    expect(gmailTriageMetricsActionClient.id).toBe("gmail_triage_metrics");
    expect(gmailTriageMetricsActionClient.schema).toBe(gmailTriageMetricsInputSchema);
  });

  it("leads with today's needs-attention against the budget, in words as well as colour", () => {
    const html = renderToString(<EmailPipelinePanel initialData={sample(9)} autoLoad={false} />);
    expect(html).toContain("Needs you today");
    expect(html).toContain("9 / 15");
    expect(html).toContain("within budget");
    expect(html).toContain("42");
    expect(html).toContain("17 unread");
    expect(html).toContain("Emails that needed you, per day");
    expect(html).toContain("budget 15");
  });

  it("says how far over budget a day is and explains a missing snapshot", () => {
    const html = renderToString(<EmailPipelinePanel initialData={sample(18, false)} autoLoad={false} />);
    expect(html).toContain("3 over");
    expect(html).toContain("No mailbox snapshot yet");
    expect(html).toContain("no snapshot yet");
  });
});
