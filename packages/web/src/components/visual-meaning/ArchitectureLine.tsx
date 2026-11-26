import type { ArchitectureLineData } from "./types.js";

interface ArchitectureLineProps {
  line: ArchitectureLineData;
}

export function ArchitectureLine({ line }: ArchitectureLineProps) {
  const {
    path,
    color = "#545b64",
    width = 2,
    dashed = false,
    markerEnd = "url(#arch-arrow)",
    stepBadge,
    labelBadge,
  } = line;

  return (
    <g className="architecture-line select-none" data-testid={`line-${line.id}`}>
      {/* Connector Path */}
      <path
        d={path}
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dashed ? "3 3" : undefined}
        fill="none"
        markerEnd={markerEnd}
      />

      {/* Optional Line Label Pill */}
      {labelBadge && (
        <g transform={`translate(${labelBadge.x}, ${labelBadge.y})`}>
          <rect
            x={-60}
            y={-12}
            width={120}
            height={24}
            fill="#ffffff"
            stroke="#cbd5e1"
            strokeWidth={1}
            rx={12}
            filter="url(#arch-shadow)"
          />
          <text
            x={0}
            y={4}
            fontSize={9.5}
            fontWeight="bold"
            fill="#334155"
            textAnchor="middle"
          >
            {labelBadge.icon ? `${labelBadge.icon} ${labelBadge.text}` : labelBadge.text}
          </text>
        </g>
      )}

      {/* Optional Step Badge */}
      {stepBadge && (
        <g transform={`translate(${stepBadge.x}, ${stepBadge.y})`}>
          <rect
            width={24}
            height={24}
            fill={stepBadge.color || "#0073bb"}
            rx={4}
            filter="url(#arch-shadow)"
          />
          <text
            x={12}
            y={17}
            fill="#ffffff"
            fontSize={14}
            fontWeight="bold"
            textAnchor="middle"
          >
            {stepBadge.number}
          </text>
        </g>
      )}
    </g>
  );
}
