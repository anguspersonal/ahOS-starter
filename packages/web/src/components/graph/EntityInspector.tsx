import { useState } from "react";
import type { GraphEdge, GraphNode } from "./types.js";
import { isTBoxEntity, TBOX_BADGE } from "./tbox.js";
import {
  isPersonEntity,
  resolveNodeClosenessRing,
  getNetworkRingDefinition,
  NETWORK_RINGS,
} from "./networkView.js";
import { defaultClientActionRegistry } from "../../lib/actionRegistry.js";
import type { GraphNodeLevelInput, GraphNodeLevelOutput } from "../../lib/graphLevelActions.js";
import type { RelationshipCrudInput, RelationshipCrudOutput } from "../../lib/relationshipActions.js";

interface EntityInspectorProps {
  selectedNode: GraphNode | null;
  selectedEdge: GraphEdge | null;
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
  onSelectNode: (node: GraphNode | null) => void;
  onSelectEdge: (edge: GraphEdge | null) => void;
  onClose: () => void;
  isIsolated: boolean;
  onToggleIsolate: () => void;
  onUpdateZoomLevel?: (nodeId: string, zoomLevel: number) => void;
  onToggleTBox?: (nodeId: string, isTBox: boolean) => void;
  onUpdateClosenessRing?: (nodeId: string, ring: number) => void;
  onRelationshipCreated?: (newEdge: GraphEdge) => void;
  onRelationshipDeleted?: (edgeId: string) => void;
}


export function getTypeBadgeColor(type: string): { bg: string; text: string; border: string; icon: string } {
  switch (type.toLowerCase()) {
    case "people":
    case "person":
      return { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/30", icon: "👤" };
    case "project":
      return { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30", icon: "🚀" };
    case "area":
      return { bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/30", icon: "📁" };
    case "resource":
      return { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30", icon: "📚" };
    case "concept":
      return { bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/30", icon: "💡" };
    case "capability":
      return { bg: "bg-rose-500/10", text: "text-rose-400", border: "border-rose-500/30", icon: "⚡" };
    case "domain":
      return { bg: "bg-cyan-500/10", text: "text-cyan-400", border: "border-cyan-500/30", icon: "🌐" };
    case "organization":
      return { bg: "bg-indigo-500/10", text: "text-indigo-400", border: "border-indigo-500/30", icon: "🏢" };
    case "term":
      return { bg: "bg-teal-500/10", text: "text-teal-400", border: "border-teal-500/30", icon: "🏷️" };
    case "event":
      return { bg: "bg-orange-500/10", text: "text-orange-400", border: "border-orange-500/30", icon: "📅" };
    case "place":
    case "places":
    case "location":
      return { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30", icon: "📍" };
    case "t-box":
    case "tbox":
    case "t_box":
      return { bg: TBOX_BADGE.bg, text: TBOX_BADGE.text, border: TBOX_BADGE.border, icon: TBOX_BADGE.icon };
    default:
      return { bg: "bg-slate-500/10", text: "text-slate-400", border: "border-slate-500/30", icon: "📦" };
  }
}

export function EntityInspector({
  selectedNode,
  selectedEdge,
  allNodes,
  allEdges,
  onSelectNode,
  onClose,
  isIsolated,
  onToggleIsolate,
  onUpdateZoomLevel,
  onToggleTBox,
  onUpdateClosenessRing,
  onRelationshipCreated,
  onRelationshipDeleted,
}: EntityInspectorProps) {
  const [isShiftingLevel, setIsShiftingLevel] = useState(false);
  const [levelFeedback, setLevelFeedback] = useState<string | null>(null);

  // Relationship CRUD state
  const [isAddingRelation, setIsAddingRelation] = useState(false);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [relationRole, setRelationRole] = useState<"child" | "parent" | "sibling" | "custom">("child");
  const [customRelType, setCustomRelType] = useState("");
  const [confidence, setConfidence] = useState(1.0);
  const [isSubmittingRelation, setIsSubmittingRelation] = useState(false);
  const [relationFeedback, setRelationFeedback] = useState<string | null>(null);
  const [deletingEdgeId, setDeletingEdgeId] = useState<string | null>(null);

  const nodeMap = new Map<string, GraphNode>();
  for (const n of allNodes) {
    nodeMap.set(n.id, n);
  }

  // Node details view
  if (selectedNode) {
    const badge = getTypeBadgeColor(selectedNode.entity_type);

    const outgoingEdges = allEdges.filter((e) => e.from_entity_id === selectedNode.id);
    const incomingEdges = allEdges.filter((e) => e.to_entity_id === selectedNode.id);

    return (
      <div className="w-80 md:w-96 bg-slate-900/95 border-l border-slate-800 p-5 flex flex-col h-full overflow-y-auto text-slate-200 shadow-2xl backdrop-blur">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-800">
          <div className="flex items-start gap-3">
            <span className="text-2xl p-2 rounded-xl bg-slate-800/80 border border-slate-700/60 shadow-inner">
              {badge.icon}
            </span>
            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${badge.bg} ${badge.text} ${badge.border}`}>
                  {selectedNode.entity_type}
                </span>
                {isTBoxEntity(selectedNode) && (
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${TBOX_BADGE.bg} ${TBOX_BADGE.text} ${TBOX_BADGE.border} shadow-sm flex items-center gap-1`}
                    title="T-box: Terminological / Schema entity (defined in properties)"
                  >
                    <span>{TBOX_BADGE.icon}</span>
                    <span>{TBOX_BADGE.label}</span>
                  </span>
                )}
                {selectedNode.domain_override && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                    @{selectedNode.domain_override}
                  </span>
                )}
                {selectedNode.hot && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    🔥 Hot
                  </span>
                )}
                {selectedNode.archived && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30">
                    Archived
                  </span>
                )}
              </div>
              <h3 className="text-base font-bold text-white mt-1 leading-snug">{selectedNode.title}</h3>
              <p className="text-[10px] font-mono text-slate-400 select-all truncate max-w-[200px]">
                {selectedNode.id}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
            title="Close inspector"
          >
            ✕
          </button>
        </div>

        {/* Action button */}
        <div className="py-3 border-b border-slate-800 flex gap-2">
          <button
            type="button"
            onClick={onToggleIsolate}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 border ${
              isIsolated
                ? "bg-indigo-600/30 text-indigo-300 border-indigo-500/50 shadow-sm"
                : "bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border-slate-700"
            }`}
          >
            <span>{isIsolated ? "🔍 Reset Focus" : "🎯 Focus Neighborhood"}</span>
          </button>
        </div>

        {/* LOD Zoom Level Setting & Overrule */}
        <div className="py-3 px-3.5 bg-slate-950/70 rounded-xl border border-slate-800 space-y-2 mt-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs">🔭</span>
              <h4 className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                Zoom Level (LOD)
              </h4>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              {`Level ${selectedNode.zoom_level ?? 1} / 14`}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug">
            Controls at which canvas magnification this entity appears (Level 1 = Anchor/Always visible, Level 5 = Default 100%, Level 14 = Deep Detail).
          </p>

          {/* Quick Level Shift Buttons (CAR: graph_node_level) */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={async () => {
                const current = selectedNode.zoom_level ?? 1;
                if (current <= 1) return;
                setIsShiftingLevel(true);
                try {
                  const res = await defaultClientActionRegistry.execute<GraphNodeLevelInput, GraphNodeLevelOutput>(
                    "graph_node_level",
                    { id: selectedNode.id, direction: "up", delta: 1 },
                  );
                  onUpdateZoomLevel?.(selectedNode.id, res.new_level);
                  setLevelFeedback(`Promoted to Level ${res.new_level}`);
                  setTimeout(() => setLevelFeedback(null), 2500);
                } catch (e: any) {
                  setLevelFeedback(`Failed: ${e.message}`);
                  setTimeout(() => setLevelFeedback(null), 3000);
                } finally {
                  setIsShiftingLevel(false);
                }
              }}
              disabled={isShiftingLevel || (selectedNode.zoom_level ?? 1) <= 1}
              className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Promote entity up a level towards apex visibility (L1)"
            >
              <span>⬆</span>
              <span>Move Up</span>
            </button>
            <button
              type="button"
              onClick={async () => {
                const current = selectedNode.zoom_level ?? 1;
                if (current >= 14) return;
                setIsShiftingLevel(true);
                try {
                  const res = await defaultClientActionRegistry.execute<GraphNodeLevelInput, GraphNodeLevelOutput>(
                    "graph_node_level",
                    { id: selectedNode.id, direction: "down", delta: 1 },
                  );
                  onUpdateZoomLevel?.(selectedNode.id, res.new_level);
                  setLevelFeedback(`Demoted to Level ${res.new_level}`);
                  setTimeout(() => setLevelFeedback(null), 2500);
                } catch (e: any) {
                  setLevelFeedback(`Failed: ${e.message}`);
                  setTimeout(() => setLevelFeedback(null), 3000);
                } finally {
                  setIsShiftingLevel(false);
                }
              }}
              disabled={isShiftingLevel || (selectedNode.zoom_level ?? 1) >= 14}
              className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Demote entity down a level towards micro detail (L14)"
            >
              <span>⬇</span>
              <span>Move Down</span>
            </button>
          </div>
          {levelFeedback && (
            <p className="text-[10px] text-indigo-400 font-mono text-center pt-0.5 animate-pulse">
              {levelFeedback}
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <input
              type="range"
              min={1}
              max={14}
              value={selectedNode.zoom_level ?? 1}
              onChange={async (e) => {
                const val = Number(e.target.value);
                onUpdateZoomLevel?.(selectedNode.id, val);
                try {
                  await defaultClientActionRegistry.execute<GraphNodeLevelInput, GraphNodeLevelOutput>(
                    "graph_node_level",
                    { id: selectedNode.id, direction: "set", target_level: val },
                  );
                } catch {
                  // Handled
                }
              }}
              disabled={!onUpdateZoomLevel || isShiftingLevel}
              className="flex-1 accent-indigo-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
            />
            <select
              value={selectedNode.zoom_level ?? 1}
              onChange={async (e) => {
                const val = Number(e.target.value);
                onUpdateZoomLevel?.(selectedNode.id, val);
                try {
                  await defaultClientActionRegistry.execute<GraphNodeLevelInput, GraphNodeLevelOutput>(
                    "graph_node_level",
                    { id: selectedNode.id, direction: "set", target_level: val },
                  );
                } catch {
                  // Handled
                }
              }}
              disabled={!onUpdateZoomLevel || isShiftingLevel}
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
            >
              {Array.from({ length: 14 }, (_, i) => i + 1).map((lvl) => (
                <option key={lvl} value={lvl}>
                  L{lvl} {lvl === 1 ? "(Anchor)" : lvl === 5 ? "(Default)" : lvl === 14 ? "(Deep)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between pt-0.5 text-[10px] text-slate-500 font-mono">
            <span>Level 1 (0.4x)</span>
            <span>Level 14 (2.5x)</span>
          </div>
        </div>

        {/* Body content */}
        <div className="space-y-4 py-4 text-xs">
          {/* Description */}
          {selectedNode.description && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Description</h4>
              <p className="text-slate-300 leading-relaxed bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                {selectedNode.description}
              </p>
            </div>
          )}

          {/* Aliases */}
          {selectedNode.aliases && selectedNode.aliases.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Aliases</h4>
              <div className="flex flex-wrap gap-1.5">
                {selectedNode.aliases.map((alias) => (
                  <span
                    key={alias}
                    className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px] font-mono border border-slate-700/60"
                  >
                    {alias}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Tags */}
          {selectedNode.tags && selectedNode.tags.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Tags</h4>
              <div className="flex flex-wrap gap-2 items-center">
                {selectedNode.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-indigo-400 text-xs font-mono hover:text-indigo-300 transition-colors"
                  >
                    {`#${tag}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Grouped Descendants (Children & Grandchildren) */}
          {selectedNode.groupedDescendants && selectedNode.groupedDescendants.length > 0 && (
            <div className="p-3 bg-indigo-950/40 border border-indigo-800/50 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] font-semibold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
                  <span>🌳 Grouped Descendants</span>
                  <span className="px-1.5 py-0.2 rounded-full bg-indigo-800 text-indigo-200 text-[10px] font-mono font-bold">
                    {selectedNode.groupedDescendants.length}
                  </span>
                </h4>
                <span className="text-[10px] text-indigo-400/80 font-mono">Inside group</span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Children and grandchildren collapsed into this parent node based on the current hierarchy level.
              </p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {selectedNode.groupedDescendants.map((descendant) => {
                  const dBadge = getTypeBadgeColor(descendant.entity_type);
                  return (
                    <div
                      key={descendant.id}
                      onClick={() => onSelectNode(descendant)}
                      className="p-2 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-800 hover:border-indigo-600/50 transition-all cursor-pointer flex items-center justify-between gap-2 group"
                      title="Click to inspect this grouped descendant"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs">{dBadge.icon}</span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-200 group-hover:text-indigo-300 truncate">
                            {descendant.title}
                          </p>
                          <span className={`text-[9px] font-mono px-1 rounded ${dBadge.bg} ${dBadge.text}`}>
                            {descendant.entity_type}
                          </span>
                        </div>
                      </div>
                      <span className="text-[10px] text-slate-400 group-hover:text-slate-200 font-mono">
                        Inspect →
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Network Closeness Ring (7 Concentric Circles) */}
          {isPersonEntity(selectedNode) && (
            <div className="p-3 bg-slate-900/70 rounded-xl border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">👥</span>
                  <h4 className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                    Network Closeness
                  </h4>
                </div>
                {(() => {
                  const ringNum = resolveNodeClosenessRing(selectedNode);
                  const ringDef = getNetworkRingDefinition(ringNum);
                  return (
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${ringDef.badgeBg} ${ringDef.badgeBorder} ${ringDef.badgeText} font-semibold flex items-center gap-1 shadow-sm`}
                      title={ringDef.description}
                    >
                      <span>Ring {ringNum}:</span>
                      <span>{ringDef.label}</span>
                    </span>
                  );
                })()}
              </div>
              <p className="text-[10px] text-slate-400">
                Concentric circle tier in the Network view (1 = Me & Core in centre, 7 = Strangers furthest away).
              </p>

              {/* Interactive 7 Rings Picker */}
              <div className="grid grid-cols-7 gap-1 pt-1">
                {NETWORK_RINGS.map((ringDef) => {
                  const currentRing = resolveNodeClosenessRing(selectedNode);
                  const isSelected = currentRing === ringDef.ring;
                  return (
                    <button
                      key={ringDef.ring}
                      type="button"
                      onClick={() => onUpdateClosenessRing?.(selectedNode.id, ringDef.ring)}
                      className={`py-1.5 px-0.5 rounded-lg text-center font-mono text-[11px] transition-all border ${
                        isSelected
                          ? `${ringDef.badgeBg} ${ringDef.badgeText} ${ringDef.badgeBorder} ring-1 ring-indigo-400/50 font-bold shadow-sm scale-105`
                          : "bg-slate-950/80 hover:bg-slate-800 text-slate-400 border-slate-800 hover:text-slate-200"
                      }`}
                      title={`Ring ${ringDef.ring}: ${ringDef.label}: ${ringDef.description}`}
                    >
                      <div className="font-bold">{ringDef.ring}</div>
                      <div className="text-[8px] truncate opacity-85">
                        {ringDef.ring === 1 ? "Core" : ringDef.ring === 7 ? "Strgr" : ringDef.label.split(" ")[0]}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Relationships Header with Add Button */}
          <div className="pt-2 border-t border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs">🔗</span>
                <h4 className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                  Relationships ({outgoingEdges.length + incomingEdges.length})
                </h4>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsAddingRelation(!isAddingRelation);
                  setRelationFeedback(null);
                }}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors border ${
                  isAddingRelation
                    ? "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                    : "bg-indigo-600/20 text-indigo-300 border-indigo-500/40 hover:bg-indigo-600/30"
                }`}
              >
                {isAddingRelation ? "✕ Cancel" : "+ Add Relationship"}
              </button>
            </div>

            {/* Add Relationship Form (CAR: relationship_crud) */}
            {isAddingRelation && (
              <div className="p-3 bg-slate-950 rounded-xl border border-indigo-500/30 space-y-2.5 mb-3">
                <div className="flex items-center justify-between">
                  <h5 className="text-[11px] font-semibold text-indigo-300 uppercase tracking-wider">
                    Add Relationship (CAR)
                  </h5>
                  <span className="text-[9px] font-mono text-slate-500">ADR-100</span>
                </div>

                {/* Role Selector */}
                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-mono block mb-1">Role link</span>
                  <div className="grid grid-cols-4 gap-1 text-[11px]">
                    {(["child", "parent", "sibling", "custom"] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRelationRole(r)}
                        className={`py-1 px-1.5 rounded text-center capitalize font-medium transition-colors border ${
                          relationRole === r
                            ? "bg-indigo-600 text-white border-indigo-500"
                            : "bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-slate-200"
                        }`}
                      >
                        {r === "child" ? "👶 Child" : r === "parent" ? "👨‍👩‍👧 Parent" : r === "sibling" ? "🤝 Sibling" : "⚙️ Custom"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1 leading-snug">
                    {relationRole === "child" && "Adds target node as a child of this entity (contains edge)."}
                    {relationRole === "parent" && "Adds target node as a parent of this entity (parentOf edge)."}
                    {relationRole === "sibling" && "Adds target node as a peer sibling of this entity."}
                    {relationRole === "custom" && "Specify a custom relationship type."}
                  </p>
                </div>

                {/* Target Node Picker */}
                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-mono block mb-1">Target Entity</span>
                  <select
                    value={targetNodeId}
                    onChange={(e) => setTargetNodeId(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">-- Select an entity --</option>
                    {allNodes
                      .filter((n) => n.id !== selectedNode.id)
                      .sort((a, b) => a.title.localeCompare(b.title))
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.title} ({n.entity_type})
                        </option>
                      ))}
                  </select>
                </div>

                {/* Custom Type Input */}
                {relationRole === "custom" && (
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase font-mono block mb-1">
                      Relationship Type
                    </span>
                    <input
                      type="text"
                      value={customRelType}
                      onChange={(e) => setCustomRelType(e.target.value)}
                      placeholder="e.g. relates_to, depends_on, authored_by"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                )}

                {/* Confidence Score */}
                <div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1 font-mono">
                    <span>Confidence Score</span>
                    <span>{Math.round(confidence * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={confidence}
                    onChange={(e) => setConfidence(Number(e.target.value))}
                    className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                  />
                </div>

                {/* Submit Button */}
                <div className="pt-1 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingRelation(false);
                      setRelationFeedback(null);
                    }}
                    className="px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!targetNodeId || isSubmittingRelation}
                    onClick={async () => {
                      if (!targetNodeId) return;
                      setIsSubmittingRelation(true);
                      setRelationFeedback(null);
                      try {
                        const res = await defaultClientActionRegistry.execute<
                          RelationshipCrudInput,
                          RelationshipCrudOutput
                        >("relationship_crud", {
                          operation: "create",
                          from_entity_id: selectedNode.id,
                          to_entity_id: targetNodeId,
                          role: relationRole,
                          relationship_type: customRelType || undefined,
                          confidence_score: confidence,
                        });

                        if (res.relationship) {
                          onRelationshipCreated?.(res.relationship as unknown as GraphEdge);
                        }
                        setRelationFeedback(`Connected relationship successfully!`);
                        setTargetNodeId("");
                        setCustomRelType("");
                        setIsAddingRelation(false);
                        setTimeout(() => setRelationFeedback(null), 3000);
                      } catch (err: any) {
                        setRelationFeedback(`Error: ${err.message}`);
                      } finally {
                        setIsSubmittingRelation(false);
                      }
                    }}
                    className="px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmittingRelation ? "Connecting..." : "Connect"}
                  </button>
                </div>
              </div>
            )}

            {relationFeedback && (
              <p className="text-[10px] text-emerald-400 font-mono mb-2 animate-pulse">
                {relationFeedback}
              </p>
            )}
          </div>

          {/* Outgoing relationships */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Outgoing Relations ({outgoingEdges.length})
              </h4>
            </div>
            {outgoingEdges.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">No outgoing connections.</p>
            ) : (
              <div className="space-y-1.5">
                {outgoingEdges.map((edge) => {
                  const targetNode = nodeMap.get(edge.to_entity_id);
                  return (
                    <div
                      key={edge.id}
                      className="flex items-center gap-1.5 p-1.5 rounded-lg bg-slate-950/70 hover:bg-slate-800/90 border border-slate-800 hover:border-indigo-500/40 transition-colors group"
                    >
                      <button
                        type="button"
                        onClick={() => targetNode && onSelectNode(targetNode)}
                        className="flex-1 text-left truncate min-w-0"
                      >
                        <span className="text-[10px] font-mono text-indigo-400 block truncate">
                          --[{edge.relationship_type}]--&gt;
                        </span>
                        <span className="text-slate-200 font-medium group-hover:text-indigo-300 transition-colors truncate block">
                          {targetNode?.title || edge.to_entity_id}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setDeletingEdgeId(edge.id);
                          try {
                            await defaultClientActionRegistry.execute<RelationshipCrudInput, RelationshipCrudOutput>(
                              "relationship_crud",
                              {
                                operation: "delete",
                                id: edge.id,
                                from_entity_id: edge.from_entity_id,
                                to_entity_id: edge.to_entity_id,
                                relationship_type: edge.relationship_type,
                              },
                            );
                            onRelationshipDeleted?.(edge.id);
                          } catch (err) {
                            console.error("Failed to delete edge:", err);
                          } finally {
                            setDeletingEdgeId(null);
                          }
                        }}
                        disabled={deletingEdgeId === edge.id}
                        className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                        title="Delete relationship edge via CAR"
                      >
                        {deletingEdgeId === edge.id ? "…" : "🗑"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Incoming relationships */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Incoming Relations ({incomingEdges.length})
              </h4>
            </div>
            {incomingEdges.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">No incoming connections.</p>
            ) : (
              <div className="space-y-1.5">
                {incomingEdges.map((edge) => {
                  const sourceNode = nodeMap.get(edge.from_entity_id);
                  return (
                    <div
                      key={edge.id}
                      className="flex items-center gap-1.5 p-1.5 rounded-lg bg-slate-950/70 hover:bg-slate-800/90 border border-slate-800 hover:border-emerald-500/40 transition-colors group"
                    >
                      <button
                        type="button"
                        onClick={() => sourceNode && onSelectNode(sourceNode)}
                        className="flex-1 text-left truncate min-w-0"
                      >
                        <span className="text-[10px] font-mono text-emerald-400 block truncate">
                          &lt;--[{edge.relationship_type}]--
                        </span>
                        <span className="text-slate-200 font-medium group-hover:text-emerald-300 transition-colors truncate block">
                          {sourceNode?.title || edge.from_entity_id}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setDeletingEdgeId(edge.id);
                          try {
                            await defaultClientActionRegistry.execute<RelationshipCrudInput, RelationshipCrudOutput>(
                              "relationship_crud",
                              {
                                operation: "delete",
                                id: edge.id,
                                from_entity_id: edge.from_entity_id,
                                to_entity_id: edge.to_entity_id,
                                relationship_type: edge.relationship_type,
                              },
                            );
                            onRelationshipDeleted?.(edge.id);
                          } catch (err) {
                            console.error("Failed to delete edge:", err);
                          } finally {
                            setDeletingEdgeId(null);
                          }
                        }}
                        disabled={deletingEdgeId === edge.id}
                        className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                        title="Delete relationship edge via CAR"
                      >
                        {deletingEdgeId === edge.id ? "…" : "🗑"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* External Source URL */}
          {selectedNode.source_url && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Source URL</h4>
              <a
                href={selectedNode.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-400 hover:underline break-all block bg-slate-950/60 p-2 rounded border border-slate-800"
              >
                {selectedNode.source_url} ↗
              </a>
            </div>
          )}

          {/* Properties JSON & T-box classification */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Properties</h4>
                {isTBoxEntity(selectedNode) ? (
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${TBOX_BADGE.bg} ${TBOX_BADGE.text} ${TBOX_BADGE.border} flex items-center gap-1 shadow-sm`}
                    title="T-box entity: classified via properties (ADR-036 §1)"
                  >
                    <span>{TBOX_BADGE.icon}</span>
                    <span>T-box (in properties)</span>
                  </span>
                ) : onToggleTBox ? (
                  <button
                    type="button"
                    onClick={() => onToggleTBox(selectedNode.id, true)}
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-dashed border-slate-700 text-slate-400 hover:text-purple-300 hover:border-purple-600/50 hover:bg-purple-950/40 transition-colors flex items-center gap-1"
                    title="Click to classify this entity as T-box by setting in_box: 'TBox' in properties"
                  >
                    <span>+</span>
                    <span>Set T-box</span>
                  </button>
                ) : null}
              </div>
              {isTBoxEntity(selectedNode) && onToggleTBox && (
                <button
                  type="button"
                  onClick={() => onToggleTBox(selectedNode.id, false)}
                  className="text-[9px] font-mono text-slate-500 hover:text-rose-400 transition-colors underline"
                  title="Remove in_box: 'TBox' from entity properties"
                >
                  Unset
                </button>
              )}
            </div>
            {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 ? (
              <pre className="text-[10px] font-mono text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-800 overflow-x-auto max-h-40">
                {JSON.stringify(selectedNode.properties, null, 2)}
              </pre>
            ) : (
              <p className="text-[10px] font-mono text-slate-500 italic bg-slate-950/40 p-2 rounded border border-slate-800/50">
                No custom properties set
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Edge details view
  if (selectedEdge) {
    const sourceNode = nodeMap.get(selectedEdge.from_entity_id);
    const targetNode = nodeMap.get(selectedEdge.to_entity_id);

    return (
      <div className="w-80 md:w-96 bg-slate-900/95 border-l border-slate-800 p-5 flex flex-col h-full overflow-y-auto text-slate-200 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
              Relationship Edge
            </span>
            <h3 className="text-base font-bold text-white mt-1.5 leading-snug font-mono">
              {selectedEdge.relationship_type}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 py-4 text-xs">
          {/* Directed Connected Nodes */}
          <div className="space-y-2 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
            <div>
              <span className="text-[10px] text-slate-400 uppercase font-mono block">From (Source)</span>
              <button
                type="button"
                onClick={() => sourceNode && onSelectNode(sourceNode)}
                className="text-indigo-400 hover:underline font-semibold mt-0.5 block truncate text-left"
              >
                {sourceNode?.title || selectedEdge.from_entity_id} ↗
              </button>
            </div>
            <div className="text-center font-mono text-slate-500 text-[10px]">↓ ({selectedEdge.relationship_type})</div>
            <div>
              <span className="text-[10px] text-slate-400 uppercase font-mono block">To (Target)</span>
              <button
                type="button"
                onClick={() => targetNode && onSelectNode(targetNode)}
                className="text-indigo-400 hover:underline font-semibold mt-0.5 block truncate text-left"
              >
                {targetNode?.title || selectedEdge.to_entity_id} ↗
              </button>
            </div>
          </div>

          {/* Confidence Score */}
          {selectedEdge.confidence_score !== null && selectedEdge.confidence_score !== undefined && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Confidence</h4>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${Math.round(selectedEdge.confidence_score * 100)}%` }}
                  />
                </div>
                <span className="font-mono text-slate-300 text-xs">
                  {Math.round(selectedEdge.confidence_score * 100)}%
                </span>
              </div>
            </div>
          )}

          {/* Validity window */}
          {(selectedEdge.valid_from || selectedEdge.valid_to) && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Temporal Validity</h4>
              <p className="text-slate-300 font-mono text-[11px]">
                {selectedEdge.valid_from ? new Date(selectedEdge.valid_from).toLocaleDateString() : "Unbounded"}
                {" → "}
                {selectedEdge.valid_to ? new Date(selectedEdge.valid_to).toLocaleDateString() : "Active / Ongoing"}
              </p>
            </div>
          )}

          {/* Metadata */}
          {selectedEdge.metadata && Object.keys(selectedEdge.metadata).length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Metadata</h4>
              <pre className="text-[10px] font-mono text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-800 overflow-x-auto max-h-40">
                {JSON.stringify(selectedEdge.metadata, null, 2)}
              </pre>
            </div>
          )}

          {/* Delete Edge Action (CAR: relationship_crud) */}
          <div className="pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={async () => {
                try {
                  await defaultClientActionRegistry.execute<RelationshipCrudInput, RelationshipCrudOutput>(
                    "relationship_crud",
                    {
                      operation: "delete",
                      id: selectedEdge.id,
                      from_entity_id: selectedEdge.from_entity_id,
                      to_entity_id: selectedEdge.to_entity_id,
                      relationship_type: selectedEdge.relationship_type,
                    },
                  );
                  onRelationshipDeleted?.(selectedEdge.id);
                  onClose();
                } catch (err) {
                  console.error("Failed to delete edge:", err);
                }
              }}
              className="w-full py-2 px-3 rounded-lg text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 transition-colors flex items-center justify-center gap-1.5"
            >
              <span>🗑</span>
              <span>Delete Relationship Edge (CAR)</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Idle state
  return (
    <div className="w-72 bg-slate-900/60 border-l border-slate-800/80 p-5 hidden lg:flex flex-col h-full text-slate-300 justify-between">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Graph Inspector</h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          Click any entity node or relationship edge in the graph to inspect properties, neighborhood connections, and
          metadata.
        </p>

        <div className="mt-6 space-y-2 text-xs">
          <div className="p-2.5 bg-slate-950/60 rounded-lg border border-slate-800 flex justify-between">
            <span className="text-slate-400">Total Entities</span>
            <span className="font-mono font-bold text-white">{allNodes.length}</span>
          </div>
          <div className="p-2.5 bg-slate-950/60 rounded-lg border border-slate-800 flex justify-between">
            <span className="text-slate-400">Relationships</span>
            <span className="font-mono font-bold text-white">{allEdges.length}</span>
          </div>
          <div className="p-2.5 bg-slate-950/60 rounded-lg border border-slate-800 flex justify-between">
            <span className="text-slate-400">Hot Entities</span>
            <span className="font-mono font-bold text-amber-400">
              {allNodes.filter((n) => n.hot).length}
            </span>
          </div>
        </div>
      </div>

      <div className="text-[11px] font-mono text-slate-400 text-center">
        Drag nodes · Scroll to zoom
      </div>
    </div>
  );
}
