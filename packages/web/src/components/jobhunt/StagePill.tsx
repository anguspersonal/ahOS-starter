import {
  formatCadenceBadge,
  mapApplicationToPill,
  type JobHuntPillTone,
  type JobPipelineApplicationItem,
} from "../../lib/jobHuntActions.js";

const TONE_CLASSES: Record<JobHuntPillTone, string> = {
  interview:
    "bg-emerald-500/15 text-emerald-600 border border-emerald-500/30",
  review: "bg-amber-500/15 text-amber-600 border border-amber-500/30",
  rejected: "bg-rose-500/15 text-rose-500 border border-rose-500/30",
  silent: "bg-slate-800 text-slate-400 border border-slate-700",
  notsub: "bg-transparent text-slate-400 border border-dashed border-slate-700",
  active: "bg-indigo-500/15 text-indigo-400 border border-indigo-500/30",
};

export function StagePill({
  application,
}: {
  application: Pick<JobPipelineApplicationItem, "stage" | "silent" | "open_task"> & {
    applied_on?: string | null;
    submitted?: boolean;
  };
}) {
  const pill = mapApplicationToPill(application);
  return (
    <span
      data-testid={`stage-pill-${application.stage}`}
      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap ${TONE_CLASSES[pill.tone]}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
      {pill.label}
    </span>
  );
}

export function ApplicationSignalBadges({
  application,
}: {
  application: Pick<
    JobPipelineApplicationItem,
    "silent" | "cadence" | "cv" | "stage"
  >;
}) {
  const cadenceLabel = formatCadenceBadge(application.cadence);
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1">
      {application.silent && (
        <span
          data-testid="badge-silent"
          className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/30"
        >
          Silent (&ge;14d)
        </span>
      )}
      {cadenceLabel && (
        <span
          data-testid="badge-cadence"
          className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 border border-amber-500/30"
        >
          {cadenceLabel}
        </span>
      )}
      {application.cv && (
        <span
          data-testid="badge-cv-ref"
          title={`CV reference: ${application.cv.title}`}
          className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700"
        >
          CV: {application.cv.title}
        </span>
      )}
    </div>
  );
}
