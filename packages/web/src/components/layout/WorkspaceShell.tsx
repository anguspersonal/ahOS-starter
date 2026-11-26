import { useEffect } from "react";
import { useAuth } from "../auth/AuthGate.js";
import { QuickCaptureBar } from "../capture/QuickCaptureBar.js";
import { CoEditorCanvas } from "../editor/CoEditorCanvas.js";
import { PriorityInboxCanvas } from "../inbox/PriorityInboxCanvas.js";
import { DecisionReviewCanvas } from "../decisions/DecisionReviewCanvas.js";
import { ApprovalsCanvas } from "../approvals/ApprovalsCanvas.js";
import { LedgerView } from "../ledger/LedgerView.js";
import { FreshCanvas } from "../fresh/FreshCanvas.js";
import { DashboardCanvas } from "../dashboard/DashboardCanvas.js";
import { DosConfigSettingsCanvas } from "../dashboard/DosConfigSettingsCanvas.js";
import { ChatCanvas } from "../chat/ChatCanvas.js";
import { VisualMeaningCanvas } from "../visual-meaning/VisualMeaningCanvas.js";
import { EntityGraphCanvas } from "../graph/EntityGraphCanvas.js";
import { JobHuntCanvas } from "../jobhunt/JobHuntCanvas.js";
import { registerSettingsNavigationRoutes } from "../../lib/navigateAction.js";
import { useActiveTab, type ActiveTab } from "../../lib/router.js";
import { ThemeToggle } from "../../lib/theme.js";
import { setScreenTab } from "../../lib/screenState.js";

registerSettingsNavigationRoutes();

export function WorkspaceShell() {
  const { user, signOut } = useAuth();
  const [activeTab, setActiveTab] = useActiveTab();
  const isSettingsTab =
    (activeTab as string) === "settings" || (activeTab as string) === "dos_config";

  useEffect(() => {
    setScreenTab(activeTab);
  }, [activeTab]);

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* 1. Global Header */}
      <header className="h-16 border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 flex items-center justify-between gap-6 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-sm border border-indigo-500/30">
            ah
          </div>
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">ahOS Co-Editing Workspace</h1>
            <span className="text-[10px] text-slate-400 block font-mono">Phase 2 / ADR-100</span>
          </div>
        </div>

        {/* Global Quick Capture input */}
        <div className="flex-1 max-w-xl">
          <QuickCaptureBar />
        </div>

        {/* User Identity, Theme Toggle & Session Status */}
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <div className="flex items-center gap-2 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-full text-[11px] text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono truncate max-w-[140px]">{user?.email || "owner"}</span>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors border border-slate-700/60"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* 2. Navigation Tabs */}
      <div className="border-b border-slate-800 bg-slate-950 px-6 flex items-center justify-between gap-4">
        <nav className="flex space-x-6 overflow-x-auto whitespace-nowrap">
          <button
            type="button"
            onClick={() => setActiveTab("documents")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "documents"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Living Documents</span>
            <span className="px-1.5 py-0.2 bg-slate-800 text-[10px] rounded text-slate-300 font-mono">3</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("inbox")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "inbox"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Priority Inbox</span>
            <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 text-[10px] rounded font-mono">5+</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("decisions")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "decisions"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Decision Backlog (#1218)</span>
            <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 text-[10px] rounded font-mono">3</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("approvals")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "approvals"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Approvals</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("ledger")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "ledger"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Ledger</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("fresh")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "fresh"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Fresh</span>
            <span className="px-1.5 py-0.2 bg-emerald-500/20 text-emerald-400 text-[10px] rounded font-mono">new</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("dashboard")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "dashboard"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Dashboard</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("chat")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "chat"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Chat</span>
            <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 text-[10px] rounded font-mono">Gemini</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("visual-meaning")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "visual-meaning"
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Visual meaning</span>
            <span className="px-1.5 py-0.2 bg-blue-500/20 text-blue-400 text-[10px] rounded font-mono">7 views</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("graph")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "graph"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Graph</span>
            <span className="px-1.5 py-0.2 bg-emerald-500/20 text-emerald-400 text-[10px] rounded font-mono">Live</span>
          </button>
          <button
            type="button"
            data-testid="nav-tab-job-hunt"
            onClick={() => setActiveTab("job-hunt")}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === "job-hunt"
                ? "border-amber-500 text-amber-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Job hunt</span>
          </button>
          <button
            type="button"
            data-testid="nav-tab-settings"
            onClick={() => setActiveTab("settings" as ActiveTab)}
            className={`py-3 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
              isSettingsTab
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            <span>Settings</span>
            <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 text-[10px] rounded font-mono">dos_config</span>
          </button>
        </nav>
        <div className="text-[11px] text-slate-400 font-mono shrink-0">
          Strict Auth Gated: Zero Public Surface
        </div>
      </div>

      {/* 3. Main Workspace Surface */}
      <main
        className={`flex-1 p-4 sm:p-6 w-full transition-all duration-150 ${
          activeTab === "graph" || activeTab === "visual-meaning"
            ? "max-w-none px-4 sm:px-8"
            : "max-w-7xl mx-auto"
        }`}
      >
        {activeTab === "documents" && <CoEditorCanvas />}
        {activeTab === "inbox" && <PriorityInboxCanvas />}
        {activeTab === "decisions" && <DecisionReviewCanvas />}
        {activeTab === "approvals" && <ApprovalsCanvas />}
        {activeTab === "ledger" && <LedgerView />}
        {activeTab === "fresh" && <FreshCanvas />}
        {activeTab === "dashboard" && <DashboardCanvas />}
        {activeTab === "chat" && <ChatCanvas />}
        {activeTab === "visual-meaning" && <VisualMeaningCanvas />}
        {activeTab === "graph" && <EntityGraphCanvas />}
        {activeTab === "job-hunt" && <JobHuntCanvas />}
        {isSettingsTab && <DosConfigSettingsCanvas />}
      </main>
    </div>
  );
}
