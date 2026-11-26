import { useState } from "react";
import type { StackedChartRow } from "../../lib/jobHuntActions.js";

const SERIES = [
  { key: "interview" as const, label: "Interview", cssVar: "var(--jh-series-interview)" },
  { key: "rejected" as const, label: "Rejected", cssVar: "var(--jh-series-rejected)" },
  { key: "silent" as const, label: "No reply", cssVar: "var(--jh-series-silent)" },
] as const;

export interface StackedOutcomeChartProps {
  id: string;
  title: string;
  subtitle: string;
  rows: readonly StackedChartRow[];
}

export function StackedOutcomeChart({
  id,
  title,
  subtitle,
  rows,
}: StackedOutcomeChartProps) {
  const [tooltip, setTooltip] = useState<string | null>(null);

  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0);
  const scaleMax = Math.max(2, Math.ceil(maxTotal / 2) * 2);
  const ticks: number[] = [];
  for (let t = 0; t <= scaleMax; t += 2) {
    ticks.push(t);
  }

  return (
    <div
      data-testid={id}
      className="p-4 bg-slate-900 border border-slate-800 rounded-xl flex flex-col gap-3 relative"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        {tooltip && (
          <div
            role="status"
            className="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700 whitespace-nowrap"
          >
            {tooltip}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block w-2.5 h-2.5 rounded-[3px]"
              style={{ backgroundColor: s.cssVar }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-slate-400">
          No submitted applications in this breakdown yet.
        </div>
      ) : (
        <>
          <div className="grid gap-2.5">
            {rows.map((row) => (
              <div
                key={row.key}
                aria-label={`${row.label}: ${row.interview} interview, ${row.rejected} rejected, ${row.silent} no reply`}
                className="grid grid-cols-[92px_1fr_64px] sm:grid-cols-[132px_1fr_92px] items-center gap-2.5"
              >
                <div className="text-xs text-slate-200 truncate" title={row.label}>
                  {row.label}
                </div>
                <div className="relative h-5">
                  <div
                    className="flex gap-0.5 h-5"
                    style={{ width: `${(row.total / scaleMax) * 100}%` }}
                  >
                    {SERIES.filter((s) => row[s.key] > 0).map((s) => {
                      const count = row[s.key];
                      const tip = `${row.label} · ${s.label}: ${count}`;
                      return (
                        <div
                          key={s.key}
                          title={tip}
                          data-tip={tip}
                          onMouseEnter={() => setTooltip(tip)}
                          onMouseLeave={() => setTooltip(null)}
                          className="h-full min-w-[4px] last:rounded-r transition-opacity hover:opacity-90"
                          style={{
                            flex: count,
                            backgroundColor: s.cssVar,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
                <div className="text-xs text-slate-300 text-right tabular-nums whitespace-nowrap">
                  <strong className="text-white font-semibold">{row.interview}</strong>{" "}
                  of {row.total}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-[92px_1fr_64px] sm:grid-cols-[132px_1fr_92px] gap-2.5 text-[11px] text-slate-400">
            <span />
            <div className="relative h-4 border-t border-slate-800">
              {ticks.map((t, idx) => (
                <span
                  key={t}
                  className={`absolute top-0.5 tabular-nums ${
                    idx === 0 ? "" : "-translate-x-1/2"
                  }`}
                  style={{ left: `${(t / scaleMax) * 100}%` }}
                >
                  {t}
                </span>
              ))}
            </div>
            <span className="text-right">interviewed</span>
          </div>
        </>
      )}
    </div>
  );
}
