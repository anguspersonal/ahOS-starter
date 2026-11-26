import { useState } from "react";
import {
  toDateInputValue,
  type NextUpCardItem,
} from "../../lib/jobHuntActions.js";
import { ApplicationSignalBadges, StagePill } from "./StagePill.js";

export interface NextUpSectionProps {
  items: readonly NextUpCardItem[];
  busyTaskId?: string | null;
  onCompleteTask?: (taskId: string) => void | Promise<void>;
  onRescheduleTask?: (taskId: string, dateInput: string) => void | Promise<void>;
}

export function NextUpSection({
  items,
  busyTaskId = null,
  onCompleteTask,
  onRescheduleTask,
}: NextUpSectionProps) {
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draftDate, setDraftDate] = useState<string>("");

  const visibleItems = items.slice(0, 6);

  return (
    <section aria-labelledby="jh-next-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="jh-next-heading"
          className="text-lg font-bold uppercase tracking-wide text-white"
        >
          Next up
        </h2>
        <p className="text-xs text-slate-400">
          Needs attention &amp; open tasks sorted by due date ({items.length})
        </p>
      </div>

      {visibleItems.length === 0 ? (
        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-400">
          No pending follow-ups or pre-application decisions.
        </div>
      ) : (
        <div
          data-testid="jh-next-up-grid"
          className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
        >
          {visibleItems.map((item) => {
            const { application: app, task, urgent, dueLabel, actionTitle } = item;
            const isBusy = Boolean(task && busyTaskId === task.id);
            const isRescheduling = Boolean(task && editingTaskId === task.id);

            return (
              <div
                key={app.id}
                data-testid={`next-up-card-${app.id}`}
                className={`p-3.5 bg-slate-900 rounded-xl border flex flex-col justify-between gap-2.5 ${
                  urgent
                    ? "border-amber-500/70 border-l-4 border-l-amber-500"
                    : "border-slate-800"
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                    <span className={urgent ? "text-amber-500" : "text-slate-300"}>
                      {dueLabel}
                    </span>
                    <StagePill application={app} />
                  </div>
                  <div className="text-sm font-semibold text-white leading-snug">
                    {actionTitle}
                  </div>
                  <div className="text-xs text-slate-400">
                    {app.organisation_name ?? app.title} · {app.role_title}
                  </div>
                  <ApplicationSignalBadges application={app} />
                </div>

                {task && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isBusy}
                        data-testid={`complete-task-${task.id}`}
                        onClick={() => void onCompleteTask?.(task.id)}
                        className="px-2 py-1 text-[11px] font-semibold rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white"
                      >
                        Complete
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          if (isRescheduling) {
                            setEditingTaskId(null);
                          } else {
                            setEditingTaskId(task.id);
                            setDraftDate(toDateInputValue(task.due_date));
                          }
                        }}
                        className="px-2 py-1 text-[11px] font-medium rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 border border-slate-700"
                      >
                        {isRescheduling ? "Cancel" : "Reschedule"}
                      </button>
                    </div>

                    {isRescheduling && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (draftDate) {
                            void onRescheduleTask?.(task.id, draftDate);
                            setEditingTaskId(null);
                          }
                        }}
                        className="flex items-center gap-1.5"
                      >
                        <input
                          type="date"
                          aria-label={`Reschedule ${task.title}`}
                          value={draftDate}
                          onChange={(e) => setDraftDate(e.target.value)}
                          required
                          className="px-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded text-slate-200 flex-1 min-w-0"
                        />
                        <button
                          type="submit"
                          disabled={isBusy || !draftDate}
                          className="px-2 py-1 text-[11px] font-semibold rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
                        >
                          Save
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
