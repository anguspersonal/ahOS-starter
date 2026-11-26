import {
  buildCategoryChartRows,
  buildChannelChartRows,
  buildFindingsFromMetrics,
  type JobApplicationPipelineMetrics,
} from "../../lib/jobHuntActions.js";
import { StackedOutcomeChart } from "./StackedOutcomeChart.js";

export interface OutcomesInsightsSectionProps {
  metrics: JobApplicationPipelineMetrics;
}

export function OutcomesInsightsSection({
  metrics,
}: OutcomesInsightsSectionProps) {
  const channelRows = buildChannelChartRows(metrics);
  const categoryRows = buildCategoryChartRows(metrics);
  const findings = buildFindingsFromMetrics(metrics);

  return (
    <section aria-labelledby="jh-data-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="jh-data-heading"
          className="text-lg font-bold uppercase tracking-wide text-white"
        >
          What the data says
        </h2>
        <p className="text-xs text-slate-400">Submitted applications only</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <StackedOutcomeChart
          id="jh-chart-channel"
          title="Outcomes by channel"
          subtitle="Where you applied"
          rows={channelRows}
        />
        <StackedOutcomeChart
          id="jh-chart-category"
          title="Outcomes by role category"
          subtitle="What you applied for"
          rows={categoryRows}
        />

        <div
          data-testid="jh-findings-strip"
          className="md:col-span-2 p-4 bg-slate-900 border border-slate-800 rounded-xl grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5"
        >
          {findings.map((finding, idx) => (
            <div key={idx} className="space-y-1">
              <div className="text-2xl font-bold uppercase tracking-tight text-amber-500 tabular-nums">
                {finding.stat}
              </div>
              <p className="font-serif italic text-sm text-slate-200 leading-snug max-w-[46ch]">
                {finding.text}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
