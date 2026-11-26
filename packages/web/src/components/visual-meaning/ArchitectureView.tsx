import type { ArchitectureNodeData, NodeLiveTelemetry, ViewDefinition } from "./types.js";
import { ArchitectureGroup } from "./ArchitectureGroup.js";
import { ArchitectureLine } from "./ArchitectureLine.js";
import { ArchitectureNode } from "./ArchitectureNode.js";

interface ArchitectureViewProps {
  view: ViewDefinition;
  selectedNodeId?: string;
  onSelectNode?: (node: ArchitectureNodeData | null) => void;
  isObservationMode?: boolean;
  telemetryMap?: Record<string, NodeLiveTelemetry>;
}

export function ArchitectureView({
  view,
  selectedNodeId,
  onSelectNode,
  isObservationMode = false,
  telemetryMap,
}: ArchitectureViewProps) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-slate-700 bg-white shadow-xl">
      <svg
        viewBox={view.viewBox}
        className="w-full h-auto min-w-[900px] select-none"
        xmlns="http://www.w3.org/2000/svg"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      >
        <defs>
          {/* Arrow Markers */}
          <marker
            id="arch-arrow"
            viewBox="0 0 10 10"
            refX={6}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#545b64" />
          </marker>
          <marker
            id="arch-arrow-blue"
            viewBox="0 0 10 10"
            refX={6}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>
          <marker
            id="arch-arrow-indigo"
            viewBox="0 0 10 10"
            refX={6}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#4f46e5" />
          </marker>
          <marker
            id="arch-arrow-cyan"
            viewBox="0 0 10 10"
            refX={6}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#0284c7" />
          </marker>

          {/* Clean Drop Shadow */}
          <filter id="arch-shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.08" />
          </filter>
        </defs>

        {/* Clean Canvas Background */}
        <rect width="100%" height="100%" fill="#ffffff" rx={8} />

        {/* 1. Groups & Boundaries (rendered first / underneath) */}
        {view.groups.map((group) => (
          <ArchitectureGroup key={group.id} group={group} />
        ))}

        {/* 2. Directional Lines & Connector Paths */}
        {view.lines.map((line) => (
          <ArchitectureLine key={line.id} line={line} />
        ))}

        {/* 3. Architecture Nodes (rendered on top) */}
        {view.nodes.map((node) => (
          <ArchitectureNode
            key={node.id}
            node={node}
            isSelected={selectedNodeId === node.id}
            onClick={(n) => onSelectNode?.(n.id === selectedNodeId ? null : n)}
            isObservationMode={isObservationMode}
            liveTelemetry={telemetryMap?.[node.id]}
          />
        ))}
      </svg>
    </div>
  );
}
