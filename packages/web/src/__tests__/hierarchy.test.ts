import { describe, it, expect } from "vitest";
import { buildHierarchy, applyHierarchyGrouping } from "../components/graph/hierarchy.js";
import type { GraphEdge, GraphNode } from "../components/graph/types.js";
import { FALLBACK_NODES, FALLBACK_EDGES } from "../components/graph/graphData.js";

function makeNode(id: string, title: string, entity_type: string = "concept"): GraphNode {
  return {
    id,
    title,
    entity_type,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 18,
  };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  type: string
): GraphEdge {
  return {
    id,
    from_entity_id: from,
    to_entity_id: to,
    relationship_type: type,
  };
}

describe("Knowledge Graph Hierarchy & Grouping", () => {
  it("computes 1 level when there are no hierarchical edges", () => {
    const nodes = [makeNode("n1", "Node 1"), makeNode("n2", "Node 2")];
    const edges = [makeEdge("e1", "n1", "n2", "knows")];

    const hierarchy = buildHierarchy(nodes, edges);
    expect(hierarchy.maxDepth).toBe(0);
    expect(hierarchy.maxLevels).toBe(1);
    expect(hierarchy.nodeDepths.get("n1")).toBe(0);
    expect(hierarchy.nodeDepths.get("n2")).toBe(0);
  });

  it("computes dynamic levels based on longest parent-child chain", () => {
    // Chain: Grandparent (root) -> Parent (child) -> Child (grandchild) -> Great-grandchild
    // 4 generations = 4 levels (maxDepth = 3)
    const nodes = [
      makeNode("root", "Root Parent", "area"),
      makeNode("child", "Child", "project"),
      makeNode("grandchild", "Grandchild", "capability"),
      makeNode("great_grandchild", "Great Grandchild", "resource"),
    ];

    const edges = [
      makeEdge("e1", "root", "child", "contains"), // parent_to_child
      makeEdge("e2", "child", "grandchild", "contains"), // parent_to_child
      makeEdge("e3", "great_grandchild", "grandchild", "is_part_of"), // child_to_parent
    ];

    const hierarchy = buildHierarchy(nodes, edges);
    expect(hierarchy.maxDepth).toBe(3);
    expect(hierarchy.maxLevels).toBe(4);

    expect(hierarchy.nodeDepths.get("root")).toBe(0);
    expect(hierarchy.nodeDepths.get("child")).toBe(1);
    expect(hierarchy.nodeDepths.get("grandchild")).toBe(2);
    expect(hierarchy.nodeDepths.get("great_grandchild")).toBe(3);
    expect(hierarchy.rootIds.has("root")).toBe(true);
  });

  it("handles SKOS broader / narrower and family parentOf / childOf", () => {
    const nodes = [
      makeNode("anne", "Anne Hally", "people"),
      makeNode("angus", "Angus Hally", "people"),
      makeNode("area-biz", "Business", "area"),
      makeNode("area-sub", "Product Strategy", "area"),
    ];

    const edges = [
      makeEdge("e1", "anne", "angus", "parentOf"),
      makeEdge("e2", "area-sub", "area-biz", "broader"),
    ];

    const hierarchy = buildHierarchy(nodes, edges);
    expect(hierarchy.maxDepth).toBe(1);
    expect(hierarchy.maxLevels).toBe(2);

    expect(hierarchy.nodeDepths.get("anne")).toBe(0);
    expect(hierarchy.nodeDepths.get("angus")).toBe(1);
    expect(hierarchy.nodeDepths.get("area-biz")).toBe(0);
    expect(hierarchy.nodeDepths.get("area-sub")).toBe(1);
  });

  it("safely handles circular / cyclic relationships without infinite loop", () => {
    const nodes = [makeNode("a", "Node A"), makeNode("b", "Node B")];
    const edges = [
      makeEdge("e1", "a", "b", "contains"),
      makeEdge("e2", "b", "a", "contains"),
    ];

    const hierarchy = buildHierarchy(nodes, edges);
    expect(hierarchy.maxLevels).toBeGreaterThanOrEqual(1);
  });

  describe("applyHierarchyGrouping", () => {
    const nodes = [
      makeNode("pkm", "PKM Area", "area"), // Level 0
      makeNode("ahos", "ahOS Core", "project"), // Level 1
      makeNode("mcp", "MCP Server", "capability"), // Level 2
      makeNode("capture", "Capture Tool", "capability"), // Level 3
      makeNode("independent", "Independent Topic", "concept"), // Level 0
    ];

    const edges = [
      makeEdge("e1", "pkm", "ahos", "contains"),
      makeEdge("e2", "ahos", "mcp", "contains"),
      makeEdge("e3", "mcp", "capture", "contains"),
      makeEdge("e4", "capture", "independent", "references"),
    ];

    const hierarchy = buildHierarchy(nodes, edges);

    it("leaves all nodes expanded when visibleLevel is null or >= maxLevels", () => {
      const result = applyHierarchyGrouping(nodes, edges, hierarchy, null);
      expect(result.visibleNodes).toHaveLength(5);
      expect(result.visibleEdges).toHaveLength(4);
      expect(result.totalGroupedNodesCount).toBe(0);
    });

    it("collapses all descendants into root parent when visibleLevel = 1", () => {
      // visibleLevel = 1 means only depth 0 nodes are shown!
      // pkm and independent are at depth 0.
      // ahos (depth 1), mcp (depth 2), capture (depth 3) are all collapsed into pkm!
      const result = applyHierarchyGrouping(nodes, edges, hierarchy, 1);

      expect(result.visibleNodes).toHaveLength(2);
      const visibleIds = result.visibleNodes.map((n) => n.id);
      expect(visibleIds).toContain("pkm");
      expect(visibleIds).toContain("independent");

      const pkmNode = result.visibleNodes.find((n) => n.id === "pkm");
      expect(pkmNode?.groupedDescendantCount).toBe(3);
      expect(pkmNode?.groupedDescendants?.map((d) => d.id)).toEqual(["ahos", "mcp", "capture"]);

      expect(result.totalGroupedNodesCount).toBe(3);

      // Edge e4 (capture -> independent) was re-routed: pkm -> independent!
      // Internal containment edges within pkm are hidden.
      expect(result.visibleEdges).toHaveLength(1);
      expect(result.visibleEdges[0].from_entity_id).toBe("pkm");
      expect(result.visibleEdges[0].to_entity_id).toBe("independent");
      expect(result.visibleEdges[0].relationship_type).toBe("references");
    });

    it("collapses grandchildren and beyond when visibleLevel = 2", () => {
      // visibleLevel = 2 means depth 0 and depth 1 are visible.
      // pkm (0), ahos (1), independent (0) visible.
      // mcp (2) and capture (3) collapsed into ahos (depth 1 parent)!
      const result = applyHierarchyGrouping(nodes, edges, hierarchy, 2);

      expect(result.visibleNodes).toHaveLength(3);
      const visibleIds = result.visibleNodes.map((n) => n.id);
      expect(visibleIds).toContain("pkm");
      expect(visibleIds).toContain("ahos");
      expect(visibleIds).toContain("independent");

      const ahosNode = result.visibleNodes.find((n) => n.id === "ahos");
      expect(ahosNode?.groupedDescendantCount).toBe(2);
      expect(ahosNode?.groupedDescendants?.map((d) => d.id)).toEqual(["mcp", "capture"]);

      // Edge e4 (capture -> independent) re-routed to ahos -> independent!
      // Edge e1 (pkm -> ahos) remains!
      expect(result.visibleEdges).toHaveLength(2);
      const edgePairs = result.visibleEdges.map((e) => `${e.from_entity_id}->${e.to_entity_id}`);
      expect(edgePairs).toContain("pkm->ahos");
      expect(edgePairs).toContain("ahos->independent");
    });
  });

  describe("Fallback Graph Dataset Hierarchy Integration", () => {
    it("determines longest chain and levels correctly on authentic ahOS graph dataset", () => {
      const fullFallbackNodes: GraphNode[] = FALLBACK_NODES.map((n) => ({
        ...n,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        radius: 18,
      }));
      const hierarchy = buildHierarchy(fullFallbackNodes, FALLBACK_EDGES);
      expect(hierarchy.maxDepth).toBeGreaterThanOrEqual(2);
      expect(hierarchy.maxLevels).toBe(hierarchy.maxDepth + 1);

      // Grouping level 1 should collapse children and grandchildren
      const grouped = applyHierarchyGrouping(fullFallbackNodes, FALLBACK_EDGES, hierarchy, 1);
      expect(grouped.totalGroupedNodesCount).toBeGreaterThan(0);
      expect(grouped.visibleNodes.length).toBeLessThan(fullFallbackNodes.length);

      // Every grouped parent should have groupedDescendants populated
      const parentsWithChildren = grouped.visibleNodes.filter((n) => (n.groupedDescendantCount || 0) > 0);
      expect(parentsWithChildren.length).toBeGreaterThan(0);
      for (const p of parentsWithChildren) {
        expect(p.groupedDescendants?.length).toBe(p.groupedDescendantCount);
      }
    });

    it("preserves node object reference identity and live physics coordinates across grouping", () => {
      const activeNode: GraphNode = {
        ...FALLBACK_NODES[0],
        x: 432.5,
        y: 876.1,
        vx: 12.3,
        vy: -5.4,
        radius: 20,
      };
      const nodes = [activeNode, ...FALLBACK_NODES.slice(1).map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, radius: 18 }))];
      const hierarchy = buildHierarchy(nodes, FALLBACK_EDGES);

      // Null visibleLevel (no grouping)
      const unGrouped = applyHierarchyGrouping(nodes, FALLBACK_EDGES, hierarchy, null);
      expect(unGrouped.visibleNodes[0]).toBe(activeNode);
      expect(unGrouped.visibleNodes[0].x).toBe(432.5);
      expect(unGrouped.visibleNodes[0].y).toBe(876.1);
      expect(unGrouped.visibleNodes[0].vx).toBe(12.3);
      expect(unGrouped.visibleNodes[0].vy).toBe(-5.4);

      // Level 1 grouping
      const grouped = applyHierarchyGrouping(nodes, FALLBACK_EDGES, hierarchy, 1);
      const matched = grouped.visibleNodes.find((n) => n.id === activeNode.id);
      if (matched) {
        expect(matched).toBe(activeNode);
        expect(matched.x).toBe(432.5);
        expect(matched.y).toBe(876.1);
        expect(matched.vx).toBe(12.3);
        expect(matched.vy).toBe(-5.4);
      }
    });
  });
});
