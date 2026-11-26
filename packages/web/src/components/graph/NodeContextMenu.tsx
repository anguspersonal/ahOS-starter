import React, { useState, useEffect, useRef } from "react";
import type { GraphNode } from "./types.js";
import { isTBoxEntity } from "./tbox.js";
import { isPersonEntity, resolveNodeClosenessRing, NETWORK_RINGS } from "./networkView.js";
import { getTypeBadgeColor } from "./EntityInspector.js";

export interface NodeContextMenuProps {
  node: GraphNode;
  position: { x: number; y: number };
  onClose: () => void;
  isNight: boolean;
  isPinned: boolean;
  isIsolated: boolean;
  onInspect: (node: GraphNode) => void;
  onCenter: (node: GraphNode) => void;
  onTogglePin: (node: GraphNode) => void;
  onToggleIsolate: (node: GraphNode) => void;
  onToggleHot: (node: GraphNode) => void;
  onToggleTBox: (nodeId: string, isTBox: boolean) => void;
  onUpdateZoomLevel: (nodeId: string, level: number) => void;
  onUpdateClosenessRing?: (nodeId: string, ring: number) => void;
  onOpenMiniChat: (node: GraphNode) => void;
  onArchiveEntity?: (node: GraphNode) => void;
}

const HIERARCHY_TIERS = [
  { level: 1, label: "L1 Landmark", desc: "Always visible, invariant scaling" },
  { level: 2, label: "L2 Pillar", desc: "Core high-level architecture" },
  { level: 3, label: "L3 Standard", desc: "Standard entities" },
  { level: 4, label: "L4 Leaf", desc: "Deep zoom details" },
];

export function NodeContextMenu({
  node,
  position,
  onClose,
  isNight,
  isPinned,
  isIsolated,
  onInspect,
  onCenter,
  onTogglePin,
  onToggleIsolate,
  onToggleHot,
  onToggleTBox,
  onUpdateZoomLevel,
  onUpdateClosenessRing,
  onOpenMiniChat,
  onArchiveEntity,
}: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showTierSubmenu, setShowTierSubmenu] = useState(false);
  const [showRingSubmenu, setShowRingSubmenu] = useState(false);

  const isTBox = isTBoxEntity(node);
  const isPerson = isPersonEntity(node);
  const currentRing = isPerson ? resolveNodeClosenessRing(node) : 5;
  const currentLevel = node.zoom_level ?? 3;
  const badge = getTypeBadgeColor(node.entity_type);

  // Close on click outside or Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleMouseDownOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handleMouseDownOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleMouseDownOutside);
    };
  }, [onClose]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
      onClose();
    }, 900);
  };

  const handleCopyId = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(node.id);
      showToast("Entity ID copied!");
    } catch {
      showToast(node.id);
    }
  };

  const handleCopyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const linkText = `[${node.title}](entity://${node.id})`;
    try {
      await navigator.clipboard.writeText(linkText);
      showToast("Markdown link copied!");
    } catch {
      showToast(node.title);
    }
  };

  return (
    <div
      ref={menuRef}
      style={{ left: position.x, top: position.y }}
      className={`absolute z-50 w-64 rounded-xl border shadow-2xl backdrop-blur-md text-xs select-none animate-in fade-in zoom-in-95 duration-100 ${
        isNight
          ? "bg-slate-900/95 border-slate-700/80 text-slate-200"
          : "bg-white/95 border-slate-200/90 text-slate-800 shadow-slate-400/20"
      }`}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Toast Overlay */}
      {toastMessage && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm rounded-xl">
          <span className="px-3 py-1.5 bg-emerald-600 text-white font-medium text-xs rounded-lg shadow-lg animate-pulse">
            ✓ {toastMessage}
          </span>
        </div>
      )}

      {/* Header: Node Title and Status Chips */}
      <div className={`p-2.5 border-b ${isNight ? "border-slate-800 bg-slate-800/40" : "border-slate-100 bg-slate-50/70"}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-sm">{badge.icon}</span>
          <span className="font-semibold truncate flex-1 text-slate-100 dark:text-white" title={node.title}>
            {node.title}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge.bg} ${badge.text} ${badge.border}`}>
            {node.entity_type}
          </span>
          {node.hot && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
              ⭐ Hot
            </span>
          )}
          {isTBox && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-400 border border-purple-500/30">
              🏷️ T-Box
            </span>
          )}
          {isPinned && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
              📌 Pinned
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-400 bg-slate-800/50">
            L{currentLevel}
          </span>
        </div>
      </div>

      {/* Menu Actions */}
      <div className="p-1 space-y-0.5">
        {/* 1. Inspect Details */}
        <button
          type="button"
          onClick={() => {
            onInspect(node);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">🔍</span>
          <div className="flex-1">
            <div className="font-medium">Inspect Details</div>
            <div className="text-[10px] text-slate-400">Open side properties drawer</div>
          </div>
        </button>

        {/* 2. Center View on Node */}
        <button
          type="button"
          onClick={() => {
            onCenter(node);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">🎯</span>
          <div className="flex-1">
            <div className="font-medium">Center Camera</div>
            <div className="text-[10px] text-slate-400">Pan viewport directly to node</div>
          </div>
        </button>

        {/* 3. Focus / Isolate Neighborhood */}
        <button
          type="button"
          onClick={() => {
            onToggleIsolate(node);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">👁️</span>
          <div className="flex-1">
            <div className="font-medium">
              {isIsolated ? "Clear Neighborhood Isolation" : "Isolate Neighborhood"}
            </div>
            <div className="text-[10px] text-slate-400">
              {isIsolated ? "Restore full graph visibility" : "Highlight 1-hop connected neighbors"}
            </div>
          </div>
        </button>

        <div className={`my-1 border-t ${isNight ? "border-slate-800" : "border-slate-100"}`} />

        {/* 4. Pin / Unpin Node */}
        <button
          type="button"
          onClick={() => {
            onTogglePin(node);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">📌</span>
          <div className="flex-1">
            <div className="font-medium">
              {isPinned ? "Unpin Node" : "Pin in Place"}
            </div>
            <div className="text-[10px] text-slate-400">
              {isPinned ? "Allow node to move freely with physics" : "Lock coordinates on the canvas"}
            </div>
          </div>
        </button>

        {/* 5. Toggle Hot Priority */}
        <button
          type="button"
          onClick={() => {
            onToggleHot(node);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">{node.hot ? "⭐" : "☆"}</span>
          <div className="flex-1">
            <div className="font-medium">
              {node.hot ? "Remove Hot Priority" : "Mark as Hot Priority"}
            </div>
            <div className="text-[10px] text-slate-400">Always-loaded active session tier</div>
          </div>
        </button>

        {/* 6. Toggle T-Box Ontology Concept */}
        <button
          type="button"
          onClick={() => {
            onToggleTBox(node.id, !isTBox);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">🏷️</span>
          <div className="flex-1">
            <div className="font-medium">
              {isTBox ? "Unset T-Box Concept" : "Set as T-Box Concept"}
            </div>
            <div className="text-[10px] text-slate-400">Ontological schema term classification</div>
          </div>
        </button>

        {/* 7. Hierarchy Tier Submenu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowTierSubmenu(!showTierSubmenu)}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-colors ${
              isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">🪜</span>
              <div>
                <div className="font-medium">Hierarchy Tier</div>
                <div className="text-[10px] text-slate-400">Current: L{currentLevel}</div>
              </div>
            </div>
            <span className="text-xs text-slate-400">{showTierSubmenu ? "▼" : "▶"}</span>
          </button>

          {showTierSubmenu && (
            <div className={`mt-1 pl-6 pr-2 py-1 space-y-1 rounded-lg ${isNight ? "bg-slate-800/60" : "bg-slate-100/70"}`}>
              {HIERARCHY_TIERS.map((tier) => (
                <button
                  key={tier.level}
                  type="button"
                  onClick={() => {
                    onUpdateZoomLevel(node.id, tier.level);
                    onClose();
                  }}
                  className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center justify-between transition-colors ${
                    currentLevel === tier.level
                      ? "bg-indigo-600 text-white font-medium"
                      : isNight
                      ? "hover:bg-slate-700 text-slate-300"
                      : "hover:bg-slate-200 text-slate-700"
                  }`}
                >
                  <span>{tier.label}</span>
                  <span className="text-[9px] opacity-75">{tier.desc.slice(0, 15)}...</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 8. Closeness Ring Submenu (Person Only) */}
        {isPerson && onUpdateClosenessRing && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowRingSubmenu(!showRingSubmenu)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-colors ${
                isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">🌐</span>
                <div>
                  <div className="font-medium">Closeness Ring</div>
                  <div className="text-[10px] text-slate-400">Ring {currentRing} of 7</div>
                </div>
              </div>
              <span className="text-xs text-slate-400">{showRingSubmenu ? "▼" : "▶"}</span>
            </button>

            {showRingSubmenu && (
              <div className={`mt-1 pl-6 pr-2 py-1 space-y-1 rounded-lg ${isNight ? "bg-slate-800/60" : "bg-slate-100/70"}`}>
                {NETWORK_RINGS.map((ring) => (
                  <button
                    key={ring.ring}
                    type="button"
                    onClick={() => {
                      onUpdateClosenessRing(node.id, ring.ring);
                      onClose();
                    }}
                    className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center justify-between transition-colors ${
                      currentRing === ring.ring
                        ? "bg-indigo-600 text-white font-medium"
                        : isNight
                        ? "hover:bg-slate-700 text-slate-300"
                        : "hover:bg-slate-200 text-slate-700"
                    }`}
                  >
                    <span>Ring {ring.ring}: {ring.label}</span>
                    <span className="text-[9px] opacity-75">{ring.baseRadius}px</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className={`my-1 border-t ${isNight ? "border-slate-800" : "border-slate-100"}`} />

        {/* 9. Ask AI Assistant */}
        <button
          type="button"
          onClick={() => {
            onOpenMiniChat(node);
            onClose();
          }}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">💬</span>
          <div className="flex-1">
            <div className="font-medium">Discuss with AI</div>
            <div className="text-[10px] text-slate-400">Open Mini-Chat focused on this entity</div>
          </div>
        </button>

        {/* 10. Copy ID */}
        <button
          type="button"
          onClick={handleCopyId}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">📋</span>
          <div className="flex-1">
            <div className="font-medium">Copy Entity ID</div>
            <div className="text-[10px] text-slate-400 font-mono truncate">{node.id}</div>
          </div>
        </button>

        {/* 11. Copy Markdown Link */}
        <button
          type="button"
          onClick={handleCopyLink}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
            isNight ? "hover:bg-slate-800 text-slate-200" : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <span className="text-sm">🔗</span>
          <div className="flex-1">
            <div className="font-medium">Copy Markdown Link</div>
            <div className="text-[10px] text-slate-400">[{node.title}](entity://...)</div>
          </div>
        </button>

        {/* 12. Archive Entity */}
        {onArchiveEntity && (
          <button
            type="button"
            onClick={() => {
              onArchiveEntity(node);
              onClose();
            }}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors text-rose-400 ${
              isNight ? "hover:bg-rose-950/30" : "hover:bg-rose-50"
            }`}
          >
            <span className="text-sm">📦</span>
            <div className="flex-1">
              <div className="font-medium">Archive Entity</div>
              <div className="text-[10px] text-rose-400/80">Move to archived graph state</div>
            </div>
          </button>
        )}
      </div>
    </div>
  );
}
