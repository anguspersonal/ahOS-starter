import { useState } from "react";
import {
  JOB_APPLICATION_STAGES,
  JOB_HUNT_STATUS_FILTERS,
  ROLE_CATEGORIES,
  filterAndSortApplications,
  formatChannelLabel,
  formatRoleCategoryLabel,
  formatShortDate,
  mapApplicationToPill,
  toDateInputValue,
  type JobApplicationStage,
  type JobHuntSortDirection,
  type JobHuntSortKey,
  type JobHuntStatusFilter,
  type JobPipelineApplicationItem,
  type RoleCategory,
} from "../../lib/jobHuntActions.js";
import { ApplicationSignalBadges, StagePill } from "./StagePill.js";

export interface ApplicationsTableProps {
  applications: readonly JobPipelineApplicationItem[];
  statusFilter: JobHuntStatusFilter;
  categoryFilter: RoleCategory | "all";
  search: string;
  sortKey: JobHuntSortKey;
  sortDir: JobHuntSortDirection;
  busyAppId?: string | null;
  busyTaskId?: string | null;
  onStatusFilterChange: (next: JobHuntStatusFilter) => void;
  onCategoryFilterChange: (next: RoleCategory | "all") => void;
  onSearchChange: (next: string) => void;
  onSortChange: (key: JobHuntSortKey) => void;
  onStageChange?: (appId: string, nextStage: JobApplicationStage) => void | Promise<void>;
  onEditApplication?: (app: JobPipelineApplicationItem) => void;
  onCompleteTask?: (taskId: string) => void | Promise<void>;
  onRescheduleTask?: (taskId: string, dateInput: string) => void | Promise<void>;
}

export function ApplicationsTable({
  applications,
  statusFilter,
  categoryFilter,
  search,
  sortKey,
  sortDir,
  busyAppId = null,
  busyTaskId = null,
  onStatusFilterChange,
  onCategoryFilterChange,
  onSearchChange,
  onSortChange,
  onStageChange,
  onEditApplication,
  onCompleteTask,
  onRescheduleTask,
}: ApplicationsTableProps) {
  const [rescheduleTaskId, setRescheduleTaskId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState<string>("");

  const rows = filterAndSortApplications(applications, {
    statusFilter,
    categoryFilter,
    search,
    sortKey,
    sortDir,
  });

  const statusCount = (id: JobHuntStatusFilter): number =>
    id === "all"
      ? applications.length
      : applications.filter((a) => mapApplicationToPill(a).group === id).length;

  const activeCategories = ROLE_CATEGORIES.filter((cat) =>
    applications.some((a) => a.role_category === cat.slug),
  );
  const categoryCount = (slug: RoleCategory | "all"): number =>
    slug === "all"
      ? applications.length
      : applications.filter((a) => a.role_category === slug).length;

  const chipClass = (active: boolean): string =>
    `px-3 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
      active
        ? "bg-indigo-600 border-indigo-500 text-white"
        : "bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700"
    }`;

  return (
    <div id="panel-applications" role="tabpanel" className="space-y-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mr-1">
          Status
        </span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status filter">
          {JOB_HUNT_STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={active}
                data-testid={`filter-status-${f.id}`}
                onClick={() => onStatusFilterChange(f.id)}
                className={chipClass(active)}
              >
                {f.label} <span className="tabular-nums opacity-80">{statusCount(f.id)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mr-1">
            Category
          </span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category filter">
            <button
              type="button"
              aria-pressed={categoryFilter === "all"}
              data-testid="filter-category-all"
              onClick={() => onCategoryFilterChange("all")}
              className={chipClass(categoryFilter === "all")}
            >
              All <span className="tabular-nums opacity-80">{categoryCount("all")}</span>
            </button>
            {activeCategories.map((cat) => {
              const active = categoryFilter === cat.slug;
              return (
                <button
                  key={cat.slug}
                  type="button"
                  aria-pressed={active}
                  data-testid={`filter-category-${cat.slug}`}
                  onClick={() => onCategoryFilterChange(cat.slug)}
                  className={chipClass(active)}
                >
                  {cat.display}{" "}
                  <span className="tabular-nums opacity-80">{categoryCount(cat.slug)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="jh-search-input"
            className="text-[11px] font-semibold uppercase tracking-wider text-slate-400"
          >
            Search
          </label>
          <input
            id="jh-search-input"
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Organisation or role"
            className="px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-200 min-w-[200px]"
          />
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
        <table data-testid="jh-applications-table" className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <th className="text-left py-2.5 px-3 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onSortChange("org")}
                  className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                >
                  Organisation &amp; role {sortKey === "org" ? (sortDir === 1 ? "↑" : "↓") : ""}
                </button>
              </th>
              <th className="text-left py-2.5 px-3 whitespace-nowrap">Category</th>
              <th className="text-left py-2.5 px-3 whitespace-nowrap">Channel</th>
              <th className="text-left py-2.5 px-3 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onSortChange("applied")}
                  className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                >
                  Applied {sortKey === "applied" ? (sortDir === 1 ? "↑" : "↓") : ""}
                </button>
              </th>
              <th className="text-left py-2.5 px-3 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onSortChange("status")}
                  className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                >
                  Status {sortKey === "status" ? (sortDir === 1 ? "↑" : "↓") : ""}
                </button>
              </th>
              <th className="text-left py-2.5 px-3 whitespace-nowrap">Last action</th>
              <th className="text-left py-2.5 px-3 whitespace-nowrap">Next action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  No applications match these filters.
                </td>
              </tr>
            ) : (
              rows.map((app) => {
                const latestHistory =
                  app.stage_history.length > 0
                    ? app.stage_history[app.stage_history.length - 1]
                    : null;
                const task = app.open_task;
                const isTaskBusy = Boolean(task && busyTaskId === task.id);
                const isRescheduling = Boolean(task && rescheduleTaskId === task.id);

                return (
                  <tr
                    key={app.id}
                    data-testid={`jh-app-row-${app.id}`}
                    className="border-b border-slate-800/60 align-top hover:bg-slate-800/40"
                  >
                    <td className="py-3 px-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-white">
                            {app.organisation_name ?? app.title}
                          </div>
                          <div className="text-slate-400 mt-0.5">{app.role_title}</div>
                          {app.platform_ref && (
                            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                              Ref: {app.platform_ref}
                            </div>
                          )}
                          <ApplicationSignalBadges application={app} />
                        </div>
                        {onEditApplication && (
                          <button
                            type="button"
                            onClick={() => onEditApplication(app)}
                            className="px-2 py-0.5 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 shrink-0"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    </td>

                    <td className="py-3 px-3 whitespace-nowrap">
                      <span className="inline-block px-2 py-0.5 rounded border border-slate-700 text-slate-300 text-[11px]">
                        {formatRoleCategoryLabel(app.role_category)}
                      </span>
                    </td>

                    <td className="py-3 px-3">
                      <div className="text-slate-200">{formatChannelLabel(app.channel)}</div>
                      {(app.job_site || app.ats) && (
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {[app.job_site?.title, app.ats].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-3 whitespace-nowrap text-slate-300 tabular-nums">
                      {app.applied_on ? formatShortDate(app.applied_on) : "Not submitted"}
                    </td>

                    <td className="py-3 px-3 space-y-1.5">
                      <StagePill application={app} />
                      <div>
                        <select
                          aria-label={`Stage for ${app.organisation_name ?? app.title} ${app.role_title}`}
                          data-testid={`stage-select-${app.id}`}
                          value={app.stage}
                          disabled={busyAppId === app.id}
                          onChange={(e) =>
                            void onStageChange?.(app.id, e.target.value as JobApplicationStage)
                          }
                          className="px-2 py-1 text-[11px] bg-slate-900 border border-slate-700 rounded text-slate-200"
                        >
                          {JOB_APPLICATION_STAGES.map((stageDef) => (
                            <option key={stageDef.slug} value={stageDef.slug}>
                              {stageDef.display}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>

                    <td className="py-3 px-3 max-w-[240px]">
                      <div className="text-[11px] text-slate-400 tabular-nums">
                        {formatShortDate(app.last_action_at ?? latestHistory?.at)}
                      </div>
                      <div className="text-slate-300 mt-0.5">
                        {latestHistory?.note || app.notes || `Stage: ${app.stage}`}
                      </div>
                    </td>

                    <td className="py-3 px-3 min-w-[200px]">
                      {task ? (
                        <div className="space-y-1.5">
                          <div className="text-slate-200 font-medium">{task.title}</div>
                          <div className="text-[11px] text-slate-400 tabular-nums">
                            {task.due_date ? `Due ${formatShortDate(task.due_date)}` : "No due date"}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isTaskBusy}
                              onClick={() => void onCompleteTask?.(task.id)}
                              className="px-2 py-0.5 text-[11px] font-semibold rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white"
                            >
                              Complete
                            </button>
                            <button
                              type="button"
                              disabled={isTaskBusy}
                              onClick={() => {
                                if (isRescheduling) {
                                  setRescheduleTaskId(null);
                                } else {
                                  setRescheduleTaskId(task.id);
                                  setRescheduleDate(toDateInputValue(task.due_date));
                                }
                              }}
                              className="px-2 py-0.5 text-[11px] rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 border border-slate-700"
                            >
                              {isRescheduling ? "Cancel" : "Reschedule"}
                            </button>
                          </div>
                          {isRescheduling && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (rescheduleDate) {
                                  void onRescheduleTask?.(task.id, rescheduleDate);
                                  setRescheduleTaskId(null);
                                }
                              }}
                              className="flex items-center gap-1 pt-1"
                            >
                              <input
                                type="date"
                                aria-label={`New due date for ${task.title}`}
                                value={rescheduleDate}
                                onChange={(e) => setRescheduleDate(e.target.value)}
                                required
                                className="px-1.5 py-0.5 text-[11px] bg-slate-900 border border-slate-700 rounded text-slate-200"
                              />
                              <button
                                type="submit"
                                disabled={isTaskBusy || !rescheduleDate}
                                className="px-2 py-0.5 text-[11px] font-semibold rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
                              >
                                Save
                              </button>
                            </form>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400">
                          {app.cadence.action !== "none"
                            ? app.cadence.taskSpec?.title ?? "Cadence due"
                            : "Closed / no open task"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
