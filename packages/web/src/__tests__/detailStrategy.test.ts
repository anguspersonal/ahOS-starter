import { describe, expect, it } from "vitest";
import {
  resolveNodeClusterKey,
  getClusterColor,
  CLUSTER_COLOR_PALETTE,
  getClusterMacroRadius,
  relaxClusterPositions,
  type ClusterGroup,
} from "../components/graph/EntityGraphCanvas.js";
import { graphFilterInputSchema } from "../lib/graphActions.js";
import type { GraphNode } from "../components/graph/types.js";

describe("Detail Strategy & Multi-View Helpers", () => {
  const baseNode: GraphNode = {
    id: "test-node-1",
    title: "Test Node",
    entity_type: "project",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 28,
  };

  describe("resolveNodeClusterKey", () => {
    it("prioritizes domain_override when present", () => {
      const node: GraphNode = {
        ...baseNode,
        domain_override: "Tech",
        tags: ["personal", "health"],
        entity_type: "concept",
      };
      expect(resolveNodeClusterKey(node)).toBe("tech");
    });

    it("matches domain tags when domain_override is missing", () => {
      const node: GraphNode = {
        ...baseNode,
        tags: ["work", "important"],
        entity_type: "concept",
      };
      expect(resolveNodeClusterKey(node)).toBe("work");
    });

    it("falls back to entity_type when no domain tag exists", () => {
      const node: GraphNode = {
        ...baseNode,
        tags: ["random-tag"],
        entity_type: "system",
      };
      expect(resolveNodeClusterKey(node)).toBe("system");
    });

    it("defaults to other when entity_type is empty", () => {
      const node: GraphNode = {
        ...baseNode,
        tags: [],
        entity_type: "",
      };
      expect(resolveNodeClusterKey(node)).toBe("other");
    });
  });

  describe("getClusterColor", () => {
    it("returns mapped color for recognized cluster keys", () => {
      expect(getClusterColor("tech")).toBe(CLUSTER_COLOR_PALETTE.tech);
      expect(getClusterColor("work")).toBe(CLUSTER_COLOR_PALETTE.work);
      expect(getClusterColor("personal")).toBe(CLUSTER_COLOR_PALETTE.personal);
    });

    it("returns default fallback color for unrecognized cluster keys", () => {
      expect(getClusterColor("unrecognized_domain")).toBe("#6366f1");
    });
  });

  describe("getClusterMacroRadius", () => {
    it("returns base radius 46 for 1 node", () => {
      expect(getClusterMacroRadius(1)).toBe(46);
    });

    it("scales logarithmically for medium clusters", () => {
      const r20 = getClusterMacroRadius(20);
      expect(r20).toBeGreaterThan(50);
      expect(r20).toBeLessThan(60);
    });

    it("caps at maximum 64 for very large clusters", () => {
      expect(getClusterMacroRadius(157)).toBeGreaterThan(60);
      expect(getClusterMacroRadius(1000)).toBe(64);
    });
  });

  describe("relaxClusterPositions (Cluster Bubble De-overlapping)", () => {
    it("ensures zero overlap across multiple collapsed clusters initialized at the exact same point", () => {
      const mockClusters: ClusterGroup[] = [
        { key: "arrangement", label: "Arrangement", color: "#6366f1", nodes: new Array(157).fill(baseNode), centerX: 500, centerY: 400, radius: 100, isCollapsed: true },
        { key: "people", label: "People", color: "#3b82f6", nodes: new Array(20).fill(baseNode), centerX: 500, centerY: 400, radius: 80, isCollapsed: true },
        { key: "domain", label: "Domain", color: "#06b6d4", nodes: new Array(2).fill(baseNode), centerX: 500, centerY: 400, radius: 60, isCollapsed: true },
        { key: "place", label: "Place", color: "#10b981", nodes: new Array(2).fill(baseNode), centerX: 500, centerY: 400, radius: 60, isCollapsed: true },
        { key: "angus", label: "Angus", color: "#8b5cf6", nodes: new Array(4).fill(baseNode), centerX: 500, centerY: 400, radius: 60, isCollapsed: true },
        { key: "ahos", label: "Ahos", color: "#eab308", nodes: new Array(1).fill(baseNode), centerX: 500, centerY: 400, radius: 60, isCollapsed: true },
      ];

      const relaxed = relaxClusterPositions(mockClusters);
      expect(relaxed).toHaveLength(mockClusters.length);

      // Verify that every pair of bubbles has no overlap and maintains clear spacing
      for (let i = 0; i < relaxed.length; i++) {
        for (let j = i + 1; j < relaxed.length; j++) {
          const c1 = relaxed[i];
          const c2 = relaxed[j];
          const r1 = getClusterMacroRadius(c1.nodes.length);
          const r2 = getClusterMacroRadius(c2.nodes.length);
          const distance = Math.hypot(c1.centerX - c2.centerX, c1.centerY - c2.centerY);

          // Center-to-center distance must exceed sum of physical bubble radii
          expect(distance).toBeGreaterThanOrEqual(r1 + r2);
          // Border gap must be positive (clear visual separation)
          const borderGap = distance - (r1 + r2);
          expect(borderGap).toBeGreaterThan(10);
        }
      }
    });

    it("anchors expanded cluster while pushing collapsed bubbles outside its hull", () => {
      const mockClusters: ClusterGroup[] = [
        { key: "arrangement", label: "Arrangement", color: "#6366f1", nodes: new Array(157).fill(baseNode), centerX: 500, centerY: 400, radius: 120, isCollapsed: false },
        { key: "people", label: "People", color: "#3b82f6", nodes: new Array(20).fill(baseNode), centerX: 500, centerY: 400, radius: 80, isCollapsed: true },
      ];

      const relaxed = relaxClusterPositions(mockClusters);
      const expanded = relaxed[0];
      const collapsed = relaxed[1];

      // Expanded cluster position stays anchored to its simulated nodes
      expect(expanded.centerX).toBe(500);
      expect(expanded.centerY).toBe(400);

      // Collapsed bubble is pushed cleanly beyond the expanded cluster boundary
      const distance = Math.hypot(collapsed.centerX - expanded.centerX, collapsed.centerY - expanded.centerY);
      const minClearance = expanded.radius + getClusterMacroRadius(collapsed.nodes.length);
      expect(distance).toBeGreaterThanOrEqual(minClearance);
    });

    it("respects pinned cluster during interactive drag", () => {
      const mockClusters: ClusterGroup[] = [
        { key: "arrangement", label: "Arrangement", color: "#6366f1", nodes: new Array(10).fill(baseNode), centerX: 300, centerY: 300, radius: 60, isCollapsed: true },
        { key: "people", label: "People", color: "#3b82f6", nodes: new Array(10).fill(baseNode), centerX: 300, centerY: 300, radius: 60, isCollapsed: true },
      ];

      // Pin arrangement at (300, 300)
      const relaxed = relaxClusterPositions(mockClusters, "arrangement");
      const pinned = relaxed.find((c) => c.key === "arrangement")!;
      const other = relaxed.find((c) => c.key === "people")!;

      expect(pinned.centerX).toBe(300);
      expect(pinned.centerY).toBe(300);
      expect(Math.hypot(other.centerX - 300, other.centerY - 300)).toBeGreaterThan(80);
    });
  });

  describe("graphFilterInputSchema Detail Strategy parameters", () => {
    it("accepts valid detail_strategy and scope_tier", () => {
      const parsed = graphFilterInputSchema.parse({
        detail_strategy: "tiered",
        scope_tier: "pillars",
      });
      expect(parsed.detail_strategy).toBe("tiered");
      expect(parsed.scope_tier).toBe("pillars");
    });

    it("accepts clusters and landmarks strategies", () => {
      const parsedClusters = graphFilterInputSchema.parse({
        detail_strategy: "clusters",
      });
      expect(parsedClusters.detail_strategy).toBe("clusters");

      const parsedLandmarks = graphFilterInputSchema.parse({
        detail_strategy: "landmarks",
      });
      expect(parsedLandmarks.detail_strategy).toBe("landmarks");
    });
  });
});
