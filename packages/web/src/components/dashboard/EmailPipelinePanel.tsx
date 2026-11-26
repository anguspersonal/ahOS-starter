import { useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import {
  EMAIL_ROUTES,
  gmailTriageMetricsInputSchema,
  type EmailMetricsDay,
  type GmailTriageMetricsOutput,
} from "@ahkms/core";
import { executeActionClient, type ClientActionDefinition } from "../../lib/actionClient.js";

/**
 * Email pipeline panel (ADR-118 §9). Reads `gmail_triage_metrics`: flows derived from
 * the decision log, inbox and unread from the retained daily snapshot.
 *
 * Colours: one blue for magnitude (needs attention, inbox), orange for the second line
 * (unread); validated against the dashboard's slate-900 surface with the dataviz
 * validator (all checks pass, dark mode). The budget line is neutral ink, never a series
 * colour, and "within budget" carries a word as well as a colour.
 */
type GmailTriageMetricsRequest = z.input<typeof gmailTriageMetricsInputSchema>;

export const gmailTriageMetricsActionClient: ClientActionDefinition<
  GmailTriageMetricsRequest,
  GmailTriageMetricsOutput
> = {
  id: "gmail_triage_metrics",
  name: "Email pipeline metrics",
  description: "Daily email pipeline metrics: inbox, unread, processed, new and needs-attention against the budget.",
  schema: gmailTriageMetricsInputSchema as unknown as ClientActionDefinition<GmailTriageMetricsRequest>["schema"],
};

const BLUE = "#3987e5";
const ORANGE = "#d95926";
const GRID = "#1e293b"; // slate-800, recessive
const INK_MUTED = "#94a3b8"; // slate-400
const SURFACE = "#0f172a"; // slate-900

const ROUTE_LABELS: Record<string, string> = {
  attention: "Attention",
  draft_reply: "Draft reply",
  review: "Review",
  calendar: "Calendar",
  awaiting_reply: "Awaiting reply",
  digest: "Digest",
  archive: "Archived",
  unsubscribe_candidate: "Unsubscribe",
};

function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] ?? m;
  return `${Number(d)} ${month}`;
}

/** An axis maximum whose half is also a round number, so the three ticks never lie. */
function niceMax(value: number): number {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = value / magnitude > 5 ? magnitude : magnitude / 2;
  return Math.ceil(value / (2 * step)) * 2 * step;
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  status?: { tone: "good" | "critical"; label: string };
  testId: string;
}

function StatTile({ label, value, sub, status, testId }: StatTileProps) {
  return (
    <div data-testid={testId} className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl">
      <div className="text-[11px] font-mono uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
      {status && (
        <div
          className={`mt-2 inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded border ${
            status.tone === "good"
              ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
              : "text-rose-300 border-rose-500/30 bg-rose-500/10"
          }`}
        >
          <span aria-hidden="true">{status.tone === "good" ? "✓" : "!"}</span>
          {status.label}
        </div>
      )}
    </div>
  );
}

const CHART_W = 640;
const CHART_H = 200;
const PAD = { top: 16, right: 72, bottom: 24, left: 32 };

function AttentionChart({ days, budget }: { days: EmailMetricsDay[]; budget: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(budget, ...days.map((d) => d.needs_attention)) * 1.1);
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, days.length);
  const barW = Math.max(4, Math.min(28, slot - 2));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const budgetY = y(budget);
  const labelEvery = days.length > 16 ? 3 : days.length > 8 ? 2 : 1;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Emails needing attention per day against a budget of ${budget}`}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill={INK_MUTED} fontFamily={MONO}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const h = (d.needs_attention / max) * innerH;
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.date}>
              {h > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barW - r} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + r} V${y(0)} Z`}
                  fill={BLUE}
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={CHART_H - 6} textAnchor="middle" fontSize={10} fill={INK_MUTED} fontFamily={MONO}>
                  {shortDate(d.date)}
                </text>
              )}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={innerH}
                fill="transparent"
                data-testid={`attention-bar-hit-${d.date}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                tabIndex={0}
              />
            </g>
          );
        })}
        <line
          x1={PAD.left}
          x2={CHART_W - PAD.right}
          y1={budgetY}
          y2={budgetY}
          stroke={INK_MUTED}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
        <text x={CHART_W - PAD.right + 4} y={budgetY + 3} fontSize={10} fill={INK_MUTED} fontFamily={MONO}>
          {`budget ${budget}`}
        </text>
      </svg>
      {hover !== null && days[hover] && (
        <div
          data-testid="attention-tooltip"
          className="absolute top-0 pointer-events-none px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] font-mono text-slate-200 shadow-lg"
          style={{ left: `${((PAD.left + hover * slot + slot / 2) / CHART_W) * 100}%`, transform: "translateX(-50%)" }}
        >
          <div className="text-white font-semibold">{shortDate(days[hover].date)}</div>
          <div>
            <span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: BLUE }} />
            needs you: {days[hover].needs_attention}
            {days[hover].needs_attention > budget ? " (over budget)" : ""}
          </div>
          <div className="text-slate-400">
            processed {days[hover].processed} · review {days[hover].review} · drafts {days[hover].drafts_created}
          </div>
        </div>
      )}
    </div>
  );
}

function MailboxChart({ days }: { days: EmailMetricsDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const observed = days.filter((d) => d.inbox !== null);
  if (observed.length === 0) {
    return (
      <p data-testid="mailbox-empty" className="text-xs text-slate-400 py-8 text-center">
        No mailbox snapshot yet. The triage run records one each day it runs outside dry-run.
      </p>
    );
  }
  const max = niceMax(Math.max(...observed.map((d) => Math.max(d.inbox ?? 0, d.unread ?? 0))) * 1.1);
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const step = days.length > 1 ? innerW / (days.length - 1) : 0;
  const x = (i: number) => PAD.left + (days.length > 1 ? i * step : innerW / 2);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const path = (pick: (d: EmailMetricsDay) => number | null) => {
    let d = "";
    let pen = false;
    days.forEach((day, i) => {
      const v = pick(day);
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i)},${y(v)} `;
      pen = true;
    });
    return d.trim();
  };
  const lastIdx = days.map((d) => d.inbox !== null).lastIndexOf(true);
  const last = days[lastIdx];
  const labelEvery = days.length > 16 ? 3 : days.length > 8 ? 2 : 1;

  return (
    <div className="relative">
      <div className="flex items-center gap-4 text-[11px] font-mono text-slate-300 mb-1" data-testid="mailbox-legend">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ background: BLUE }} /> Inbox threads
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ background: ORANGE }} /> Unread
        </span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Inbox and unread threads at the end of each day"
        onMouseLeave={() => setHover(null)}
      >
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill={INK_MUTED} fontFamily={MONO}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.date} x={x(i)} y={CHART_H - 6} textAnchor="middle" fontSize={10} fill={INK_MUTED} fontFamily={MONO}>
              {shortDate(d.date)}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke={INK_MUTED} strokeWidth={1} />}
        <path d={path((d) => d.inbox)} fill="none" stroke={BLUE} strokeWidth={2} strokeLinejoin="round" />
        <path d={path((d) => d.unread)} fill="none" stroke={ORANGE} strokeWidth={2} strokeLinejoin="round" />
        {days.map((d, i) =>
          d.inbox === null ? null : (
            <g key={d.date}>
              <circle cx={x(i)} cy={y(d.inbox)} r={hover === i ? 4.5 : 3} fill={BLUE} stroke={SURFACE} strokeWidth={2} />
              <circle cx={x(i)} cy={y(d.unread ?? 0)} r={hover === i ? 4.5 : 3} fill={ORANGE} stroke={SURFACE} strokeWidth={2} />
            </g>
          ),
        )}
        {last && last.inbox !== null && (
          <>
            <text x={x(lastIdx) + 8} y={y(last.inbox) + 3} fontSize={10} fill="#e2e8f0" fontFamily={MONO}>
              {last.inbox}
            </text>
            <text x={x(lastIdx) + 8} y={y(last.unread ?? 0) + 3} fontSize={10} fill="#e2e8f0" fontFamily={MONO}>
              {last.unread}
            </text>
          </>
        )}
        {days.map((d, i) => (
          <rect
            key={`hit-${d.date}`}
            x={x(i) - Math.max(step, 16) / 2}
            y={PAD.top}
            width={Math.max(step, 16)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null && days[hover] && (
        <div
          data-testid="mailbox-tooltip"
          className="absolute top-6 pointer-events-none px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] font-mono text-slate-200 shadow-lg"
          style={{ left: `${(x(hover) / CHART_W) * 100}%`, transform: "translateX(-50%)" }}
        >
          <div className="text-white font-semibold">{shortDate(days[hover].date)}</div>
          {days[hover].inbox === null ? (
            <div className="text-slate-400">not observed</div>
          ) : (
            <>
              <div>inbox {days[hover].inbox}</div>
              <div>unread {days[hover].unread}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RouteBars({ byRoute }: { byRoute: Record<string, number> }) {
  const rows = EMAIL_ROUTES.map((r) => ({ route: r, count: byRoute[r] ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="text-xs text-slate-400">No decisions in this window.</p>;
  return (
    <ul className="space-y-1.5" data-testid="route-bars">
      {rows.map((r) => (
        <li key={r.route} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2 text-xs">
          <span className="text-slate-300 truncate">{ROUTE_LABELS[r.route] ?? r.route}</span>
          <span className="h-2.5 bg-slate-800/60 rounded-r">
            <span className="block h-full rounded-r" style={{ width: `${(r.count / max) * 100}%`, background: BLUE }} />
          </span>
          <span className="text-right font-mono text-slate-300 tabular-nums">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

export interface EmailPipelinePanelProps {
  initialData?: GmailTriageMetricsOutput | null;
  autoLoad?: boolean;
}

export function EmailPipelinePanel({ initialData = null, autoLoad = true }: EmailPipelinePanelProps) {
  const [days, setDays] = useState<number>(initialData?.window_days ?? 14);
  const [data, setData] = useState<GmailTriageMetricsOutput | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const load = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError(null);
    try {
      setData(await executeActionClient(gmailTriageMetricsActionClient, { days: windowDays }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoLoad) void load(days);
  }, [autoLoad, days, load]);

  const today = data?.days[data.days.length - 1] ?? null;
  const budget = data?.attention_budget ?? 15;
  const openReview = useMemo(
    () => (data ? data.totals.review - data.totals.review_resolved : 0),
    [data],
  );

  return (
    <section data-testid="email-pipeline-panel" className="space-y-4 p-4 bg-slate-950/40 border border-slate-800 rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Email pipeline</h3>
          <p className="text-xs text-slate-400">
            Target: fewer than {budget} emails a day need you. Flows from the decision log; inbox from the daily snapshot
            {data ? ` (${data.time_zone})` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="email-pipeline-days" className="text-[11px] font-mono text-slate-400">
            Window
          </label>
          <select
            id="email-pipeline-days"
            data-testid="email-pipeline-days"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-slate-900 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-2 py-1.5"
          >
            {[7, 14, 30, 90].map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-lg border border-slate-700"
          >
            {showTable ? "Show charts" : "Show table"}
          </button>
        </div>
      </div>

      {error && (
        <div data-testid="email-pipeline-error" className="p-3 bg-rose-950/60 border border-rose-500/40 rounded-lg text-xs text-rose-200">
          Could not load email metrics: {error}
        </div>
      )}
      {loading && !data && <p className="text-xs text-slate-400">Loading email metrics…</p>}

      {data && today && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatTile
              testId="email-tile-attention"
              label="Needs you today"
              value={`${today.needs_attention} / ${budget}`}
              sub={`avg ${data.totals.avg_needs_attention ?? "–"} a day`}
              status={
                today.within_budget
                  ? { tone: "good", label: "within budget" }
                  : { tone: "critical", label: `${today.needs_attention - budget} over` }
              }
            />
            <StatTile
              testId="email-tile-inbox"
              label="Inbox now"
              value={data.latest_mailbox ? String(data.latest_mailbox.inbox) : "–"}
              sub={data.latest_mailbox ? `${data.latest_mailbox.unread} unread` : "no snapshot yet"}
            />
            <StatTile
              testId="email-tile-processed"
              label="Processed today"
              value={String(today.processed)}
              sub={`${today.new} new · ${today.leaves_inbox} filed`}
            />
            <StatTile
              testId="email-tile-review"
              label="Open review"
              value={String(openReview)}
              sub={`${data.totals.overrides} corrected in window`}
            />
            <StatTile
              testId="email-tile-system2"
              label="System 2 share"
              value={data.totals.system_2_share === null ? "–" : `${Math.round(data.totals.system_2_share * 100)}%`}
              sub={`${data.totals.drafts_created} drafts · ${data.totals.tasks_created} tasks`}
            />
          </div>

          {showTable ? (
            <div className="overflow-x-auto">
              <table data-testid="email-pipeline-table" className="w-full text-xs font-mono text-slate-300">
                <thead className="text-slate-400">
                  <tr className="border-b border-slate-800">
                    {["Day", "Needs you", "Processed", "New", "Review", "Drafts", "Tasks", "Inbox", "Unread", "Sys 2"].map((h) => (
                      <th key={h} className="text-left font-medium py-1.5 pr-3">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...data.days].reverse().map((d) => (
                    <tr key={d.date} className="border-b border-slate-900">
                      <td className="py-1 pr-3">{d.date}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {d.needs_attention}
                        {d.within_budget ? "" : " (over)"}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{d.processed}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.new}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.review}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.drafts_created}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.tasks_created}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.inbox ?? "–"}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.unread ?? "–"}</td>
                      <td className="py-1 pr-3 tabular-nums">{d.system_2}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <div className="xl:col-span-2 space-y-4">
                <div>
                  <h4 className="text-xs font-semibold text-slate-200 mb-1">Emails that needed you, per day</h4>
                  <AttentionChart days={data.days} budget={budget} />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-slate-200 mb-1">Inbox at end of day</h4>
                  <MailboxChart days={data.days} />
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-slate-200 mb-2">Where email went ({data.window_days} days)</h4>
                <RouteBars byRoute={data.totals.by_route} />
                <p className="text-[11px] text-slate-500 mt-3">
                  {data.totals.processed} judged · {data.totals.auto_applied} applied without you ·{" "}
                  {data.totals.gmail_category_contradictions} times Gmail's tab disagreed with your graph
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
