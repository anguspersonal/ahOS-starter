import React, { useEffect, useRef } from "react";
import type { GraphPhysicsConfig } from "./types.js";

export const DEFAULT_PHYSICS_CONFIG: GraphPhysicsConfig = {
  repulsion: 18000,
  springLength: 160,
  springStrength: 0.035,
  gravity: 0.004,
  collisionBuffer: 36,
  damping: 0.85,
  coolingRate: 0.990,
};

export const PHYSICS_PRESETS: Record<
  string,
  { label: string; icon: string; description: string; config: GraphPhysicsConfig }
> = {
  balanced: {
    label: "Balanced",
    icon: "⚖️",
    description: "Standard equilibrium between cluster cohesion and node separation",
    config: {
      repulsion: 18000,
      springLength: 160,
      springStrength: 0.035,
      gravity: 0.004,
      collisionBuffer: 36,
      damping: 0.85,
      coolingRate: 0.990,
    },
  },
  sprawling: {
    label: "Sprawling",
    icon: "🌌",
    description: "High repulsion with long edges: spacious, open galactic overview",
    config: {
      repulsion: 32000,
      springLength: 250,
      springStrength: 0.020,
      gravity: 0.002,
      collisionBuffer: 50,
      damping: 0.88,
      coolingRate: 0.992,
    },
  },
  compact: {
    label: "Compact",
    icon: "📦",
    description: "Short links and tight pull: dense groupings fitting in small screens",
    config: {
      repulsion: 8000,
      springLength: 90,
      springStrength: 0.065,
      gravity: 0.008,
      collisionBuffer: 22,
      damping: 0.82,
      coolingRate: 0.985,
    },
  },
  fluid: {
    label: "Fluid Drift",
    icon: "🌊",
    description: "Low friction and minimal gravity: gentle, floaty floating physics",
    config: {
      repulsion: 16000,
      springLength: 180,
      springStrength: 0.030,
      gravity: 0.001,
      collisionBuffer: 36,
      damping: 0.93,
      coolingRate: 0.996,
    },
  },
};

export interface PhysicsControlsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  config: GraphPhysicsConfig;
  onChange: (updates: Partial<GraphPhysicsConfig>) => void;
  onReset: () => void;
  onReheat: () => void;
  isPaused: boolean;
  onTogglePause: () => void;
}

export function PhysicsControlsPopover({
  isOpen,
  onClose,
  config,
  onChange,
  onReset,
  onReheat,
  isPaused,
  onTogglePause,
}: PhysicsControlsPopoverProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-2 z-50 w-88 bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-xl p-4 shadow-2xl text-xs text-slate-200 flex flex-col gap-3.5 select-none animate-in fade-in zoom-in-95 duration-150"
      style={{ width: "22rem" }}
      role="dialog"
      aria-label="Graph Physics and Force Controls"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-base">⚡</span>
          <div>
            <h4 className="font-semibold text-white leading-tight">Physics & Forces</h4>
            <p className="text-[10px] text-slate-400">Simulation forces and dynamic motion</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onTogglePause}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors border ${
              isPaused
                ? "bg-amber-950/60 text-amber-300 border-amber-800/60 hover:bg-amber-900/60"
                : "bg-emerald-950/60 text-emerald-300 border-emerald-800/60 hover:bg-emerald-900/60"
            }`}
            title={isPaused ? "Resume physics simulation" : "Pause physics simulation"}
          >
            {isPaused ? "⏸ Paused" : "▶ Running"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-slate-800 transition-colors"
            title="Close physics settings"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Presets */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-1.5">
          Quick Layout Presets
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(PHYSICS_PRESETS).map(([key, preset]) => {
            const isMatch =
              config.repulsion === preset.config.repulsion &&
              config.springLength === preset.config.springLength;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onChange(preset.config)}
                title={preset.description}
                className={`px-2 py-1.5 rounded-lg border text-left transition-all flex items-center gap-1.5 ${
                  isMatch
                    ? "bg-indigo-950/60 border-indigo-500/80 text-white font-medium shadow-sm"
                    : "bg-slate-800/70 hover:bg-slate-800 border-slate-700/60 text-slate-300"
                }`}
              >
                <span>{preset.icon}</span>
                <span className="text-[11px] truncate">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Sliders container */}
      <div className="flex flex-col gap-3 max-h-64 overflow-y-auto pr-1 scrollbar-thin">
        {/* 1. Repulsion (Push) */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>🧲</span> Node Repulsion
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.repulsion.toLocaleString()}
            </span>
          </div>
          <input
            type="range"
            min={3000}
            max={40000}
            step={1000}
            value={config.repulsion}
            onChange={(e) => onChange({ repulsion: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Dense</span>
            <span>Spacious</span>
          </div>
        </div>

        {/* 2. Link Distance */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>📏</span> Link Distance
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.springLength}px
            </span>
          </div>
          <input
            type="range"
            min={50}
            max={350}
            step={10}
            value={config.springLength}
            onChange={(e) => onChange({ springLength: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Short (50px)</span>
            <span>Long (350px)</span>
          </div>
        </div>

        {/* 3. Link Strength */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>🔗</span> Link Strength
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.springStrength.toFixed(3)}
            </span>
          </div>
          <input
            type="range"
            min={0.005}
            max={0.100}
            step={0.005}
            value={config.springStrength}
            onChange={(e) => onChange({ springStrength: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Loose</span>
            <span>Rigid</span>
          </div>
        </div>

        {/* 4. Center Gravity */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>🎯</span> Center Gravity
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.gravity.toFixed(4)}
            </span>
          </div>
          <input
            type="range"
            min={0.001}
            max={0.020}
            step={0.001}
            value={config.gravity}
            onChange={(e) => onChange({ gravity: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Drift</span>
            <span>Strong Pull</span>
          </div>
        </div>

        {/* 5. Collision Buffer */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>🛡️</span> Collision Buffer
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.collisionBuffer}px
            </span>
          </div>
          <input
            type="range"
            min={10}
            max={80}
            step={2}
            value={config.collisionBuffer}
            onChange={(e) => onChange({ collisionBuffer: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Tight</span>
            <span>Wide Margin</span>
          </div>
        </div>

        {/* 6. Friction / Damping */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>💨</span> Friction / Damping
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.damping.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.60}
            max={0.96}
            step={0.02}
            value={config.damping}
            onChange={(e) => onChange({ damping: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Calm / Sluggish</span>
            <span>Bouncy / Fluid</span>
          </div>
        </div>

        {/* 7. Cooling Rate (Speed) */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-slate-300 font-medium flex items-center gap-1">
              <span>⏱️</span> Cooling Rate (Speed)
            </span>
            <span className="font-mono text-[11px] text-indigo-300 bg-indigo-950/60 px-1.5 py-0.2 rounded border border-indigo-800/50">
              {config.coolingRate.toFixed(3)}
            </span>
          </div>
          <input
            type="range"
            min={0.970}
            max={0.998}
            step={0.002}
            value={config.coolingRate}
            onChange={(e) => onChange({ coolingRate: Number(e.target.value) })}
            className="w-full accent-indigo-500 bg-slate-800 h-1.5 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>Quick Settle</span>
            <span>Continuous Motion</span>
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-700/60">
        <button
          type="button"
          onClick={onReheat}
          className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors flex items-center gap-1"
          title="Restart animation with maximum energy to shake out trapped nodes"
        >
          <span>🔥</span>
          <span>Re-heat / Shake</span>
        </button>
        <button
          type="button"
          onClick={onReset}
          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
          title="Reset to default physics values"
        >
          <span>↺</span>
          <span>Reset Defaults</span>
        </button>
      </div>
    </div>
  );
}
