import { useCallback, useEffect, useMemo, useState } from "react";
import {
  JOB_HUNT_SUB_TABS,
  buildNextUpItems,
  completeJobHuntTask,
  fetchJobPipeline,
  isPendingApprovalResponse,
  rescheduleJobHuntTask,
  updateApplicationStage,
  upsertJobApplication,
  type JobApplicationCandidate,
  type JobApplicationStage,
  type JobApplicationUpsertClientInput,
  type JobHuntSortDirection,
  type JobHuntSortKey,
  type JobHuntStatusFilter,
  type JobHuntSubTab,
  type JobPipelineApplicationItem,
  type JobPipelineReadResult,
  type RoleCategory,
} from "../../lib/jobHuntActions.js";
import { navigateToTab } from "../../lib/router.js";
import { ApplicationUpsertForm } from "./ApplicationUpsertForm.js";
import { ApplicationsTable } from "./ApplicationsTable.js";
import { NextUpSection } from "./NextUpSection.js";
import { OutcomesInsightsSection } from "./OutcomesInsightsSection.js";
import { PipelineTotalsStrip } from "./PipelineTotalsStrip.js";
import {
  JobSitesTable,
  OrganisationsTable,
  RecruitersTable,
} from "./SecondaryTables.js";

export interface JobHuntCanvasProps {
  initialData?: JobPipelineReadResult | null;
  initialTab?: JobHuntSubTab;
  initialStatusFilter?: JobHuntStatusFilter;
  initialCategoryFilter?: RoleCategory | "all";
  initialSearch?: string;
  initialShowNewForm?: boolean;
  autoLoad?: boolean;
}

function readSubTabFromHash(): JobHuntSubTab | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  return (JOB_HUNT_SUB_TABS as readonly string[]).includes(raw)
    ? (raw as JobHuntSubTab)
    : null;
}

function writeSubTabToHash(tab: JobHuntSubTab): void {
  if (typeof window === "undefined") return;
  const targetHash = `#${tab}`;
  if (window.location.hash !== targetHash && window.history?.replaceState) {
    window.history.replaceState(null, "", `${window.location.pathname}${targetHash}`);
  }
}

export function JobHuntCanvas({
  initialData = null,
  initialTab,
  initialStatusFilter = "all",
  initialCategoryFilter = "all",
  initialSearch = "",
  initialShowNewForm = false,
  autoLoad = true,
}: JobHuntCanvasProps = {}) {
  const [data, setData] = useState<JobPipelineReadResult | null>(initialData);
  const [loading, setLoading] = useState<boolean>(!initialData && autoLoad);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);

  const [activeSubTab, setActiveSubTab] = useState<JobHuntSubTab>(
    () => initialTab ?? readSubTabFromHash() ?? "applications",
  );
  const [statusFilter, setStatusFilter] =
    useState<JobHuntStatusFilter>(initialStatusFilter);
  const [categoryFilter, setCategoryFilter] = useState<RoleCategory | "all">(
    initialCategoryFilter,
  );
  const [search, setSearch] = useState<string>(initialSearch);
  const [sortKey, setSortKey] = useState<JobHuntSortKey>("status");
  const [sortDir, setSortDir] = useState<JobHuntSortDirection>(1);

  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState<boolean>(false);
  const [showForm, setShowForm] = useState<boolean>(initialShowNewForm);
  const [editingApp, setEditingApp] =
    useState<JobPipelineApplicationItem | null>(null);
  const [pendingUpsertInput, setPendingUpsertInput] =
    useState<JobApplicationUpsertClientInput | null>(null);
  const [ambiguousCandidates, setAmbiguousCandidates] = useState<
    readonly JobApplicationCandidate[]
  >([]);

  const refreshPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchJobPipeline({ include_closed: true });
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoLoad && !initialData) {
      void refreshPipeline();
    }
  }, [autoLoad, initialData, refreshPipeline]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      const fromHash = readSubTabFromHash();
      if (fromHash) setActiveSubTab(fromHash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const handleSelectSubTab = (tab: JobHuntSubTab) => {
    setActiveSubTab(tab);
    writeSubTabToHash(tab);
  };

  const handleSortChange = (nextKey: JobHuntSortKey) => {
    if (sortKey === nextKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(nextKey);
      setSortDir(nextKey === "applied" ? -1 : 1);
    }
  };

  const handleUpsertSubmit = async (input: JobApplicationUpsertClientInput) => {
    setFormBusy(true);
    setError(null);
    setNotice(null);
    setPendingApprovalId(null);
    setAmbiguousCandidates([]);
    try {
      const res = await upsertJobApplication(input);
      if (isPendingApprovalResponse(res)) {
        setPendingApprovalId(res.decision_id);
        setNotice(
          res.message ??
            `Application change parked for owner approval (decision ${res.decision_id}).`,
        );
        setShowForm(false);
        setEditingApp(null);
        return;
      }
      if (res.status === "ambiguous") {
        setPendingUpsertInput(input);
        setAmbiguousCandidates(res.candidates ?? []);
        setNotice(res.message);
        return;
      }
      setNotice(res.message);
      setShowForm(false);
      setEditingApp(null);
      setPendingUpsertInput(null);
      await refreshPipeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFormBusy(false);
    }
  };

  const handleSelectAmbiguousCandidate = async (candidateId: string) => {
    if (!pendingUpsertInput) return;
    await handleUpsertSubmit({ ...pendingUpsertInput, id: candidateId });
  };

  const handleStageChange = async (
    appId: string,
    nextStage: JobApplicationStage,
  ) => {
    setBusyAppId(appId);
    setError(null);
    setNotice(null);
    setPendingApprovalId(null);
    try {
      const res = await updateApplicationStage({ id: appId, stage: nextStage });
      if (isPendingApprovalResponse(res)) {
        setPendingApprovalId(res.decision_id);
        setNotice(
          res.message ??
            `Stage change parked for owner approval (decision ${res.decision_id}).`,
        );
        return;
      }
      setNotice(res.message);
      await refreshPipeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAppId(null);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    setBusyTaskId(taskId);
    setError(null);
    setNotice(null);
    try {
      await completeJobHuntTask(taskId);
      setNotice("Task completed.");
      await refreshPipeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleRescheduleTask = async (taskId: string, dateInput: string) => {
    setBusyTaskId(taskId);
    setError(null);
    setNotice(null);
    try {
      await rescheduleJobHuntTask(taskId, dateInput);
      setNotice(`Task rescheduled to ${dateInput}.`);
      await refreshPipeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskId(null);
    }
  };

  const nextUpItems = useMemo(
    () => (data ? buildNextUpItems(data) : []),
    [data],
  );

  const subTabs: ReadonlyArray<{
    id: JobHuntSubTab;
    label: string;
    count: number;
  }> = [
    {
      id: "applications",
      label: "Applications",
      count: data?.applications.length ?? 0,
    },
    {
      id: "organisations",
      label: "Organisations",
      count: data?.organisations.length ?? 0,
    },
    {
      id: "job-sites",
      label: "Job sites",
      count: data?.job_sites.length ?? 0,
    },
    {
      id: "recruiters",
      label: "Recruiters",
      count: data?.recruiters.length ?? 0,
    },
  ];

  return (
    <div data-testid="job-hunt-canvas" className="space-y-7">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-slate-700 pb-4">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold uppercase tracking-tight text-white">
            Job hunt <span className="text-amber-500">tracker</span>
          </h1>
          <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-slate-400">
            <span>Personal pipeline (ADR-120)</span>
            {data && (
              <span>
                As of <strong className="text-slate-200">{data.as_of}</strong> ·{" "}
                {data.total_count} tracked
              </span>
            )}
            {data && data.needs_attention.length > 0 && (
              <span
                data-testid="jh-needs-attention-badge"
                className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30 font-semibold"
              >
                Needs attention: {data.needs_attention.length}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="jh-new-application-btn"
            onClick={() => {
              setEditingApp(null);
              setPendingUpsertInput(null);
              setAmbiguousCandidates([]);
              setShowForm((prev) => !prev);
            }}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            {showForm && !editingApp ? "Close form" : "New application"}
          </button>
          <button
            type="button"
            disabled={loading}
            data-testid="jh-refresh-btn"
            onClick={() => void refreshPipeline()}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => navigateToTab("approvals")}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700"
          >
            Approvals inbox
          </button>
        </div>
      </header>

      {/* Banners */}
      {error && (
        <div
          role="alert"
          className="p-3 bg-rose-950/60 border border-rose-800 rounded-xl text-xs text-rose-200"
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="p-3 bg-slate-900 border border-indigo-500/40 rounded-xl text-xs text-slate-200 flex flex-wrap items-center justify-between gap-2"
        >
          <span>{notice}</span>
          {pendingApprovalId && (
            <button
              type="button"
              onClick={() => navigateToTab("approvals")}
              className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
            >
              Review in Approvals
            </button>
          )}
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && (
        <ApplicationUpsertForm
          key={editingApp?.id ?? "new"}
          editingApp={editingApp}
          busy={formBusy}
          ambiguousCandidates={ambiguousCandidates}
          onSubmit={handleUpsertSubmit}
          onSelectAmbiguousCandidate={handleSelectAmbiguousCandidate}
          onCancel={() => {
            setShowForm(false);
            setEditingApp(null);
            setPendingUpsertInput(null);
            setAmbiguousCandidates([]);
          }}
        />
      )}

      {/* Loading / Pipeline content */}
      {loading && !data ? (
        <div className="p-8 text-center bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-400">
          Loading job pipeline...
        </div>
      ) : data ? (
        <>
          <NextUpSection
            items={nextUpItems}
            busyTaskId={busyTaskId}
            onCompleteTask={handleCompleteTask}
            onRescheduleTask={handleRescheduleTask}
          />

          <PipelineTotalsStrip metrics={data.metrics} asOf={data.as_of} />

          <OutcomesInsightsSection metrics={data.metrics} />

          {/* Tabbed working tables */}
          <section aria-label="Tracker tables" className="space-y-2">
            <div
              role="tablist"
              aria-label="Job hunt views"
              className="flex flex-wrap gap-1 border-b border-slate-800"
            >
              {subTabs.map((tab) => {
                const selected = activeSubTab === tab.id;
                return (
                  <a
                    key={tab.id}
                    href={`#${tab.id}`}
                    role="tab"
                    aria-selected={selected}
                    data-testid={`jh-subtab-${tab.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      handleSelectSubTab(tab.id);
                    }}
                    className={`px-3.5 py-2.5 text-xs font-medium border-b-2 -mb-px inline-flex items-center gap-2 transition-colors ${
                      selected
                        ? "border-amber-500 text-white"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span className="text-[11px] text-slate-400 tabular-nums">
                      {tab.count}
                    </span>
                  </a>
                );
              })}
            </div>

            {activeSubTab === "applications" && (
              <ApplicationsTable
                applications={data.applications}
                statusFilter={statusFilter}
                categoryFilter={categoryFilter}
                search={search}
                sortKey={sortKey}
                sortDir={sortDir}
                busyAppId={busyAppId}
                busyTaskId={busyTaskId}
                onStatusFilterChange={setStatusFilter}
                onCategoryFilterChange={setCategoryFilter}
                onSearchChange={setSearch}
                onSortChange={handleSortChange}
                onStageChange={handleStageChange}
                onEditApplication={(app) => {
                  setEditingApp(app);
                  setPendingUpsertInput(null);
                  setAmbiguousCandidates([]);
                  setShowForm(true);
                }}
                onCompleteTask={handleCompleteTask}
                onRescheduleTask={handleRescheduleTask}
              />
            )}

            {activeSubTab === "organisations" && (
              <OrganisationsTable
                organisations={data.organisations}
                applications={data.applications}
              />
            )}

            {activeSubTab === "job-sites" && (
              <JobSitesTable jobSites={data.job_sites} />
            )}

            {activeSubTab === "recruiters" && (
              <RecruitersTable
                recruiters={data.recruiters}
                applications={data.applications}
              />
            )}
          </section>

          <footer className="border-t border-slate-800 pt-3.5 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-2">
            <span>
              Derived live via job_pipeline_read (14d silence threshold; 7/14/28d
              follow-up cadence; 42d closed_no_reply).
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => navigateToTab("decisions")}
                className="text-indigo-400 hover:underline"
              >
                Decision Backlog
              </button>
              <button
                type="button"
                onClick={() => navigateToTab("approvals")}
                className="text-indigo-400 hover:underline"
              >
                Approvals Inbox
              </button>
            </div>
          </footer>
        </>
      ) : null}
    </div>
  );
}
