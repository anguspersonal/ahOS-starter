import type { JobApplicationPipelineMetrics } from "../../lib/jobHuntActions.js";

export interface PipelineTotalsStripProps {
  metrics: JobApplicationPipelineMetrics;
  asOf: string;
}

export function PipelineTotalsStrip({ metrics, asOf }: PipelineTotalsStripProps) {
  const interviewPct =
    metrics.submitted > 0
      ? Math.round((metrics.reached_interview / metrics.submitted) * 100)
      : 0;

  const tiles: Array<{
    id: string;
    label: string;
    value: number;
    sub: string;
    seriesVar?: string;
  }> = [
    {
      id: "submitted",
      label: "Submitted",
      value: metrics.submitted,
      sub: "applications sent",
    },
    {
      id: "interviews",
      label: "Interviews",
      value: metrics.reached_interview,
      sub: `${interviewPct}% of submitted`,
      seriesVar: "var(--jh-series-interview)",
    },
    {
      id: "rejected",
      label: "Rejected",
      value: metrics.rejected,
      sub: "closed",
      seriesVar: "var(--jh-series-rejected)",
    },
    {
      id: "silent",
      label: "No reply",
      value: metrics.silent,
      sub: ">=14d without inbound",
      seriesVar: "var(--jh-series-silent)",
    },
    {
      id: "to-review",
      label: "To review",
      value: metrics.to_review,
      sub: "identified & matched",
    },
  ];

  return (
    <section aria-labelledby="jh-totals-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="jh-totals-heading"
          className="text-lg font-bold uppercase tracking-wide text-white"
        >
          Where it stands
        </h2>
        <p className="text-xs text-slate-400">As of {asOf}</p>
      </div>

      <div
        data-testid="jh-totals-grid"
        className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
      >
        {tiles.map((tile) => (
          <div
            key={tile.id}
            data-testid={`jh-total-${tile.id}`}
            className="p-3.5 bg-slate-900 border border-slate-800 rounded-xl space-y-0.5"
          >
            <div className="text-xs text-slate-300 flex items-center gap-2">
              {tile.seriesVar && (
                <span
                  aria-hidden="true"
                  className="inline-block w-2.5 h-2.5 rounded-[3px] shrink-0"
                  style={{ backgroundColor: tile.seriesVar }}
                />
              )}
              <span>{tile.label}</span>
            </div>
            <div className="text-3xl font-semibold text-white tabular-nums leading-tight">
              {tile.value}
            </div>
            <div className="text-xs text-slate-400">{tile.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
