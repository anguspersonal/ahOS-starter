import { describe, it, expect } from "vitest";
import {
  NETWORK_RINGS,
  getNetworkRingDefinition,
  isPersonEntity,
  resolveNodeClosenessRing,
  applyConcentricNetworkLayout,
  getNetworkRingCounts,
} from "../components/graph/networkView.js";
import { stepSimulation, type ConcentricConstraint } from "../components/graph/forceSimulation.js";
import type { GraphNode } from "../components/graph/types.js";

function createMockNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "mock-1",
    title: "Test Node",
    entity_type: "people",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 16,
    properties: {},
    ...overrides,
  };
}

describe("Network View - Concentric Rings & Layout", () => {
  describe("NETWORK_RINGS definitions", () => {
    it("defines exactly 7 concentric rings with ascending radii", () => {
      expect(NETWORK_RINGS).toHaveLength(7);

      for (let i = 0; i < NETWORK_RINGS.length; i++) {
        const ring = NETWORK_RINGS[i];
        expect(ring.ring).toBe(i + 1);
        expect(ring.label).toBeTruthy();
        expect(ring.shortLabel).toBeTruthy();
        expect(ring.color).toBeTruthy();
        expect(ring.baseRadius).toBeGreaterThan(0);

        if (i > 0) {
          expect(ring.baseRadius).toBeGreaterThan(NETWORK_RINGS[i - 1].baseRadius);
        }
      }
    });

    it("retrieves the ring definition correctly via getNetworkRingDefinition", () => {
      const ring1 = getNetworkRingDefinition(1);
      expect(ring1.ring).toBe(1);
      expect(ring1.label).toContain("Self & Core");

      const ring7 = getNetworkRingDefinition(7);
      expect(ring7.ring).toBe(7);
      expect(ring7.label).toContain("Strangers");

      // Clamping out-of-range ring numbers
      expect(getNetworkRingDefinition(0).ring).toBe(1);
      expect(getNetworkRingDefinition(99).ring).toBe(7);
    });
  });

  describe("isPersonEntity", () => {
    it("identifies person / people entity types", () => {
      expect(isPersonEntity(createMockNode({ entity_type: "people" }))).toBe(true);
      expect(isPersonEntity(createMockNode({ entity_type: "person" }))).toBe(true);
      expect(isPersonEntity(createMockNode({ entity_type: "PEOPLE" }))).toBe(true);
    });

    it("identifies person entities by property tags or type", () => {
      expect(
        isPersonEntity(
          createMockNode({
            entity_type: "entity",
            properties: { type: "people" },
          })
        )
      ).toBe(true);

      expect(
        isPersonEntity(
          createMockNode({
            entity_type: "entity",
            properties: { tags: ["person", "mentor"] },
          })
        )
      ).toBe(true);
    });

    it("rejects non-person entities", () => {
      expect(isPersonEntity(createMockNode({ entity_type: "project" }))).toBe(false);
      expect(isPersonEntity(createMockNode({ entity_type: "place" }))).toBe(false);
      expect(isPersonEntity(createMockNode({ entity_type: "concept" }))).toBe(false);
    });
  });

  describe("resolveNodeClosenessRing", () => {
    it("respects explicit closeness_ring on node", () => {
      const node = createMockNode({ closeness_ring: 3 });
      expect(resolveNodeClosenessRing(node)).toBe(3);
    });

    it("respects explicit closeness_ring inside properties", () => {
      const node = createMockNode({ properties: { closeness_ring: 4 } });
      expect(resolveNodeClosenessRing(node)).toBe(4);
    });

    it("resolves self node (Angus Hally) as Ring 1", () => {
      const selfNode = createMockNode({
        title: "Angus Hally",
        properties: { is_self: true },
      });
      expect(resolveNodeClosenessRing(selfNode)).toBe(1);
    });

    it("resolves partner (Laura) as Ring 1", () => {
      const partnerNode = createMockNode({
        title: "Laura",
        properties: { relationship: "partner" },
      });
      expect(resolveNodeClosenessRing(partnerNode)).toBe(1);
    });

    it("resolves family members as Ring 2", () => {
      const familyNode = createMockNode({
        title: "Sue Hally",
        properties: { relationship_type: "family" },
      });
      expect(resolveNodeClosenessRing(familyNode)).toBe(2);
    });

    it("resolves strangers as Ring 7", () => {
      const strangerNode = createMockNode({
        title: "Random Contact",
        properties: { tags: ["stranger"] },
      });
      expect(resolveNodeClosenessRing(strangerNode)).toBe(7);
    });

    it("defaults unclassified people gracefully within 1..7", () => {
      const genericNode = createMockNode({
        title: "General Contact",
        properties: {},
      });
      const ring = resolveNodeClosenessRing(genericNode);
      expect(ring).toBeGreaterThanOrEqual(1);
      expect(ring).toBeLessThanOrEqual(7);
    });
  });

  describe("applyConcentricNetworkLayout", () => {
    it("anchors self node at center and distributes other nodes on concentric orbits", () => {
      const angus = createMockNode({
        id: "angus",
        title: "Angus Hally",
        properties: { is_self: true },
        closeness_ring: 1,
      });

      const laura = createMockNode({
        id: "laura",
        title: "Laura",
        closeness_ring: 1,
      });

      const sue = createMockNode({
        id: "sue",
        title: "Sue Hally",
        closeness_ring: 2,
      });

      const felipe = createMockNode({
        id: "felipe",
        title: "Felipe Catalano",
        closeness_ring: 3,
      });

      const nodes = [angus, laura, sue, felipe];
      const center = { x: 500, y: 350 };
      applyConcentricNetworkLayout(nodes, center, 1.0);

      // Angus should be centered
      expect(angus.x).toBe(500);
      expect(angus.y).toBe(350);

      // Laura is in Ring 1, radius ~ 75
      const distLaura = Math.hypot(laura.x - 500, laura.y - 350);
      expect(distLaura).toBeCloseTo(75, 0);

      // Sue is in Ring 2, radius ~ 145
      const distSue = Math.hypot(sue.x - 500, sue.y - 350);
      expect(distSue).toBeCloseTo(145, 0);

      // Felipe is in Ring 3, radius ~ 220
      const distFelipe = Math.hypot(felipe.x - 500, felipe.y - 350);
      expect(distFelipe).toBeCloseTo(220, 0);
    });

    it("handles empty and single node lists gracefully", () => {
      expect(() => applyConcentricNetworkLayout([], { x: 400, y: 300 })).not.toThrow();

      const single = createMockNode({ id: "alone" });
      applyConcentricNetworkLayout([single], { x: 400, y: 300 });
      expect(single.x).toBe(400);
      expect(single.y).toBe(300);
    });
  });

  describe("getNetworkRingCounts", () => {
    it("aggregates counts across all 7 rings", () => {
      const nodes = [
        createMockNode({ id: "1", closeness_ring: 1 }),
        createMockNode({ id: "2", closeness_ring: 1 }),
        createMockNode({ id: "3", closeness_ring: 2 }),
        createMockNode({ id: "4", closeness_ring: 7 }),
      ];

      const counts = getNetworkRingCounts(nodes);
      expect(counts.get(1)).toBe(2);
      expect(counts.get(2)).toBe(1);
      expect(counts.get(3)).toBe(0);
      expect(counts.get(7)).toBe(1);
    });
  });

  describe("Force Simulation Concentric Orbital Constraints", () => {
    it("locks center node and pulls orbital node radially toward target radius", () => {
      const centerNode = createMockNode({
        id: "center-node",
        x: 500,
        y: 400,
        vx: 10,
        vy: -10,
      });

      // Orbital node placed at radius 100 from center along +X axis, but target radius is 200
      const orbitalNode = createMockNode({
        id: "orbital-node",
        x: 600, // dist = 100
        y: 400,
        vx: 0,
        vy: 0,
      });

      const constraints = new Map<string, ConcentricConstraint>();
      constraints.set("center-node", {
        targetRadius: 0,
        centerX: 500,
        centerY: 400,
        isCenter: true,
      });
      constraints.set("orbital-node", {
        targetRadius: 200,
        centerX: 500,
        centerY: 400,
        isCenter: false,
      });

      const nodes = [centerNode, orbitalNode];

      stepSimulation(nodes, [], {
        alpha: 0.5,
        width: 1000,
        height: 800,
        repulsion: 0,
        springLength: 0,
        springStrength: 0,
        gravity: 0,
        damping: 0.8,
        concentricConstraints: constraints,
      });

      // Center node should remain locked at (500, 400) with 0 velocity
      expect(centerNode.x).toBe(500);
      expect(centerNode.y).toBe(400);
      expect(centerNode.vx).toBe(0);
      expect(centerNode.vy).toBe(0);

      // Orbital node should have received positive velocity along X pulling it toward radius 200
      expect(orbitalNode.vx).toBeGreaterThan(0);
      expect(orbitalNode.x).toBeGreaterThan(600);
    });
  });
});
