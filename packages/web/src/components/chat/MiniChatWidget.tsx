import { useState } from "react";
import { ChatView } from "./ChatView.js";

export interface MiniChatWidgetProps {
  isOpen: boolean;
  onToggle: () => void;
  selectedEntity?: { id: string; title: string; entity_type?: string } | null;
  onRefreshGraph?: () => void;
  onFilterGraph?: (filter: {
    query?: string;
    entityType?: string;
    entityTypes?: string[];
    hierarchyLevel?: number | null;
    reset?: boolean;
  }) => void;
  onSelectNode?: (nodeId: string) => void;
  className?: string;
}

export function MiniChatWidget({
  isOpen,
  onToggle,
  selectedEntity,
  onRefreshGraph,
  onFilterGraph,
  onSelectNode,
  className = "",
}: MiniChatWidgetProps) {
  const [isMinimized, setIsMinimized] = useState(false);

  // If closed, render launcher floating pill button
  if (!isOpen) {
    return (
      <div className={`absolute bottom-4 right-4 z-30 ${className}`}>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full shadow-2xl shadow-indigo-600/40 border border-indigo-400/30 transition-all hover:scale-105 group font-medium text-xs backdrop-blur"
          title="Open AI Copilot for Knowledge Graph"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>✨ Graph Copilot</span>
          <span className="text-[10px] bg-indigo-800/80 px-1.5 py-0.2 rounded-full text-indigo-200 font-mono">
            CAR
          </span>
        </button>
      </div>
    );
  }

  // Minimized state: sleek title bar floating in bottom-right
  if (isMinimized) {
    return (
      <div data-no-canvas-zoom="true" className={`absolute bottom-4 right-4 z-30 w-80 shadow-2xl ${className}`}>
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-2.5 flex items-center justify-between text-xs backdrop-blur shadow-2xl">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setIsMinimized(false)}>
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-semibold text-slate-200">✨ Graph Copilot</span>
            {selectedEntity && (
              <span className="text-[10px] text-emerald-400 font-mono truncate max-w-[100px]">
                {selectedEntity.title}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setIsMinimized(false)}
              className="text-slate-400 hover:text-slate-200 text-xs px-1.5 py-0.5 rounded hover:bg-slate-800"
              title="Expand"
            >
              ◻
            </button>
            <button
              type="button"
              onClick={onToggle}
              className="text-slate-400 hover:text-slate-200 text-xs px-1.5 py-0.5 rounded hover:bg-slate-800"
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Full Open floating panel
  return (
    <div
      data-no-canvas-zoom="true"
      className={`absolute bottom-4 right-4 z-30 w-[390px] h-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-120px)] flex flex-col rounded-2xl shadow-2xl border border-slate-700/80 bg-slate-950/95 backdrop-blur overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200 ${className}`}
    >
      <ChatView
        variant="mini"
        title="Graph Copilot"
        selectedEntity={selectedEntity}
        onRefreshGraph={onRefreshGraph}
        onFilterGraph={onFilterGraph}
        onClose={onToggle}
        onActionExecuted={(actionName, args, result) => {
          // If a query found a specific entity, optionally select it
          if (actionName === "entity_crud") {
            const op = String(args.operation || "");
            const res = result as Record<string, unknown> | undefined;
            if (op === "get" && typeof res?.entity === "object" && res.entity && "id" in res.entity) {
              onSelectNode?.(String((res.entity as { id: string }).id));
            }
          }
        }}
      />
    </div>
  );
}
