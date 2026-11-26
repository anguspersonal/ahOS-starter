import type { GraphNode } from "./types.js";
import { isSelfNode } from "./graphData.js";

export interface NetworkRingDefinition {
  ring: number; // 1 to 7
  label: string;
  shortLabel: string;
  description: string;
  color: string;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
  ringStroke: string;
  ringFill: string;
  baseRadius: number;
}

/**
 * 7 Concentric Rings metadata for the Specialised "Network" view.
 * Ring 1 is in the center (Me / Core), expanding outward to Ring 7 (Strangers).
 */
export const NETWORK_RINGS: NetworkRingDefinition[] = [
  {
    ring: 1,
    label: "Self & Core",
    shortLabel: "1 · Self & Core",
    description: "Me (Angus) and closest core life partner",
    color: "#818cf8", // Indigo
    badgeBg: "bg-indigo-950/80",
    badgeBorder: "border-indigo-500/50",
    badgeText: "text-indigo-300",
    ringStroke: "rgba(129, 140, 248, 0.45)",
    ringFill: "rgba(129, 140, 248, 0.04)",
    baseRadius: 75,
  },
  {
    ring: 2,
    label: "Inner Circle",
    shortLabel: "2 · Inner Circle",
    description: "Immediate family & nearest lifelong relationships",
    color: "#38bdf8", // Sky
    badgeBg: "bg-sky-950/80",
    badgeBorder: "border-sky-500/50",
    badgeText: "text-sky-300",
    ringStroke: "rgba(56, 189, 248, 0.4)",
    ringFill: "rgba(56, 189, 248, 0.03)",
    baseRadius: 145,
  },
  {
    ring: 3,
    label: "Close Network",
    shortLabel: "3 · Close Network",
    description: "Close friends, key collaborators, trusted partners",
    color: "#34d399", // Emerald
    badgeBg: "bg-emerald-950/80",
    badgeBorder: "border-emerald-500/50",
    badgeText: "text-emerald-300",
    ringStroke: "rgba(52, 211, 153, 0.35)",
    ringFill: "rgba(52, 211, 153, 0.025)",
    baseRadius: 220,
  },
  {
    ring: 4,
    label: "Active Collaborators",
    shortLabel: "4 · Active Collaborators",
    description: "Active project peers, working contacts, vendors",
    color: "#fbbf24", // Amber
    badgeBg: "bg-amber-950/80",
    badgeBorder: "border-amber-500/50",
    badgeText: "text-amber-300",
    ringStroke: "rgba(251, 191, 36, 0.35)",
    ringFill: "rgba(251, 191, 36, 0.02)",
    baseRadius: 300,
  },
  {
    ring: 5,
    label: "Acquaintances",
    shortLabel: "5 · Acquaintances",
    description: "Professional network, occasional collaborators, candidates",
    color: "#fb923c", // Orange
    badgeBg: "bg-orange-950/80",
    badgeBorder: "border-orange-500/50",
    badgeText: "text-orange-300",
    ringStroke: "rgba(251, 146, 60, 0.3)",
    ringFill: "rgba(251, 146, 60, 0.015)",
    baseRadius: 385,
  },
  {
    ring: 6,
    label: "Distant Connections",
    shortLabel: "6 · Distant Connections",
    description: "Extended network, met once, loose casual ties",
    color: "#f472b6", // Pink
    badgeBg: "bg-pink-950/80",
    badgeBorder: "border-pink-500/50",
    badgeText: "text-pink-300",
    ringStroke: "rgba(244, 114, 182, 0.25)",
    ringFill: "rgba(244, 114, 182, 0.01)",
    baseRadius: 475,
  },
  {
    ring: 7,
    label: "Strangers & Periphery",
    shortLabel: "7 · Strangers",
    description: "Weakest ties, external strangers, peripheral contacts",
    color: "#94a3b8", // Slate
    badgeBg: "bg-slate-900/80",
    badgeBorder: "border-slate-600/50",
    badgeText: "text-slate-300",
    ringStroke: "rgba(148, 163, 184, 0.25)",
    ringFill: "rgba(148, 163, 184, 0.01)",
    baseRadius: 570,
  },
];

/**
 * Resolves the 1..7 closeness ring for an entity node.
 * Checks properties.closeness_ring, node.closeness_ring, isSelfNode, tags, and heuristics.
 */
export function resolveNodeClosenessRing(node: {
  id?: string;
  title?: string;
  entity_type?: string;
  tags?: string[] | null;
  properties?: Record<string, unknown> | null;
  closeness_ring?: number;
}): number {
  // 1. Explicit properties.closeness_ring
  const rawProp = node.properties?.closeness_ring ?? node.properties?.network_ring ?? node.properties?.ring;
  if (typeof rawProp === "number" && !isNaN(rawProp)) {
    return Math.min(Math.max(Math.round(rawProp), 1), 7);
  }
  if (typeof rawProp === "string" && !isNaN(parseInt(rawProp, 10))) {
    return Math.min(Math.max(parseInt(rawProp, 10), 1), 7);
  }

  // 2. Direct property on node
  if (typeof node.closeness_ring === "number" && !isNaN(node.closeness_ring)) {
    return Math.min(Math.max(Math.round(node.closeness_ring), 1), 7);
  }

  // 3. Self node is always Ring 1 (center)
  if (isSelfNode(node)) {
    return 1;
  }

  const title = (node.title || "").trim().toLowerCase();
  const rawTags: unknown[] = [
    ...(Array.isArray(node.tags) ? node.tags : []),
    ...(Array.isArray(node.properties?.tags) ? node.properties.tags : []),
    ...(node.properties?.relationship ? [node.properties.relationship] : []),
    ...(node.properties?.relationship_type ? [node.properties.relationship_type] : []),
  ];
  const tags = rawTags.map((t) => String(t).toLowerCase());

  // 4. Partner (Laura) is Ring 1 (Core)
  if (title === "laura" || tags.includes("partner") || tags.includes("spouse")) {
    return 1;
  }

  // 5. Family tags -> Ring 2 (Inner Circle)
  if (tags.includes("family") || tags.includes("parent") || tags.includes("child") || tags.includes("sibling")) {
    return 2;
  }
  if (title === "sue" || title === "lois" || title === "muftau" || title === "archie" || title === "zara") {
    return 2;
  }

  // 6. Close friends & core collaborators -> Ring 3
  if (tags.includes("collaborator") || tags.includes("close-friend") || tags.includes("friend")) {
    return 3;
  }
  if (title === "felipe catalano" || title === "oleh petrivskyy") {
    return 3;
  }

  // 7. Active working network & coordinators -> Ring 4
  if (tags.includes("vendor") || tags.includes("wedding") || tags.includes("advisor") || tags.includes("cfo")) {
    return 4;
  }
  if (title === "hannah turner" || title === "lynsay borthwick" || title === "graeme rodd") {
    return 4;
  }

  // 8. Acquaintances & candidates -> Ring 5
  if (tags.includes("candidate") || tags.includes("developer")) {
    return 5;
  }
  if (title === "leon" || title === "sam" || title === "karen kellaway") {
    return 5;
  }

  // 9. Distant ties -> Ring 6
  if (title === "matt main" || title === "carson mackin" || title === "dalila") {
    return 6;
  }

  // 10. Strangers / former / unmet -> Ring 7
  if (tags.includes("former") || tags.includes("stranger") || title === "hiren" || title === "manos") {
    return 7;
  }

  // Default fallback for unclassified contacts: Ring 5 (Acquaintance)
  return 5;
}

/**
 * Returns the metadata definition for a given ring number (1..7).
 */
export function getNetworkRingDefinition(ringNumber: number): NetworkRingDefinition {
  const clamped = Math.min(Math.max(Math.round(ringNumber), 1), 7);
  return NETWORK_RINGS[clamped - 1] ?? NETWORK_RINGS[4];
}

/**
 * Checks if a given entity represents a person node.
 */
export function isPersonEntity(node: { entity_type: string; properties?: Record<string, unknown> | null }): boolean {
  const type = (node.entity_type || "").trim().toLowerCase();
  if (type === "people" || type === "person") return true;

  if (node.properties) {
    const propType = String(node.properties.type || "").trim().toLowerCase();
    if (propType === "people" || propType === "person") return true;

    if (Array.isArray(node.properties.tags)) {
      const lowerTags = node.properties.tags.map((t) => String(t).toLowerCase());
      if (lowerTags.includes("person") || lowerTags.includes("people")) return true;
    }
  }

  return false;
}

/**
 * Computes deterministic, neat concentric circle coordinates for a list of people nodes.
 * Anchors the user (Angus) at the center, and arranges other nodes evenly along their 7 concentric rings.
 */
export function applyConcentricNetworkLayout(
  nodes: GraphNode[],
  center: { x: number; y: number },
  scale = 1.0
): GraphNode[] {
  if (nodes.length === 0) return nodes;

  if (nodes.length === 1) {
    nodes[0].x = center.x;
    nodes[0].y = center.y;
    nodes[0].vx = 0;
    nodes[0].vy = 0;
    nodes[0].closeness_ring = resolveNodeClosenessRing(nodes[0]);
    return nodes;
  }

  // Group nodes by ring
  const ringBuckets = new Map<number, GraphNode[]>();
  for (let r = 1; r <= 7; r++) {
    ringBuckets.set(r, []);
  }

  for (const node of nodes) {
    const ring = resolveNodeClosenessRing(node);
    node.closeness_ring = ring;
    ringBuckets.get(ring)?.push(node);
  }

  // Place nodes on their respective rings
  for (let r = 1; r <= 7; r++) {
    const ringDef = getNetworkRingDefinition(r);
    const bucket = ringBuckets.get(r) || [];
    const count = bucket.length;
    if (count === 0) continue;

    const radius = ringDef.baseRadius * scale;

    if (r === 1) {
      // Ring 1 (Center): Find Self if present, anchor at center
      const selfIndex = bucket.findIndex((n) => isSelfNode(n));
      if (selfIndex !== -1) {
        const selfNode = bucket[selfIndex];
        selfNode.x = center.x;
        selfNode.y = center.y;
        selfNode.vx = 0;
        selfNode.vy = 0;

        // Other Ring 1 nodes (e.g. partner) placed around center at Ring 1 orbit
        const others = bucket.filter((_, idx) => idx !== selfIndex);
        others.forEach((n, idx) => {
          const angle = (idx / Math.max(1, others.length)) * 2 * Math.PI - Math.PI / 2;
          const r1Sub = ringDef.baseRadius * scale;
          n.x = center.x + r1Sub * Math.cos(angle);
          n.y = center.y + r1Sub * Math.sin(angle);
          n.vx = 0;
          n.vy = 0;
        });
        continue;
      }
    }

    // Rings 2 to 7 (or Ring 1 without self): Evenly distribute along circumference
    // Stagger angle offsets by ring so nodes don't form straight radial lines
    const angleOffset = (r * 0.42) - Math.PI / 2;
    bucket.forEach((node, idx) => {
      const angle = (idx / count) * 2 * Math.PI + angleOffset;
      node.x = center.x + radius * Math.cos(angle);
      node.y = center.y + radius * Math.sin(angle);
      node.vx = 0;
      node.vy = 0;
    });
  }

  return nodes;
}

/**
 * Counts people nodes per ring in the dataset.
 */
export function getNetworkRingCounts(nodes: GraphNode[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (let r = 1; r <= 7; r++) {
    counts.set(r, 0);
  }
  for (const node of nodes) {
    if (isPersonEntity(node)) {
      const ring = resolveNodeClosenessRing(node);
      counts.set(ring, (counts.get(ring) || 0) + 1);
    }
  }
  return counts;
}
