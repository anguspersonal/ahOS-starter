export interface GraphNode {
  id: string;
  title: string;
  entity_type: string;
  description?: string | null;
  tags?: string[] | null;
  archived?: boolean;
  properties?: Record<string, unknown> | null;
  source_url?: string | null;
  aliases?: string[];
  hot?: boolean;
  domain_override?: string | null;
  created_at?: string;
  updated_at?: string;
  // 2D Physics simulation coordinates and velocity
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  fx?: number | null; // pinned x when dragging
  fy?: number | null; // pinned y when dragging
  // Hierarchical node grouping
  groupedDescendantCount?: number;
  groupedDescendants?: GraphNode[];
  // Level of Detail (LOD) zoom visibility (1..14, defaults to 1)
  zoom_level?: number;
  // Network concentric circle ring (1..7, where 1 = me/core, 7 = strangers)
  closeness_ring?: number;
}

export type GraphSpecialisedView = "default" | "network";

export interface GraphEdge {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  confidence_score?: number | null;
  metadata?: Record<string, unknown> | null;
  valid_from?: string | null;
  valid_to?: string | null;
  archived?: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  isLive: boolean;
  error?: string | null;
}

export interface GraphFilter {
  searchQuery: string;
  selectedTypes: Set<string>;
  showArchived: boolean;
  isolatedNodeId?: string | null;
  hierarchyLevel?: number | null;
  lodMode?: "auto" | "show_all";
  maxZoomLevel?: number | null;
  activeView?: GraphSpecialisedView;
}

export interface GraphPhysicsConfig {
  repulsion: number;
  springLength: number;
  springStrength: number;
  gravity: number;
  collisionBuffer: number;
  damping: number;
  coolingRate: number;
}


