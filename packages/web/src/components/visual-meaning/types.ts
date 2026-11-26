import type { ReactNode } from "react";

export type NodeVariant = "default" | "primary" | "success" | "warning" | "danger" | "dashed" | "purple";

export interface NodeBadge {
  text: string;
  color?: string;
  bg?: string;
}

export interface NodeLiveTelemetry {
  status: "healthy" | "warning" | "offline" | "standby";
  statusText: string;
  latencyMs?: number;
  metricLabel?: string;
  metricValue?: string;
  lastChecked?: string;
  endpointUrl?: string;
  diagnostics?: string[];
}

export interface ArchitectureNodeData {
  id: string;
  title: string;
  subtitle?: string;
  description?: string | string[];
  icon: string | ReactNode;
  iconBg?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  variant?: NodeVariant;
  stepBadge?: number;
  step?: number;
  badge?: NodeBadge;
  liveTelemetry?: NodeLiveTelemetry;
  details?: {
    role: string;
    filesOrPath?: string;
    url?: string;
    adrOrIssue?: string;
    notes?: string;
  };
}

export interface ArchitectureGroupData {
  id: string;
  title: string;
  icon?: string | ReactNode;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string; // Border and title accent
  bg?: string;
  dashed?: boolean;
  badge?: string;
}

export interface StepBadgeData {
  number: number;
  x: number;
  y: number;
  color?: string;
}

export interface LineBadgeData {
  text: string;
  x: number;
  y: number;
  icon?: string;
}

export interface ArchitectureLineData {
  id: string;
  path: string; // SVG path `d`
  color?: string;
  width?: number;
  dashed?: boolean;
  markerEnd?: string;
  stepBadge?: StepBadgeData;
  labelBadge?: LineBadgeData;
  from?: string;
  to?: string;
  label?: string;
  step?: number;
}

export interface StepExplanation {
  step: number;
  title: string;
  detail: string;
  sourceNode?: string;
  targetNode?: string;
}

export interface ViewDefinition {
  id: "repo-current" | "repo-vision" | "infra-current" | "infra-vision" | "db-current" | "db-vision" | "gitdiagram";
  title: string;
  subtitle: string;
  badge: {
    text: string;
    color: string;
  };
  summary: string;
  viewBox: string;
  groups: ArchitectureGroupData[];
  nodes: ArchitectureNodeData[];
  lines: ArchitectureLineData[];
  stepBreakdown: StepExplanation[];
  rawMermaid?: string;
}
