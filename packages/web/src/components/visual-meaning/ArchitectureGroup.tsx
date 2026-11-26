import type { ArchitectureGroupData } from "./types.js";

interface ArchitectureGroupProps {
  group: ArchitectureGroupData;
}

export function ArchitectureGroup({ group }: ArchitectureGroupProps) {
  const {
    title,
    icon,
    x,
    y,
    width,
    height,
    color = "#2563eb",
    bg = "#ffffff",
    dashed = false,
    badge,
  } = group;

  return (
    <g
      transform={`translate(${x}, ${y})`}
      className="architecture-group select-none"
      data-testid={`group-${group.id}`}
    >
      {/* Outer Boundary Box */}
      <rect
        width={width}
        height={height}
        fill={bg}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={dashed ? "4 4" : undefined}
        rx={6}
      />

      {/* Group Header Icon & Title */}
      <g transform="translate(15, 18)">
        {icon && (
          <g>
            <rect width={18} height={18} fill={color} rx={3} />
            <text
              x={9}
              y={13}
              fill="#ffffff"
              fontSize={11}
              fontWeight="bold"
              textAnchor="middle"
            >
              {typeof icon === "string" ? icon : "•"}
            </text>
          </g>
        )}
        <text
          x={icon ? 26 : 0}
          y={14}
          fontSize={12.5}
          fontWeight="700"
          fill={color}
          letterSpacing="0.2px"
        >
          {title}
        </text>
      </g>

      {/* Optional Status Badge in Header */}
      {badge && (
        <g transform={`translate(${width - 100}, 12)`}>
          <rect
            width={85}
            height={18}
            fill="#f1f5f9"
            stroke="#cbd5e1"
            rx={4}
          />
          <text
            x={42.5}
            y={12.5}
            fontSize={9.5}
            fontWeight="bold"
            fill="#475569"
            textAnchor="middle"
          >
            {badge}
          </text>
        </g>
      )}
    </g>
  );
}
