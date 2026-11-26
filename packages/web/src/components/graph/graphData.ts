import { supabase } from "../../lib/supabase.js";
import type { GraphData, GraphEdge, GraphNode } from "./types.js";
import { resolveNodeClosenessRing } from "./networkView.js";

/**
 * Built-in fallback dataset representing the authentic ahOS knowledge graph.
 * Used during offline exploration, demo mode, and automated test environments.
 */
export const FALLBACK_NODES: Omit<GraphNode, "x" | "y" | "vx" | "vy" | "radius">[] = [
  {
    id: "e-angus",
    title: "Angus Hally",
    entity_type: "people",
    description: "System owner, architect, and primary author of ahOS and Work.",
    tags: ["owner", "human", "architect"],
    hot: true,
    domain_override: "angus",
    aliases: ["Angus", "Owner"],
    properties: { zoom_level: 1, is_self: true, closeness_ring: 1 },
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "e-laura",
    title: "Laura",
    entity_type: "people",
    description: "User's partner, bride, and closest lifelong companion.",
    tags: ["partner", "wedding", "core"],
    hot: true,
    domain_override: "angus",
    aliases: ["Laura"],
    properties: { zoom_level: 2, closeness_ring: 1 },
    created_at: "2026-01-02T00:00:00Z",
  },
  // Ring 2: Inner Circle (Family)
  {
    id: "e-sue",
    title: "Sue",
    entity_type: "people",
    description: "Immediate family member.",
    tags: ["family", "wedding"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 3, closeness_ring: 2 },
    created_at: "2026-01-03T00:00:00Z",
  },
  {
    id: "e-lois",
    title: "Lois",
    entity_type: "people",
    description: "Laura's half-sister; lives in Zambia with partner Muftau and children Zara and Archie.",
    tags: ["family", "sister"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 3, closeness_ring: 2 },
    created_at: "2026-01-03T00:00:00Z",
  },
  {
    id: "e-archie",
    title: "Archie",
    entity_type: "people",
    description: "Nephew; child of Lois and Muftau.",
    tags: ["family", "nephew"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 4, closeness_ring: 2 },
    created_at: "2026-01-03T00:00:00Z",
  },
  // Ring 3: Close Network (Trusted Partners & Key Collaborators)
  {
    id: "e-felipe",
    title: "Felipe Catalano",
    entity_type: "people",
    description: "Google Cloud partner and infrastructure collaborator.",
    tags: ["google-cloud", "vendor", "residency", "collaborator"],
    hot: false,
    domain_override: "work",
    properties: { zoom_level: 4, closeness_ring: 3 },
    created_at: "2026-01-10T00:00:00Z",
  },
  {
    id: "e-oleh",
    title: "Oleh Petrivskyy",
    entity_type: "people",
    description: "CEO of Binariks, software development outsourcing and engineering partner.",
    tags: ["partner", "ceo", "collaborator"],
    hot: false,
    domain_override: "work",
    properties: { zoom_level: 4, closeness_ring: 3 },
    created_at: "2026-01-12T00:00:00Z",
  },
  // Ring 4: Active Collaborators (Working Network & Coordinators)
  {
    id: "e-hannah",
    title: "Hannah Turner",
    entity_type: "people",
    description: "Venue coordinator at RCPE for Angus and Laura's wedding.",
    tags: ["wedding", "vendor", "coordinator"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 5, closeness_ring: 4 },
    created_at: "2026-01-20T00:00:00Z",
  },
  {
    id: "e-lynsay",
    title: "Lynsay Borthwick",
    entity_type: "people",
    description: "Wedding planner, coordinating styling and RCPE scheduling.",
    tags: ["wedding", "vendor", "planner"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 5, closeness_ring: 4 },
    created_at: "2026-02-10T00:00:00Z",
  },
  {
    id: "e-graeme",
    title: "Graeme Rodd",
    entity_type: "people",
    description: "CFO of Anmut Ltd. Handling Angus's share buyback and option exercise.",
    tags: ["equity", "former-employer", "advisor"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 5, closeness_ring: 4 },
    created_at: "2026-02-15T00:00:00Z",
  },
  // Ring 5: Acquaintances (Candidates & Contacts)
  {
    id: "e-leon",
    title: "Leon",
    entity_type: "people",
    description: "Developer based in France; potential collaborator for Work.",
    tags: ["work", "candidate", "developer"],
    hot: false,
    domain_override: "work",
    properties: { zoom_level: 6, closeness_ring: 5 },
    created_at: "2026-03-01T00:00:00Z",
  },
  {
    id: "e-sam",
    title: "Sam",
    entity_type: "people",
    description: "Project acquaintance and contact.",
    tags: ["contact", "network"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 6, closeness_ring: 5 },
    created_at: "2026-03-02T00:00:00Z",
  },
  // Ring 6: Distant Connections (Loose Casual Ties)
  {
    id: "e-matt",
    title: "Matt Main",
    entity_type: "people",
    description: "Distant professional contact.",
    tags: ["contact", "distant"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 7, closeness_ring: 6 },
    created_at: "2026-03-10T00:00:00Z",
  },
  {
    id: "e-carson",
    title: "Carson Mackin",
    entity_type: "people",
    description: "Loose network acquaintance.",
    tags: ["contact", "distant"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 7, closeness_ring: 6 },
    created_at: "2026-03-11T00:00:00Z",
  },
  // Ring 7: Strangers & Periphery (Furthest)
  {
    id: "e-hiren",
    title: "Hiren",
    entity_type: "people",
    description: "Former contractor on Work; peripheral contact.",
    tags: ["work", "contractor", "former"],
    hot: false,
    domain_override: "work",
    properties: { zoom_level: 8, closeness_ring: 7 },
    created_at: "2026-03-20T00:00:00Z",
  },
  {
    id: "e-manos",
    title: "Manos",
    entity_type: "people",
    description: "External stranger and unmet contact.",
    tags: ["stranger", "external"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 8, closeness_ring: 7 },
    created_at: "2026-03-25T00:00:00Z",
  },
  {
    id: "e-ahos-core",
    title: "ahOS Core System",
    entity_type: "project",
    description: "Central personal operating system knowledge management graph and MCP runtime.",
    tags: ["core", "os", "architecture"],
    hot: true,
    domain_override: "angus",
    aliases: ["ahOS", "KMS"],
    properties: { zoom_level: 1 },
    created_at: "2026-01-02T00:00:00Z",
  },
  {
    id: "e-work-platform",
    title: "Work Platform",
    entity_type: "project",
    description: "Agent simulation, AI companion platform, and character studio ecosystem.",
    tags: ["companion", "simulation", "platform"],
    hot: true,
    domain_override: "work",
    aliases: ["Work"],
    properties: { zoom_level: 1 },
    created_at: "2026-01-05T00:00:00Z",
  },
  {
    id: "e-adr100",
    title: "ADR-100 Unified Action Registry",
    entity_type: "concept",
    description: "Architectural blueprint guaranteeing complete agent-UI capability parity.",
    tags: ["adr", "architecture", "actions"],
    hot: true,
    domain_override: "angus",
    aliases: ["ADR-100", "ActionRegistry"],
    properties: { zoom_level: 4, in_box: "TBox", level: "meta" },
    created_at: "2026-02-10T00:00:00Z",
  },
  {
    id: "e-foaf-graph",
    title: "FOAF & Entity Graph Model",
    entity_type: "concept",
    description: "Interpersonal social graph schema, temporal validity edges, and foaf predicates (ADR-025).",
    tags: ["graph", "foaf", "ontology"],
    hot: false,
    domain_override: "angus",
    aliases: ["FOAF"],
    properties: { zoom_level: 5, in_box: "TBox", level: "ontology" },
    created_at: "2026-03-01T00:00:00Z",
  },
  {
    id: "e-living-docs",
    title: "Living Documents Canvas",
    entity_type: "concept",
    description: "Interactive real-time co-editor canvas replacing archived web surfaces (ADR-096).",
    tags: ["co-editor", "ui", "adr-096"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 5 },
    created_at: "2026-04-12T00:00:00Z",
  },
  {
    id: "e-mcp-server",
    title: "MCP Server Package",
    entity_type: "capability",
    description: "JSON-RPC / SSE tool server registering capture, search, entity, and Notion tools.",
    tags: ["mcp", "tools", "backend"],
    hot: true,
    domain_override: "angus",
    aliases: ["@ahkms/mcp-server"],
    properties: { zoom_level: 4 },
    created_at: "2026-01-10T00:00:00Z",
  },
  {
    id: "e-tool-capture",
    title: "capture Tool",
    entity_type: "capability",
    description: "Fast multi-modal capture endpoint recording notes, links, and documents into Supabase.",
    tags: ["tool", "capture", "ingest"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 7 },
    created_at: "2026-01-15T00:00:00Z",
  },
  {
    id: "e-tool-search",
    title: "knowledge_search Tool",
    entity_type: "capability",
    description: "Hybrid vector and full-text retrieval tool scanning artifacts and entity neighborhoods.",
    tags: ["tool", "search", "embeddings"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 7 },
    created_at: "2026-01-20T00:00:00Z",
  },
  {
    id: "e-tool-relate",
    title: "relate_entities Tool",
    entity_type: "capability",
    description: "Forms directed relational links between entities with confidence and temporal bounds.",
    tags: ["tool", "graph", "relationships"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 8 },
    created_at: "2026-03-05T00:00:00Z",
  },
  {
    id: "e-domain-angus",
    title: "Angus Domain",
    entity_type: "domain",
    description: "Scope axis for personal knowledge, finances, private records, and system administration.",
    tags: ["scope", "domain", "private"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 1 },
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "e-domain-work",
    title: "Work Domain",
    entity_type: "domain",
    description: "Scope axis for Work commercial entity, team operations, and public agents.",
    tags: ["scope", "domain", "company"],
    hot: false,
    domain_override: "work",
    properties: { zoom_level: 1 },
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "e-area-pkm",
    title: "Personal Knowledge Management",
    entity_type: "area",
    description: "High-level life area encompassing notes, daily rituals, decisions, and knowledge retention.",
    tags: ["area", "para", "knowledge"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 2 },
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "e-area-agents",
    title: "Agent Systems & Automation",
    entity_type: "area",
    description: "Continuous autonomous agent fleet orchestration, background cadences, and MCP workflows.",
    tags: ["area", "agents", "fleet"],
    hot: false,
    domain_override: "angus",
    properties: { zoom_level: 2 },
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "e-term-arrangement",
    title: "Arrangement Concept Term",
    entity_type: "concept",
    description: "Canonical T-Box vocabulary term grounding runtime reified arrangements (ADR-036 / ADR-037).",
    tags: ["tbox", "term", "ontology"],
    hot: false,
    domain_override: "angus",
    aliases: ["ArrangementTerm", "ahos:Arrangement"],
    properties: {
      zoom_level: 2,
      type: "ahos_concept_term",
      term: "arrangement",
      local_name: "Arrangement",
      in_box: "TBox",
      level: "ontology",
    },
    created_at: "2026-03-15T00:00:00Z",
  },
  {
    id: "e-ns-ahos",
    title: "ahos",
    entity_type: "concept",
    description: "Canonical ahOS ontology namespace binding (ADR-037 §2).",
    tags: ["tbox", "namespace", "ontology"],
    hot: false,
    domain_override: "angus",
    aliases: ["ahos-ns", "ahos:Ontology"],
    properties: {
      zoom_level: 2,
      type: "ahos_namespace",
      prefix: "ahos",
      namespace_iri: "https://example.com/ahos-ontology#",
      is_default: true,
      in_box: "TBox",
      level: "ontology",
    },
    created_at: "2026-03-01T00:00:00Z",
  },
];

export const FALLBACK_EDGES: GraphEdge[] = [
  {
    id: "rel-22",
    from_entity_id: "e-term-arrangement",
    to_entity_id: "e-ns-ahos",
    relationship_type: "defined_in_namespace",
    confidence_score: 1.0,
  },
  {
    id: "rel-21",
    from_entity_id: "e-term-arrangement",
    to_entity_id: "e-foaf-graph",
    relationship_type: "member_of",
    confidence_score: 1.0,
  },
  {
    id: "rel-1",
    from_entity_id: "e-angus",
    to_entity_id: "e-ahos-core",
    relationship_type: "authored_by",
    confidence_score: 1.0,
  },
  {
    id: "rel-2",
    from_entity_id: "e-angus",
    to_entity_id: "e-work-platform",
    relationship_type: "authored_by",
    confidence_score: 1.0,
  },
  {
    id: "rel-3",
    from_entity_id: "e-ahos-core",
    to_entity_id: "e-domain-angus",
    relationship_type: "binding_scope",
    confidence_score: 1.0,
  },
  {
    id: "rel-4",
    from_entity_id: "e-work-platform",
    to_entity_id: "e-domain-work",
    relationship_type: "binding_scope",
    confidence_score: 1.0,
  },
  {
    id: "rel-5",
    from_entity_id: "e-ahos-core",
    to_entity_id: "e-mcp-server",
    relationship_type: "contains",
    confidence_score: 0.95,
  },
  {
    id: "rel-6",
    from_entity_id: "e-mcp-server",
    to_entity_id: "e-tool-capture",
    relationship_type: "contains",
    confidence_score: 1.0,
  },
  {
    id: "rel-7",
    from_entity_id: "e-mcp-server",
    to_entity_id: "e-tool-search",
    relationship_type: "contains",
    confidence_score: 1.0,
  },
  {
    id: "rel-8",
    from_entity_id: "e-mcp-server",
    to_entity_id: "e-tool-relate",
    relationship_type: "contains",
    confidence_score: 1.0,
  },
  {
    id: "rel-9",
    from_entity_id: "e-tool-relate",
    to_entity_id: "e-foaf-graph",
    relationship_type: "implements",
    confidence_score: 0.9,
  },
  {
    id: "rel-10",
    from_entity_id: "e-ahos-core",
    to_entity_id: "e-adr100",
    relationship_type: "realises",
    confidence_score: 0.95,
  },
  {
    id: "rel-11",
    from_entity_id: "e-living-docs",
    to_entity_id: "e-adr100",
    relationship_type: "relates_to",
    confidence_score: 0.85,
  },
  {
    id: "rel-12",
    from_entity_id: "e-ahos-core",
    to_entity_id: "e-living-docs",
    relationship_type: "contains",
    confidence_score: 0.9,
  },
  {
    id: "rel-13",
    from_entity_id: "e-area-pkm",
    to_entity_id: "e-ahos-core",
    relationship_type: "contains",
    confidence_score: 0.8,
  },
  {
    id: "rel-14",
    from_entity_id: "e-area-agents",
    to_entity_id: "e-mcp-server",
    relationship_type: "contains",
    confidence_score: 0.85,
  },
  {
    id: "rel-15",
    from_entity_id: "e-area-agents",
    to_entity_id: "e-work-platform",
    relationship_type: "relates_to",
    confidence_score: 0.75,
  },
  // Social Network Relationships (Concentric Circles)
  {
    id: "rel-net-1",
    from_entity_id: "e-angus",
    to_entity_id: "e-laura",
    relationship_type: "partner_of",
    confidence_score: 1.0,
  },
  {
    id: "rel-net-2",
    from_entity_id: "e-angus",
    to_entity_id: "e-sue",
    relationship_type: "family_of",
    confidence_score: 1.0,
  },
  {
    id: "rel-net-3",
    from_entity_id: "e-laura",
    to_entity_id: "e-lois",
    relationship_type: "sibling_of",
    confidence_score: 1.0,
  },
  {
    id: "rel-net-4",
    from_entity_id: "e-lois",
    to_entity_id: "e-archie",
    relationship_type: "parent_of",
    confidence_score: 1.0,
  },
  {
    id: "rel-net-5",
    from_entity_id: "e-angus",
    to_entity_id: "e-felipe",
    relationship_type: "collaborates_with",
    confidence_score: 0.95,
  },
  {
    id: "rel-net-6",
    from_entity_id: "e-angus",
    to_entity_id: "e-oleh",
    relationship_type: "partnered_with",
    confidence_score: 0.9,
  },
  {
    id: "rel-net-7",
    from_entity_id: "e-laura",
    to_entity_id: "e-hannah",
    relationship_type: "coordinates_with",
    confidence_score: 0.85,
  },
  {
    id: "rel-net-8",
    from_entity_id: "e-hannah",
    to_entity_id: "e-lynsay",
    relationship_type: "introduced_by",
    confidence_score: 0.9,
  },
  {
    id: "rel-net-9",
    from_entity_id: "e-angus",
    to_entity_id: "e-graeme",
    relationship_type: "professional_contact",
    confidence_score: 0.8,
  },
  {
    id: "rel-net-10",
    from_entity_id: "e-angus",
    to_entity_id: "e-leon",
    relationship_type: "reviewed_candidate",
    confidence_score: 0.7,
  },
  {
    id: "rel-net-11",
    from_entity_id: "e-angus",
    to_entity_id: "e-sam",
    relationship_type: "acquainted_with",
    confidence_score: 0.6,
  },
  {
    id: "rel-net-12",
    from_entity_id: "e-angus",
    to_entity_id: "e-matt",
    relationship_type: "distant_contact",
    confidence_score: 0.4,
  },
  {
    id: "rel-net-13",
    from_entity_id: "e-angus",
    to_entity_id: "e-carson",
    relationship_type: "distant_contact",
    confidence_score: 0.4,
  },
  {
    id: "rel-net-14",
    from_entity_id: "e-angus",
    to_entity_id: "e-hiren",
    relationship_type: "former_contractor",
    confidence_score: 0.3,
  },
  {
    id: "rel-net-15",
    from_entity_id: "e-angus",
    to_entity_id: "e-manos",
    relationship_type: "unmet_contact",
    confidence_score: 0.2,
  },
];

/**
 * Determines whether a given entity node represents the system owner / self user (Angus Hally).
 * Checks ADR024 properties.is_self, static fallback ID "e-angus", owner tag, or title "Angus Hally".
 */
export function isSelfNode(node: {
  id?: string;
  title?: string;
  entity_type?: string;
  tags?: string[] | null;
  aliases?: string[] | null;
  properties?: Record<string, unknown> | null;
}): boolean {
  if (node.properties?.is_self === true || node.properties?.is_self === "true") {
    return true;
  }
  if (node.id === "e-angus") {
    return true;
  }
  const title = (node.title || "").trim().toLowerCase();
  if (title === "angus hally" || title === "angus (owner)" || title === "angus") {
    return true;
  }
  if (
    node.entity_type === "people" &&
    Array.isArray(node.tags) &&
    node.tags.some((t) => typeof t === "string" && (t.toLowerCase() === "owner" || t.toLowerCase() === "self"))
  ) {
    return true;
  }
  return false;
}

/**
 * Target cumulative node counts across 14 Level of Detail (LOD) zoom levels.
 * Guarantees strict subset nesting: L1 is between 3 and 15 (8 apex nodes),
 * and L14 reveals all nodes in the graph with gradual geometric expansion.
 */
export const TARGET_LOD_CUMULATIVE_COUNTS = [
  0,   // Level 0 (unused)
  8,   // Level 1: Apex root parents (Domains, Self, Core Areas)
  12,  // Level 2: Primary Areas & flagship projects
  17,  // Level 3: Anchor Projects & major orgs
  24,  // Level 4: Core Subsystems & immediate collaborators
  34,  // Level 5: Baseline 100% canvas working view
  48,  // Level 6: Operational ecosystem & partner orgs
  68,  // Level 7: Functional modules & core concepts
  95,  // Level 8: High-level capability clusters
  132, // Level 9: Detailed functional capabilities
  182, // Level 10: Primary working arrangements & roles
  248, // Level 11: Granular concepts & milestone events
  332, // Level 12: Secondary arrangements & places
  410, // Level 13: Leaf linkages & demonstrations
  Infinity, // Level 14: Complete substrate (all nodes visible)
];

export const TYPE_BASE_PRIORITY_SCORES: Record<string, number> = {
  domain: 10000,
  area: 5000,
  project: 3000,
  organization: 2000,
  people: 1000,
  resource: 500,
  concept: 300,
  capability: 200,
  event: 100,
  place: 80,
  signal: 50,
  arrangement: 10,
};

export const CORE_APEX_AREAS = new Set(["Work", "Business", "Technology", "Finance", "Home"]);

/**
 * Calculates calibrated zoom levels (1..14) for nodes according to the 14-level target structure.
 * Respects explicit user overrides in properties.zoom_level while placing root parent nodes
 * at Level 1 (between 3 and 15 nodes) and gradually revealing child subsets up to Level 14 (all nodes).
 */
export function calculateRecommendedZoomLevels<
  T extends {
    id: string;
    title: string;
    entity_type: string;
    properties?: Record<string, unknown> | null;
    zoom_level?: number;
  }
>(nodes: T[], edges: { from_entity_id: string; to_entity_id: string }[] = []): (T & { zoom_level: number })[] {
  // Compute degrees for centrality
  const degreeMap = new Map<string, number>();
  for (const edge of edges) {
    degreeMap.set(edge.from_entity_id, (degreeMap.get(edge.from_entity_id) || 0) + 1);
    degreeMap.set(edge.to_entity_id, (degreeMap.get(edge.to_entity_id) || 0) + 1);
  }

  // Score each node
  const scoredNodes = nodes.map((node) => {
    const isDomain = node.entity_type === "domain";
    const isSelf = isSelfNode(node);
    const isCoreArea = node.entity_type === "area" && CORE_APEX_AREAS.has(node.title);

    let priorityBoost = 0;
    if (isDomain || isSelf || isCoreArea) {
      priorityBoost = 100000;
    }

    const deg = degreeMap.get(node.id) || 0;
    const baseTypeScore = TYPE_BASE_PRIORITY_SCORES[node.entity_type] || 100;
    const score = priorityBoost + baseTypeScore * 10 + deg;

    const rawZoom = node.properties?.zoom_level;
    let explicitLevel: number | null = null;
    if (typeof rawZoom === "number" && !isNaN(rawZoom)) {
      explicitLevel = Math.min(Math.max(Math.round(rawZoom), 1), 14);
    } else if (typeof rawZoom === "string" && !isNaN(parseInt(rawZoom, 10))) {
      explicitLevel = Math.min(Math.max(parseInt(rawZoom, 10), 1), 14);
    }

    return {
      node,
      score,
      explicitLevel,
      isApex: isDomain || isSelf || isCoreArea,
    };
  });

  // Sort by score descending (apex and core hubs first)
  scoredNodes.sort((a, b) => b.score - a.score);

  // Scale target cumulative counts proportionally to dataset size
  const total = nodes.length;
  const ratio = total / 473;
  const scaledTargets = TARGET_LOD_CUMULATIVE_COUNTS.map((cnt, idx) => {
    if (idx === 0) return 0;
    if (idx === 14) return total;
    if (idx === 1) return Math.min(Math.max(Math.round(cnt * ratio), 3), 15);
    return Math.min(Math.round(cnt * ratio), total);
  });

  let currentLevel = 1;
  return scoredNodes.map((item, index) => {
    if (item.isApex) {
      return { ...item.node, zoom_level: 1 };
    }
    if (item.explicitLevel !== null) {
      return { ...item.node, zoom_level: item.explicitLevel };
    }

    while (currentLevel < 14 && index >= scaledTargets[currentLevel]) {
      currentLevel++;
    }

    return { ...item.node, zoom_level: currentLevel };
  });
}

/**
 * Initializes physical coordinates using a phyllotaxis (golden spiral) layout
 * around canvas center, guaranteeing uniform 2D dispersion without clustering.
 */
export function initializeNodePositions(
  nodes: (Omit<GraphNode, "x" | "y" | "vx" | "vy" | "radius"> & { zoom_level?: number })[],
  width = 900,
  height = 600
): GraphNode[] {
  const centerX = width / 2;
  const centerY = height / 2;
  const maxRadiusX = Math.max((width / 2) - 120, 220);
  const maxRadiusY = Math.max((height / 2) - 90, 180);
  // Golden ratio angle (~137.5077 degrees in radians)
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const scaleX = maxRadiusX / Math.max(maxRadiusY, 1);

  return nodes.map((node, i) => {
    // Resolve zoom_level (1..14) from properties.zoom_level, defaulting to 1
    // Domains and self entities are always apex Level 1
    const isDomain = node.entity_type === "domain";
    const isSelf = isSelfNode(node);
    let resolvedZoomLevel = 1;
    if (isDomain || isSelf) {
      resolvedZoomLevel = 1;
    } else {
      const rawZoom = node.properties?.zoom_level;
      if (typeof rawZoom === "number" && !isNaN(rawZoom)) {
        resolvedZoomLevel = Math.min(Math.max(Math.round(rawZoom), 1), 14);
      } else if (typeof rawZoom === "string" && !isNaN(parseInt(rawZoom, 10))) {
        resolvedZoomLevel = Math.min(Math.max(parseInt(rawZoom, 10), 1), 14);
      } else if (typeof node.zoom_level === "number" && !isNaN(node.zoom_level)) {
        resolvedZoomLevel = Math.min(Math.max(Math.round(node.zoom_level), 1), 14);
      }
    }

    const resolvedClosenessRing = resolveNodeClosenessRing(node);

    // Node 0 (apex / self) starts at center; subsequent nodes spiral outward smoothly
    let x = centerX;
    let y = centerY;
    if (i > 0) {
      const theta = i * goldenAngle;
      const unscaledR = Math.min(50 + Math.sqrt(i) * 28, maxRadiusY);
      x = centerX + unscaledR * scaleX * Math.cos(theta);
      y = centerY + unscaledR * Math.sin(theta);
    }

    return {
      ...node,
      zoom_level: resolvedZoomLevel,
      closeness_ring: resolvedClosenessRing,
      x,
      y,
      vx: 0,
      vy: 0,
      radius: node.hot ? 34 : 28,
    };
  });
}

/**
 * Fetches entities and relationships from Supabase, or returns fallback dataset
 * if running inside tests, unauthenticated, or network is unavailable.
 */
export async function fetchGraphData(
  width = 900,
  height = 600
): Promise<GraphData> {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process;
  if (proc?.env?.VITEST && !proc?.env?.TEST_LIVE_SUPABASE) {
    const calibratedFallback = calculateRecommendedZoomLevels(FALLBACK_NODES, FALLBACK_EDGES);
    return {
      nodes: initializeNodePositions(calibratedFallback, width, height),
      edges: FALLBACK_EDGES,
      isLive: false,
    };
  }

  try {
    const [entitiesRes, relationshipsRes] = await Promise.all([
      supabase
        .from("entities")
        .select(
          "id, title, entity_type, description, tags, archived, properties, source_url, aliases, hot, domain_override, created_at, updated_at"
        )
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("entity_relationships")
        .select(
          "id, from_entity_id, to_entity_id, relationship_type, confidence_score, metadata, valid_from, valid_to, archived"
        )
        .order("created_at", { ascending: false })
        .limit(1500),
    ]);

    if (!entitiesRes.error && entitiesRes.data && entitiesRes.data.length > 0) {
      const rawNodes = entitiesRes.data.map((row) => ({
        id: String(row.id),
        title: String(row.title || "Untitled Entity"),
        entity_type: String(row.entity_type || "concept"),
        description: row.description ? String(row.description) : null,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
        archived: Boolean(row.archived),
        properties: (row.properties as Record<string, unknown>) || null,
        source_url: row.source_url ? String(row.source_url) : null,
        aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
        hot: Boolean(row.hot),
        domain_override: row.domain_override ? String(row.domain_override) : null,
        created_at: row.created_at ? String(row.created_at) : undefined,
        updated_at: row.updated_at ? String(row.updated_at) : undefined,
      }));

      const rawEdges: GraphEdge[] = (relationshipsRes.data || []).map((row) => ({
        id: String(row.id),
        from_entity_id: String(row.from_entity_id),
        to_entity_id: String(row.to_entity_id),
        relationship_type: String(row.relationship_type || "relates_to"),
        confidence_score:
          row.confidence_score !== null && row.confidence_score !== undefined
            ? Number(row.confidence_score)
            : null,
        metadata: (row.metadata as Record<string, unknown>) || null,
        valid_from: row.valid_from ? String(row.valid_from) : null,
        valid_to: row.valid_to ? String(row.valid_to) : null,
        archived: Boolean(row.archived),
      }));

      const calibratedNodes = calculateRecommendedZoomLevels(rawNodes, rawEdges);
      return {
        nodes: initializeNodePositions(calibratedNodes, width, height),
        edges: rawEdges,
        isLive: true,
      };
    }
  } catch (_err) {
    // If Supabase fetch fails, fallback seamlessly
  }

  const calibratedFallback = calculateRecommendedZoomLevels(FALLBACK_NODES, FALLBACK_EDGES);
  return {
    nodes: initializeNodePositions(calibratedFallback, width, height),
    edges: FALLBACK_EDGES,
    isLive: false,
  };
}
