import type { ArchitectureNodeData, NodeLiveTelemetry } from "./types.js";

interface ArchitectureNodeProps {
  node: ArchitectureNodeData;
  isSelected?: boolean;
  onClick?: (node: ArchitectureNodeData) => void;
  isObservationMode?: boolean;
  liveTelemetry?: NodeLiveTelemetry;
}

export function ArchitectureNode({
  node,
  isSelected,
  onClick,
  isObservationMode = false,
  liveTelemetry,
}: ArchitectureNodeProps) {
  const telemetry = liveTelemetry ?? node.liveTelemetry;
  const {
    title,
    subtitle,
    description,
    icon,
    iconBg = "#2563eb",
    x,
    y,
    width,
    height,
    variant = "default",
    stepBadge,
    badge,
  } = node;

  // Variant styling
  let stroke = "#cbd5e1";
  let strokeWidth = 1.5;
  let strokeDasharray: string | undefined = undefined;
  let fill = "#ffffff";
  let titleColor = "#0f172a";
  let subtitleColor = "#64748b";

  if (variant === "primary") {
    stroke = "#2563eb";
    strokeWidth = 2;
    fill = "#ffffff";
    titleColor = "#0f172a";
    subtitleColor = "#2563eb";
  } else if (variant === "success") {
    stroke = "#16a34a";
    strokeWidth = 1.5;
    fill = "#f0fdf4";
    titleColor = "#14532d";
    subtitleColor = "#16a34a";
  } else if (variant === "warning") {
    stroke = "#f59e0b";
    strokeWidth = 1.5;
    fill = "#fffbeb";
    titleColor = "#78350f";
    subtitleColor = "#b45309";
  } else if (variant === "danger" || variant === "dashed") {
    stroke = "#ef4444";
    strokeWidth = 1.5;
    strokeDasharray = "4 4";
    fill = "#fef2f2";
    titleColor = "#991b1b";
    subtitleColor = "#b91c1c";
  } else if (variant === "purple") {
    stroke = "#7c3aed";
    strokeWidth = 1.5;
    fill = "#faf5ff";
    titleColor = "#4c1d95";
    subtitleColor = "#7c3aed";
  }

  if (isSelected) {
    stroke = "#3b82f6";
    strokeWidth = 2.5;
  }

  // Handle description lines
  const descLines: string[] = Array.isArray(description)
    ? description
    : description
    ? description.split("\n")
    : [];

  return (
    <g
      transform={`translate(${x}, ${y})`}
      className="cursor-pointer transition-transform duration-150 hover:opacity-95"
      onClick={() => onClick?.(node)}
      role="button"
      tabIndex={0}
      data-testid={`node-${node.id}`}
    >
      {/* Background card */}
      <rect
        width={width}
        height={height}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        rx={6}
        filter="url(#arch-shadow)"
      />

      {/* Selected Indicator Outline */}
      {isSelected && (
        <rect
          x={-2}
          y={-2}
          width={width + 4}
          height={height + 4}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={2}
          strokeDasharray="4 2"
          rx={8}
        />
      )}

      {/* Icon block */}
      <rect
        x={14}
        y={14}
        width={36}
        height={36}
        fill={iconBg}
        rx={6}
      />
      <text
        x={32}
        y={38}
        fontSize={16}
        fill="#ffffff"
        fontWeight="bold"
        textAnchor="middle"
        style={{ pointerEvents: "none" }}
      >
        {typeof icon === "string" ? icon : "⚡"}
      </text>

      {/* Title */}
      <text
        x={60}
        y={30}
        fontSize={13}
        fontWeight="700"
        fill={titleColor}
        style={{
          textDecoration: variant === "danger" ? "line-through" : "none",
          pointerEvents: "none",
        }}
      >
        {title}
      </text>

      {/* Subtitle */}
      {subtitle && (
        <text
          x={60}
          y={44}
          fontSize={10.5}
          fontWeight="600"
          fill={subtitleColor}
          style={{ pointerEvents: "none" }}
        >
          {subtitle}
        </text>
      )}

      {/* Description lines */}
      {descLines.map((line, idx) => {
        const isBoldHeader = line.endsWith(":") || line.startsWith("✓") || line.startsWith("✗");
        const isWarning = line.includes("Never") || line.startsWith("✗");
        const isSuccess = line.startsWith("✓");

        let textColor = "#475569";
        if (isBoldHeader) textColor = "#0f172a";
        if (isWarning) textColor = "#dc2626";
        if (isSuccess) textColor = "#059669";

        return (
          <text
            key={idx}
            x={14}
            y={68 + idx * 14}
            fontSize={10}
            fontWeight={isBoldHeader ? "700" : "400"}
            fill={textColor}
            style={{ pointerEvents: "none" }}
          >
            {line}
          </text>
        );
      })}

      {/* Live Observation Telemetry Badge */}
      {isObservationMode && telemetry && (
        <g
          transform={`translate(${badge ? width - 155 : width - 78}, 10)`}
          data-testid={`node-telemetry-${node.id}`}
        >
          <rect
            width={badge ? 70 : 68}
            height={18}
            fill="#f8fafc"
            stroke={
              telemetry.status === "healthy"
                ? "#bbf7d0"
                : telemetry.status === "warning"
                ? "#fef08a"
                : telemetry.status === "offline"
                ? "#fecaca"
                : "#e2e8f0"
            }
            rx={3}
          />
          <circle
            cx={9}
            cy={9}
            r={3.5}
            fill={
              telemetry.status === "healthy"
                ? "#16a34a"
                : telemetry.status === "warning"
                ? "#d97706"
                : telemetry.status === "offline"
                ? "#ef4444"
                : "#64748b"
            }
          />
          <text
            x={18}
            y={12.5}
            fontSize={8.5}
            fontWeight="bold"
            fill="#334155"
            style={{ fontFamily: "monospace", pointerEvents: "none" }}
          >
            {telemetry.latencyMs !== undefined ? `${telemetry.latencyMs}ms` : telemetry.statusText.slice(0, 8)}
          </text>
        </g>
      )}

      {/* Optional Badge */}
      {badge && (
        <g transform={`translate(${width - 80}, 10)`}>
          <rect
            width={70}
            height={18}
            fill={badge.bg || "#e2e8f0"}
            rx={3}
          />
          <text
            x={35}
            y={13}
            fontSize={9.5}
            fontWeight="bold"
            fill={badge.color || "#334155"}
            textAnchor="middle"
          >
            {badge.text}
          </text>
        </g>
      )}

      {/* Optional Step Badge on Node */}
      {(stepBadge !== undefined || node.step !== undefined) && (
        <g transform="translate(-10, -10)">
          <rect width={22} height={22} fill="#0073bb" rx={4} />
          <text
            x={11}
            y={16}
            fill="#ffffff"
            fontSize={13}
            fontWeight="bold"
            textAnchor="middle"
          >
            {stepBadge ?? node.step}
          </text>
        </g>
      )}
    </g>
  );
}
