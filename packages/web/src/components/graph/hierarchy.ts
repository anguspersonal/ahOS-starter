import type { GraphEdge, GraphNode } from "./types.js";

/**
 * Standard relationship types indicating directed hierarchical parent-to-child or child-to-parent linkage.
 */
export const PARENT_TO_CHILD_RELATIONSHIPS = new Set([
  "parentOf",
  "contains",
  "has_part",
  "narrower",
  "employer", // employment arrangement -> organization
]);

export const CHILD_TO_PARENT_RELATIONSHIPS = new Set([
  "childOf",
  "is_part_of",
  "belongs_to",
  "broader",
  "in_role",
  "member_of",
  "locatedIn",
  "attended",
]);

export interface HierarchyInfo {
  /** Maximum chain depth found across the graph (0 if no hierarchy edges, e.g. depth 2 means root -> child -> grandchild). */
  maxDepth: number;
  /** Total levels based on the longest chain: maxDepth + 1. */
  maxLevels: number;
  /** Map of node ID to its 0-indexed hierarchical depth (roots = 0, children = 1, grandchildren = 2, etc.). */
  nodeDepths: Map<string, number>;
  /** Map of child node ID to its primary parent node ID. */
  parentMap: Map<string, string>;
  /** Map of parent node ID to list of direct child node IDs. */
  childrenMap: Map<string, string[]>;
  /** IDs of root parent nodes (nodes that have children and are at depth 0). */
  rootIds: Set<string>;
}

export interface GroupedGraphResult {
  /** Nodes that remain visible on the canvas, with grouped descendants populated on parent nodes. */
  visibleNodes: GraphNode[];
  /** Edges that connect visible nodes, with hidden descendant endpoints re-routed to their visible parent. */
  visibleEdges: GraphEdge[];
  /** Map from any hidden node ID to the visible parent node ID it was grouped into. */
  hiddenToVisibleParentMap: Map<string, string>;
  /** Total count of nodes currently hidden into groups. */
  totalGroupedNodesCount: number;
}

/**
 * Analyze nodes and edges to build a hierarchical forest and compute the longest chain.
 */
export function buildHierarchy(nodes: GraphNode[], edges: GraphEdge[]): HierarchyInfo {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  const parentMap = new Map<string, string>(); // childId -> parentId
  const childrenMap = new Map<string, string[]>(); // parentId -> childIds

  // Build parent-child links from hierarchical edge types
  for (const edge of edges) {
    let parentId: string | null = null;
    let childId: string | null = null;

    if (PARENT_TO_CHILD_RELATIONSHIPS.has(edge.relationship_type)) {
      parentId = edge.from_entity_id;
      childId = edge.to_entity_id;
    } else if (CHILD_TO_PARENT_RELATIONSHIPS.has(edge.relationship_type)) {
      parentId = edge.to_entity_id;
      childId = edge.from_entity_id;
    }

    if (parentId && childId && parentId !== childId && nodeMap.has(parentId) && nodeMap.has(childId)) {
      // Prioritize primary containment (e.g. belongs_to, parentOf) if child already has a parent
      if (!parentMap.has(childId) || edge.relationship_type === "belongs_to" || edge.relationship_type === "parentOf") {
        parentMap.set(childId, parentId);
      }
    }
  }

  // Populate childrenMap from parentMap
  for (const [childId, parentId] of parentMap.entries()) {
    const list = childrenMap.get(parentId) || [];
    list.push(childId);
    childrenMap.set(parentId, list);
  }

  // Compute depth for every node
  const nodeDepths = new Map<string, number>();
  const rootIds = new Set<string>();

  // Helper to compute depth with cycle prevention
  function getNodeDepth(nodeId: string, visited: Set<string> = new Set()): number {
    if (nodeDepths.has(nodeId)) {
      return nodeDepths.get(nodeId)!;
    }
    const parentId = parentMap.get(nodeId);
    if (!parentId || visited.has(parentId) || !nodeMap.has(parentId)) {
      nodeDepths.set(nodeId, 0);
      return 0;
    }
    visited.add(nodeId);
    const parentDepth = getNodeDepth(parentId, visited);
    const depth = parentDepth + 1;
    nodeDepths.set(nodeId, depth);
    return depth;
  }

  for (const node of nodes) {
    getNodeDepth(node.id);
  }

  // Identify roots (depth 0 nodes that have children)
  for (const [parentId, children] of childrenMap.entries()) {
    if ((nodeDepths.get(parentId) ?? 0) === 0 && children.length > 0) {
      rootIds.add(parentId);
    }
  }

  let maxDepth = 0;
  for (const d of nodeDepths.values()) {
    if (d > maxDepth) maxDepth = d;
  }

  const maxLevels = maxDepth > 0 ? maxDepth + 1 : 1;

  return {
    maxDepth,
    maxLevels,
    nodeDepths,
    parentMap,
    childrenMap,
    rootIds,
  };
}

/**
 * Group/collapse nodes into their parents based on a selected visible depth level.
 *
 * @param nodes Filtered nodes to group
 * @param edges Filtered edges
 * @param hierarchy Hierarchy analysis
 * @param visibleLevel The maximum generation level to show (e.g. 1 = Roots only; 2 = Roots + Children, collapse grandchildren; null = All levels expanded).
 */
export function applyHierarchyGrouping(
  nodes: GraphNode[],
  edges: GraphEdge[],
  hierarchy: HierarchyInfo,
  visibleLevel: number | null
): GroupedGraphResult {
  // If visibleLevel is null or >= maxLevels, no grouping is applied
  if (visibleLevel === null || visibleLevel >= hierarchy.maxLevels) {
    for (const n of nodes) {
      n.groupedDescendantCount = 0;
      n.groupedDescendants = [];
    }
    return {
      visibleNodes: nodes,
      visibleEdges: edges,
      hiddenToVisibleParentMap: new Map(),
      totalGroupedNodesCount: 0,
    };
  }

  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // Allowed depth is strictly less than visibleLevel (0-indexed: level 1 allows depth 0, level 2 allows depth 0 and 1)
  const maxAllowedDepth = Math.max(0, visibleLevel - 1);

  const hiddenToVisibleParentMap = new Map<string, string>();
  const parentGroupedDescendantsMap = new Map<string, GraphNode[]>();

  // Find the visible ancestor for each node
  for (const node of nodes) {
    const depth = hierarchy.nodeDepths.get(node.id) ?? 0;
    if (depth > maxAllowedDepth) {
      // Find ancestor whose depth is <= maxAllowedDepth
      let curr = hierarchy.parentMap.get(node.id);
      const visited = new Set<string>([node.id]);
      let visibleAncestorId: string | null = null;

      while (curr && !visited.has(curr)) {
        visited.add(curr);
        const currDepth = hierarchy.nodeDepths.get(curr) ?? 0;
        if (currDepth <= maxAllowedDepth && nodeMap.has(curr)) {
          visibleAncestorId = curr;
          break;
        }
        curr = hierarchy.parentMap.get(curr);
      }

      // If a visible ancestor is found, register this node as hidden under that ancestor
      if (visibleAncestorId) {
        hiddenToVisibleParentMap.set(node.id, visibleAncestorId);
        const list = parentGroupedDescendantsMap.get(visibleAncestorId) || [];
        list.push(node);
        parentGroupedDescendantsMap.set(visibleAncestorId, list);
      }
    }
  }

  // Construct visible nodes
  const visibleNodes: GraphNode[] = [];
  for (const node of nodes) {
    if (hiddenToVisibleParentMap.has(node.id)) {
      continue; // hidden inside parent
    }
    const grouped = parentGroupedDescendantsMap.get(node.id) || [];
    node.groupedDescendantCount = grouped.length;
    node.groupedDescendants = grouped;
    visibleNodes.push(node);
  }

  // Re-route edges connecting hidden nodes to their visible ancestors
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const edgeSeen = new Set<string>();
  const visibleEdges: GraphEdge[] = [];

  for (const edge of edges) {
    const effectiveFrom = hiddenToVisibleParentMap.get(edge.from_entity_id) ?? edge.from_entity_id;
    const effectiveTo = hiddenToVisibleParentMap.get(edge.to_entity_id) ?? edge.to_entity_id;

    // Skip self-edges created by grouping (both endpoints collapsed to the same parent)
    if (effectiveFrom === effectiveTo) {
      continue;
    }

    // Both endpoints must be visible
    if (!visibleNodeIds.has(effectiveFrom) || !visibleNodeIds.has(effectiveTo)) {
      continue;
    }

    const edgeKey = `${effectiveFrom}->${effectiveTo}:${edge.relationship_type}`;
    if (edgeSeen.has(edgeKey)) {
      continue;
    }
    edgeSeen.add(edgeKey);

    visibleEdges.push({
      ...edge,
      from_entity_id: effectiveFrom,
      to_entity_id: effectiveTo,
    });
  }

  return {
    visibleNodes,
    visibleEdges,
    hiddenToVisibleParentMap,
    totalGroupedNodesCount: hiddenToVisibleParentMap.size,
  };
}
