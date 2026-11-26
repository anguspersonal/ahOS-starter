import { useState, useEffect } from "react";
import type { ArchitectureNodeData } from "./types.js";
import { ARCHITECTURE_VIEWS, type ViewId } from "./views/index.js";
import { ArchitectureView } from "./ArchitectureView.js";
import { useSystemTelemetry } from "./useSystemTelemetry.js";

function getInitialViewId(): ViewId {
  if (typeof window === "undefined") return "repo-current";
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") as ViewId | null;
  if (view && ARCHITECTURE_VIEWS[view]) {
    return view;
  }
  return "repo-current";
}

interface ViewGroupItem {
  id: ViewId;
  label: string;
  icon: string;
  badge: string;
}

interface ViewGroup {
  id: "current" | "future";
  label: string;
  badge: string;
  badgeColor: string;
  views: ViewGroupItem[];
}

const VIEW_GROUPS: ViewGroup[] = [
  {
    id: "current",
    label: "Current State",
    badge: "As-Built",
    badgeColor: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    views: [
      {
        id: "infra-current",
        label: "System Context",
        icon: "☁️",
        badge: "View 0",
      },
      {
        id: "repo-current",
        label: "Monorepo & CI",
        icon: "📁",
        badge: "View 2",
      },
      {
        id: "gitdiagram",
        label: "Execution Flow",
        icon: "⚡",
        badge: "View 4",
      },
      {
        id: "db-current",
        label: "Conceptual ERD",
        icon: "🗄️",
        badge: "View 5",
      },
      {
        id: "db-vision",
        label: "Physical Schema ERD",
        icon: "💾",
        badge: "View 6",
      },
    ],
  },
  {
    id: "future",
    label: "Target Roadmap",
    badge: "Evolution",
    badgeColor: "bg-purple-500/15 text-purple-400 border-purple-500/30",
    views: [
      {
        id: "infra-vision",
        label: "Hexagonal Ports",
        icon: "🔷",
        badge: "View 1",
      },
      {
        id: "repo-vision",
        label: "Modular Toolpacks",
        icon: "🔌",
        badge: "View 3",
      },
    ],
  },
];

interface ConsolidatedPerspective {
  id: "infra" | "repo" | "db" | "flow";
  label: string;
  icon: string;
  currentId: ViewId;
  futureId?: ViewId;
}

const PERSPECTIVES: ConsolidatedPerspective[] = [
  {
    id: "infra",
    label: "System Context & Topology",
    icon: "☁️",
    currentId: "infra-current",
    futureId: "infra-vision",
  },
  {
    id: "repo",
    label: "Monorepo & Toolpacks",
    icon: "📁",
    currentId: "repo-current",
    futureId: "repo-vision",
  },
  {
    id: "flow",
    label: "Execution & Data Lifecycle Flow",
    icon: "⚡",
    currentId: "gitdiagram",
  },
  {
    id: "db",
    label: "Database & Storage Schema",
    icon: "🗄️",
    currentId: "db-current",
    futureId: "db-vision",
  },
];

export function VisualMeaningCanvas() {
  const [activeViewId, setActiveViewId] = useState<ViewId>(() => getInitialViewId());
  const [selectedNode, setSelectedNode] = useState<ArchitectureNodeData | null>(null);
  const [showMermaidSource, setShowMermaidSource] = useState(false);
  const [copiedMermaid, setCopiedMermaid] = useState(false);
  const [isProbingNode, setIsProbingNode] = useState(false);

  const telemetry = useSystemTelemetry();

  useEffect(() => {
    const handlePopState = () => {
      const current = getInitialViewId();
      setActiveViewId(current);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const activeView = ARCHITECTURE_VIEWS[activeViewId];

  // Active Horizon and Perspective for consolidated navigation
  const activeHorizon = activeViewId.includes("vision") ? "future" : "current";
  const activePerspectiveId = activeViewId.includes("infra")
    ? "infra"
    : activeViewId.includes("repo")
    ? "repo"
    : activeViewId.includes("db")
    ? "db"
    : "flow";

  const handleViewChange = (id: ViewId) => {
    setActiveViewId(id);
    setSelectedNode(null);
    setShowMermaidSource(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", id);
      window.history.replaceState(null, "", url.pathname + url.search);
    }
  };

  const handlePerspectiveChange = (perspectiveId: ConsolidatedPerspective["id"]) => {
    const target = PERSPECTIVES.find((p) => p.id === perspectiveId);
    if (!target) return;
    if (activeHorizon === "future" && target.futureId) {
      handleViewChange(target.futureId);
    } else {
      handleViewChange(target.currentId);
    }
  };

  const handleHorizonToggle = (horizon: "current" | "future") => {
    const target = PERSPECTIVES.find((p) => p.id === activePerspectiveId);
    if (!target) return;
    if (horizon === "future" && target.futureId) {
      handleViewChange(target.futureId);
    } else {
      handleViewChange(target.currentId);
    }
  };

  const handleCopyMermaid = async () => {
    if (!activeView.rawMermaid) return;
    try {
      await navigator.clipboard.writeText(activeView.rawMermaid);
      setCopiedMermaid(true);
      setTimeout(() => setCopiedMermaid(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleProbeSelectedNode = async () => {
    if (!selectedNode) return;
    setIsProbingNode(true);
    await telemetry.probeNode(selectedNode.id);
    setTimeout(() => setIsProbingNode(false), 400);
  };

  const selectedNodeTelemetry = selectedNode ? telemetry.telemetryMap[selectedNode.id] : null;

  return (
    <div className="space-y-6">
      {/* 1. Header & Live Observation Panel Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">
              Visual Meaning
            </h2>
            <span className="px-2.5 py-0.5 bg-blue-500/20 text-blue-400 border border-blue-500/30 text-xs font-mono font-medium rounded-full">
              7 views · 4 perspectives
            </span>
            <span className="px-2.5 py-0.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-mono font-medium rounded-full flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Observation Panel</span>
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Schematic system architecture models: live telemetry, repository structure, cloud infrastructure, Supabase ER diagrams, and gitDiagram code flow.
          </p>
        </div>

        {/* Live Telemetry Status Bar & Actions */}
        <div className="flex flex-wrap items-center gap-2.5 bg-slate-900/90 border border-slate-800 p-2 rounded-xl text-xs">
          <button
            type="button"
            onClick={telemetry.toggleObservationMode}
            className={`px-3 py-1.5 rounded-lg font-mono text-xs font-semibold transition-all flex items-center gap-2 border ${
              telemetry.isObservationMode
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shadow-sm"
                : "bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200"
            }`}
            data-testid="toggle-observation-mode"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                telemetry.isObservationMode ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
              }`}
            />
            <span>{telemetry.isObservationMode ? "Observation Mode: ON" : "Observation Mode: OFF"}</span>
          </button>

          {telemetry.isObservationMode && (
            <>
              <div className="h-4 w-px bg-slate-800" />
              <div className="flex items-center gap-2 font-mono text-[11px] text-slate-300 px-1">
                <span>Core DB:</span>
                <span className="text-emerald-400 font-bold">
                  {telemetry.dbLatencyMs !== null ? `${telemetry.dbLatencyMs}ms` : "Live"}
                </span>
                {telemetry.atomCount !== null && (
                  <>
                    <span className="text-slate-600">|</span>
                    <span className="text-blue-400 font-bold">{telemetry.atomCount}</span>
                    <span className="text-slate-400">atoms</span>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={() => telemetry.runFullProbe()}
                disabled={telemetry.isProbing}
                className="px-2.5 py-1 text-xs font-mono font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
                data-testid="button-probe-all"
              >
                <span>{telemetry.isProbing ? "Probing..." : "Probe ⚡"}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 1b. Consolidated Perspective & Horizon Navigator */}
      <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Consolidated Perspectives (4 high-density views) */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-400 mr-1">
            Perspective:
          </span>
          {PERSPECTIVES.map((p) => {
            const isActive = p.id === activePerspectiveId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePerspectiveChange(p.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-2 border ${
                  isActive
                    ? "bg-blue-600 text-white border-blue-400 shadow-md shadow-blue-500/20"
                    : "bg-slate-950/70 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800/80"
                }`}
                data-testid={`perspective-${p.id}`}
              >
                <span>{p.icon}</span>
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Horizon Toggle (Now vs Future) */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 shrink-0">
          <span className="text-[10px] font-mono uppercase text-slate-400 px-2 font-bold">Horizon:</span>
          <button
            type="button"
            onClick={() => handleHorizonToggle("current")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
              activeHorizon === "current"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            data-testid="horizon-current"
          >
            Now (As-Built)
          </button>
          <button
            type="button"
            onClick={() => handleHorizonToggle("future")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
              activeHorizon === "future"
                ? "bg-purple-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            data-testid="horizon-future"
          >
            Future (Vision)
          </button>
        </div>
      </div>

      {/* 1c. Granular View Switcher: Current State vs Future State (Full Backward Compatibility) */}
      <div className="flex flex-wrap items-center gap-3">
        {VIEW_GROUPS.map((group) => {
          const isGroupActive = group.views.some((v) => v.id === activeViewId);
          return (
            <div
              key={group.id}
              className={`flex items-center gap-1.5 p-1.5 rounded-xl border transition-all ${
                isGroupActive
                  ? "bg-slate-900 border-slate-700 shadow-md shadow-black/40"
                  : "bg-slate-900/60 border-slate-800/80"
              }`}
              data-testid={`group-container-${group.id}`}
            >
              {/* Group Label Header */}
              <div className="flex items-center gap-1.5 pl-2 pr-1.5 py-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300 font-mono">
                  {group.label}
                </span>
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${group.badgeColor}`}
                >
                  {group.badge}
                </span>
              </div>

              {/* Divider */}
              <div className="h-4 w-px bg-slate-800" />

              {/* View Buttons */}
              <div className="flex items-center gap-1">
                {group.views.map((item) => {
                  const isActive = activeViewId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleViewChange(item.id)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-2 ${
                        isActive
                          ? group.id === "current"
                            ? "bg-blue-600 text-white shadow-md shadow-blue-500/25 ring-1 ring-blue-400/50"
                            : "bg-purple-600 text-white shadow-md shadow-purple-500/25 ring-1 ring-purple-400/50"
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/80"
                      }`}
                      data-testid={`tab-${item.id}`}
                    >
                      <span className="text-sm">{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. Active View Summary Banner */}
      <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">{activeView.title}</h3>
            <span className={`px-2 py-0.5 text-[10px] font-mono rounded ${activeView.badge.color}`}>
              {activeView.badge.text}
            </span>
          </div>
          <p className="text-xs text-slate-400 max-w-3xl">
            {activeView.summary}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {activeView.rawMermaid && (
            <button
              type="button"
              onClick={() => setShowMermaidSource((prev) => !prev)}
              className="px-2.5 py-1 text-xs font-mono rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5"
            >
              <span>{showMermaidSource ? "Hide Mermaid Source" : "View Mermaid Source"}</span>
            </button>
          )}
          <div className="text-[11px] text-slate-400 font-mono flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span>Click any node to inspect</span>
          </div>
        </div>
      </div>

      {/* 2b. Optional Raw Mermaid Flowchart Viewer */}
      {showMermaidSource && activeView.rawMermaid && (
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold text-slate-200">
                Mermaid Flowchart Source (gitDiagram)
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                flowchart TD
              </span>
            </div>
            <button
              type="button"
              onClick={handleCopyMermaid}
              className="px-2.5 py-1 text-xs font-mono rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {copiedMermaid ? "Copied!" : "Copy Mermaid"}
            </button>
          </div>
          <pre className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto max-h-72 leading-relaxed selection:bg-blue-500/30">
            {activeView.rawMermaid}
          </pre>
        </div>
      )}

      {/* 3. Reusable Architecture Canvas */}
      <div className="relative">
        <ArchitectureView
          view={activeView}
          selectedNodeId={selectedNode?.id}
          onSelectNode={setSelectedNode}
          isObservationMode={telemetry.isObservationMode}
          telemetryMap={telemetry.telemetryMap}
        />
      </div>

      {/* 4. Interactive Node Inspector (Context Drawer & Live Observation Panel) */}
      {selectedNode && (
        <div
          className="p-5 bg-slate-900 border border-blue-500/40 rounded-xl space-y-3 transition-all animate-in fade-in duration-200 shadow-xl"
          data-testid="node-inspector"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-base shadow-sm"
                style={{ backgroundColor: selectedNode.iconBg || "#2563eb" }}
              >
                {typeof selectedNode.icon === "string" ? selectedNode.icon : "•"}
              </div>
              <div>
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <span>{selectedNode.title}</span>
                  {selectedNode.subtitle && (
                    <span className="text-xs font-normal text-slate-400 font-mono">
                      ({selectedNode.subtitle})
                    </span>
                  )}
                </h4>
                <p className="text-xs text-blue-400 font-medium">
                  {selectedNode.details?.role || "Architectural Node"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              className="text-xs text-slate-400 hover:text-white px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded transition-colors"
            >
              ✕ Close
            </button>
          </div>

          {/* Live Observation & Diagnostics Panel for Node */}
          {telemetry.isObservationMode && selectedNodeTelemetry && (
            <div
              className="p-3 bg-slate-950 border border-emerald-500/30 rounded-lg space-y-2 text-xs font-mono"
              data-testid="node-inspector-telemetry"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="font-bold text-slate-200 uppercase tracking-wide text-[11px]">
                    Live Telemetry Probe
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                      selectedNodeTelemetry.status === "healthy"
                        ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                        : selectedNodeTelemetry.status === "warning"
                        ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                        : "bg-red-500/20 text-red-400 border-red-500/30"
                    }`}
                  >
                    {selectedNodeTelemetry.statusText}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {selectedNodeTelemetry.latencyMs !== undefined && (
                    <span className="text-[11px] text-emerald-400 font-bold">
                      {selectedNodeTelemetry.latencyMs}ms roundtrip
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleProbeSelectedNode}
                    disabled={isProbingNode}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1 text-[10px]"
                    data-testid="probe-node-btn"
                  >
                    <span>{isProbingNode ? "Testing..." : "Re-Probe ⚡"}</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1 border-t border-slate-800 text-[11px]">
                {selectedNodeTelemetry.metricLabel && (
                  <div className="text-slate-300">
                    <span className="text-slate-500">{selectedNodeTelemetry.metricLabel}: </span>
                    <span className="text-blue-400 font-bold">{selectedNodeTelemetry.metricValue}</span>
                  </div>
                )}
                {selectedNodeTelemetry.endpointUrl && (
                  <div className="text-slate-300 truncate">
                    <span className="text-slate-500">Endpoint: </span>
                    <span className="text-slate-300">{selectedNodeTelemetry.endpointUrl}</span>
                  </div>
                )}
              </div>

              {selectedNodeTelemetry.diagnostics && selectedNodeTelemetry.diagnostics.length > 0 && (
                <div className="pt-1.5 border-t border-slate-900 space-y-1">
                  {selectedNodeTelemetry.diagnostics.map((diag, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-slate-400 text-[10.5px]">
                      <span className="text-emerald-400">✓</span>
                      <span>{diag}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-slate-800 text-xs">
            <div>
              <span className="text-slate-400 block font-mono text-[10px] uppercase">Responsibilities</span>
              <ul className="mt-1 space-y-1 text-slate-300">
                {Array.isArray(selectedNode.description) ? (
                  selectedNode.description.map((d, i) => <li key={i}>{d}</li>)
                ) : (
                  <li>{selectedNode.description}</li>
                )}
              </ul>
            </div>
            <div>
              <span className="text-slate-400 block font-mono text-[10px] uppercase">File References / Code</span>
              <p className="mt-1 font-mono text-emerald-400 truncate">
                {selectedNode.details?.filesOrPath || "N/A"}
              </p>
              {selectedNode.details?.url && (
                <div className="mt-1.5">
                  <a
                    href={selectedNode.details.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-mono text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    <span>View on GitHub</span>
                    <span>↗</span>
                  </a>
                </div>
              )}
              {selectedNode.details?.adrOrIssue && (
                <p className="mt-1 text-slate-400 font-mono text-[11px]">
                  Ref: <span className="text-indigo-400 font-semibold">{selectedNode.details.adrOrIssue}</span>
                </p>
              )}
            </div>
            <div>
              <span className="text-slate-400 block font-mono text-[10px] uppercase">Architecture Notes</span>
              <p className="mt-1 text-slate-300 leading-relaxed">
                {selectedNode.details?.notes || "Part of the core ahOS system pipeline."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 5. Sequence & Data Flow Walkthrough */}
      <div className="p-5 bg-slate-900/50 border border-slate-800 rounded-xl space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <span>Sequence & Data Flow Steps</span>
            <span className="px-1.5 py-0.2 bg-blue-500/20 text-blue-400 text-[10px] rounded font-mono">
              [1] - [{activeView.stepBreakdown.length}]
            </span>
          </h4>
          <span className="text-[11px] text-slate-400 font-mono">Numbered badges on schematic</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {activeView.stepBreakdown.map((item) => (
            <div
              key={item.step}
              className="p-3 bg-slate-900 border border-slate-800/80 rounded-lg flex items-start gap-3 hover:border-slate-700 transition-colors"
            >
              <div className="w-6 h-6 rounded bg-[#0073bb] text-white font-bold text-xs flex items-center justify-center shrink-0">
                {item.step}
              </div>
              <div className="space-y-0.5">
                <h5 className="text-xs font-bold text-slate-200">{item.title}</h5>
                <p className="text-[11px] text-slate-400 leading-relaxed">{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
