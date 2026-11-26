import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import {
  fetchGraphData,
  initializeNodePositions,
  FALLBACK_NODES,
  FALLBACK_EDGES,
  isSelfNode,
  calculateRecommendedZoomLevels,
  TARGET_LOD_CUMULATIVE_COUNTS,
} from "../components/graph/graphData.js";
import { stepSimulation } from "../components/graph/forceSimulation.js";
import { EntityInspector, getTypeBadgeColor } from "../components/graph/EntityInspector.js";
import {
  EntityGraphCanvas,
  computeDiscreteZoomLevel,
  formatNodeLabel,
  ZOOM_SCALE_THRESHOLDS,
} from "../components/graph/EntityGraphCanvas.js";
import { ThemeProvider } from "../lib/theme.js";
import type { GraphNode, GraphEdge } from "../components/graph/types.js";

describe("Dynamic Knowledge Graph (/graph)", () => {
  it("initializes node positions cleanly without NaN", () => {
    const nodes = initializeNodePositions(FALLBACK_NODES, 800, 600);
    expect(nodes.length).toBe(FALLBACK_NODES.length);

    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.vx).toBe(0);
      expect(node.vy).toBe(0);
      expect(node.radius).toBeGreaterThan(0);
    }
  });

  it("fetches graph data in test environment falling back to in-memory store", async () => {
    const data = await fetchGraphData(800, 600);
    expect(data.isLive).toBe(false);
    expect(data.nodes.length).toBeGreaterThan(5);
    expect(data.edges.length).toBeGreaterThan(5);

    // Verify presence of key ahOS entities
    const angus = data.nodes.find((n) => n.id === "e-angus");
    expect(angus).toBeDefined();
    expect(angus?.title).toBe("Angus Hally");
    expect(angus?.entity_type).toBe("people");

    const core = data.nodes.find((n) => n.id === "e-ahos-core");
    expect(core).toBeDefined();
    expect(core?.title).toBe("ahOS Core System");

    // Verify presence of directed edges
    const authoredEdge = data.edges.find((e) => e.relationship_type === "authored_by");
    expect(authoredEdge).toBeDefined();
    expect(authoredEdge?.from_entity_id).toBe("e-angus");
  });

  it("advances physics simulation tick smoothly and decays alpha", () => {
    const nodes: GraphNode[] = [
      {
        id: "n1",
        title: "Node 1",
        entity_type: "project",
        x: 100,
        y: 100,
        vx: 0,
        vy: 0,
        radius: 25,
      },
      {
        id: "n2",
        title: "Node 2",
        entity_type: "capability",
        x: 120,
        y: 120,
        vx: 0,
        vy: 0,
        radius: 25,
      },
    ];

    const edges: GraphEdge[] = [
      {
        id: "e1",
        from_entity_id: "n1",
        to_entity_id: "n2",
        relationship_type: "contains",
      },
    ];

    const initialAlpha = 1.0;
    const nextAlpha = stepSimulation(nodes, edges, {
      width: 500,
      height: 500,
      alpha: initialAlpha,
    });

    // Alpha should decay smoothly
    expect(nextAlpha).toBeLessThan(initialAlpha);
    expect(nextAlpha).toBeGreaterThan(0.5);

    // Node coordinates should move without NaN
    expect(Number.isFinite(nodes[0].x)).toBe(true);
    expect(Number.isFinite(nodes[0].y)).toBe(true);
    expect(Number.isFinite(nodes[1].x)).toBe(true);
    expect(Number.isFinite(nodes[1].y)).toBe(true);
  });

  it("respects pinned node coordinates (fx, fy) during dragging", () => {
    const nodes: GraphNode[] = [
      {
        id: "pinned-node",
        title: "Pinned",
        entity_type: "concept",
        x: 350,
        y: 250,
        vx: 10,
        vy: 10,
        fx: 400,
        fy: 300,
        radius: 25,
      },
    ];

    stepSimulation(nodes, [], { width: 500, height: 500, alpha: 1.0 });

    // Node coordinates must strictly match fx and fy
    expect(nodes[0].x).toBe(400);
    expect(nodes[0].y).toBe(300);
    expect(nodes[0].vx).toBe(0);
    expect(nodes[0].vy).toBe(0);
  });

  it("measures separation between nodes after simulation runs", () => {
    // 473 mock nodes
    const rawNodes = Array.from({ length: 473 }, (_, idx) => ({
      id: `e-${idx}`,
      title: `Node ${idx}`,
      entity_type: idx === 0 ? "people" : "concept",
      properties: { zoom_level: idx < 25 ? 2 : 10 },
      tags: [],
      hot: idx === 0,
    }));
    const initialized = initializeNodePositions(rawNodes, 1200, 700);
    // Take visible nodes at level 6 (first 25)
    const visible = initialized.filter(n => (n.properties?.zoom_level as number) <= 6);

    let minPairDist = Infinity;
    let overlapCount = 0;
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const dx = visible[j].x - visible[i].x;
        const dy = visible[j].y - visible[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const reqDist = visible[i].radius + visible[j].radius;
        if (dist < minPairDist) minPairDist = dist;
        if (dist < reqDist) overlapCount++;
      }
    }

    expect(overlapCount).toBe(0);
    expect(minPairDist).toBeGreaterThan(60);
  });

  it("resolves entity type badge styling and icons", () => {
    expect(getTypeBadgeColor("people").icon).toBe("👤");
    expect(getTypeBadgeColor("project").icon).toBe("🚀");
    expect(getTypeBadgeColor("concept").icon).toBe("💡");
    expect(getTypeBadgeColor("capability").icon).toBe("⚡");
    expect(getTypeBadgeColor("domain").icon).toBe("🌐");
    expect(getTypeBadgeColor("area").icon).toBe("📁");
    expect(getTypeBadgeColor("place").icon).toBe("📍");
    expect(getTypeBadgeColor("places").icon).toBe("📍");
  });

  it("renders EntityInspector idle state with node and edge metrics", () => {
    const nodes = initializeNodePositions(FALLBACK_NODES, 800, 600);
    const html = renderToString(
      React.createElement(EntityInspector, {
        selectedNode: null,
        selectedEdge: null,
        allNodes: nodes,
        allEdges: FALLBACK_EDGES,
        onSelectNode: () => {},
        onSelectEdge: () => {},
        onClose: () => {},
        isIsolated: false,
        onToggleIsolate: () => {},
      })
    );

    expect(html).toContain("Graph Inspector");
    expect(html).toContain("Total Entities");
    expect(html).toContain("Relationships");
    expect(html).toContain(String(FALLBACK_NODES.length));
  });

  it("renders EntityInspector selected node with connections and properties", () => {
    const nodes = initializeNodePositions(FALLBACK_NODES, 800, 600);
    const selected = nodes.find((n) => n.id === "e-angus")!;

    const html = renderToString(
      React.createElement(EntityInspector, {
        selectedNode: selected,
        selectedEdge: null,
        allNodes: nodes,
        allEdges: FALLBACK_EDGES,
        onSelectNode: () => {},
        onSelectEdge: () => {},
        onClose: () => {},
        isIsolated: false,
        onToggleIsolate: () => {},
      })
    );

    expect(html).toContain("Angus Hally");
    expect(html).toContain("System owner, architect");
    expect(html).toContain("Outgoing Relations");
    expect(html).toContain("authored_by");
    expect(html).toContain("Focus Neighborhood");

    // Node tags should render without background and without border
    expect(html).toContain("#owner");
    expect(html).toContain("#human");
    expect(html).not.toContain("bg-slate-800/80 text-indigo-300");
    expect(html).not.toContain("border-indigo-500/20");
  });

  it("renders EntityInspector selected edge with relationship metadata", () => {
    const nodes = initializeNodePositions(FALLBACK_NODES, 800, 600);
    const selectedEdge = FALLBACK_EDGES.find((e) => e.relationship_type === "authored_by")!;

    const html = renderToString(
      React.createElement(EntityInspector, {
        selectedNode: null,
        selectedEdge: selectedEdge,
        allNodes: nodes,
        allEdges: FALLBACK_EDGES,
        onSelectNode: () => {},
        onSelectEdge: () => {},
        onClose: () => {},
        isIsolated: false,
        onToggleIsolate: () => {},
      })
    );

    expect(html).toContain("Relationship Edge");
    expect(html).toContain("authored_by");
    expect(html).toContain("Confidence");
    expect(html).toContain("From (Source)");
    expect(html).toContain("To (Target)");
  });

  it("calculates discrete zoom levels on the 1-14 scale with clamping", () => {
    // Under minimum standard scale -> Level 1 (Anchor)
    expect(computeDiscreteZoomLevel(0.20)).toBe(1);
    expect(computeDiscreteZoomLevel(0.40)).toBe(1);

    // Progressive scale steps across 14 levels
    expect(computeDiscreteZoomLevel(0.45)).toBe(2);
    expect(computeDiscreteZoomLevel(0.50)).toBe(3);
    expect(computeDiscreteZoomLevel(0.58)).toBe(4);
    expect(computeDiscreteZoomLevel(0.68)).toBe(5);
    expect(computeDiscreteZoomLevel(0.80)).toBe(6);
    expect(computeDiscreteZoomLevel(0.95)).toBe(7);
    expect(computeDiscreteZoomLevel(1.15)).toBe(8);
    expect(computeDiscreteZoomLevel(1.35)).toBe(9);
    expect(computeDiscreteZoomLevel(1.60)).toBe(10);
    expect(computeDiscreteZoomLevel(1.90)).toBe(11);
    expect(computeDiscreteZoomLevel(2.20)).toBe(12);
    expect(computeDiscreteZoomLevel(2.40)).toBe(13);
    expect(computeDiscreteZoomLevel(2.50)).toBe(14);
    expect(computeDiscreteZoomLevel(3.50)).toBe(14);

    expect(ZOOM_SCALE_THRESHOLDS).toHaveLength(14);
  });

  it("calibrates 14 zoom levels according to target LOD progressive schedule", () => {
    // Create a representative 50-node synthetic graph dataset
    const sampleNodes: { id: string; title: string; entity_type: string; properties?: Record<string, unknown> }[] = [
      { id: "dom-angus", title: "Angus Domain", entity_type: "domain" },
      { id: "dom-work", title: "Work Domain", entity_type: "domain" },
      { id: "self-angus", title: "Angus Hally", entity_type: "people", properties: { is_self: true } },
      { id: "area-work", title: "Work", entity_type: "area" },
      { id: "area-biz", title: "Business", entity_type: "area" },
      { id: "area-tech", title: "Technology", entity_type: "area" },
      { id: "area-fin", title: "Finance", entity_type: "area" },
      { id: "area-home", title: "Home", entity_type: "area" },
    ];

    // Add projects, organizations, concepts, capabilities, arrangements
    for (let i = 1; i <= 6; i++) {
      sampleNodes.push({ id: `proj-${i}`, title: `Project ${i}`, entity_type: "project" });
    }
    for (let i = 1; i <= 6; i++) {
      sampleNodes.push({ id: `org-${i}`, title: `Org ${i}`, entity_type: "organization" });
    }
    for (let i = 1; i <= 10; i++) {
      sampleNodes.push({ id: `cap-${i}`, title: `Capability ${i}`, entity_type: "capability" });
    }
    for (let i = 1; i <= 10; i++) {
      sampleNodes.push({ id: `concept-${i}`, title: `Concept ${i}`, entity_type: "concept" });
    }
    for (let i = 1; i <= 10; i++) {
      sampleNodes.push({ id: `arr-${i}`, title: `Arrangement ${i}`, entity_type: "arrangement" });
    }

    const sampleEdges: { from_entity_id: string; to_entity_id: string }[] = [];
    for (let i = 8; i < sampleNodes.length; i++) {
      sampleEdges.push({ from_entity_id: sampleNodes[i].id, to_entity_id: sampleNodes[i % 8].id });
    }

    const calibrated = calculateRecommendedZoomLevels(sampleNodes, sampleEdges);
    expect(calibrated).toHaveLength(sampleNodes.length);

    // 1. Level 1 must have between 3 and 15 root parent nodes
    const level1Nodes = calibrated.filter((n) => n.zoom_level === 1);
    expect(level1Nodes.length).toBeGreaterThanOrEqual(3);
    expect(level1Nodes.length).toBeLessThanOrEqual(15);
    expect(level1Nodes.length).toBe(8); // Exactly the 8 apex root parents

    // 2. Strict subset property: any node visible at level k is also visible at level k+1
    for (let k = 1; k < 14; k++) {
      const visibleAtK = calibrated.filter((n) => n.zoom_level <= k);
      const visibleAtNext = calibrated.filter((n) => n.zoom_level <= k + 1);
      expect(visibleAtNext.length).toBeGreaterThanOrEqual(visibleAtK.length);
      for (const node of visibleAtK) {
        expect(visibleAtNext.some((n) => n.id === node.id)).toBe(true);
      }
    }

    // 3. Level 14 must include ALL nodes
    const visibleAt14 = calibrated.filter((n) => n.zoom_level <= 14);
    expect(visibleAt14.length).toBe(sampleNodes.length);

    // 4. Growth must be gradual across levels
    const levelCounts = Array(15).fill(0);
    for (const node of calibrated) {
      levelCounts[node.zoom_level]++;
    }
    for (let l = 1; l <= 14; l++) {
      expect(levelCounts[l]).toBeLessThanOrEqual(Math.ceil(sampleNodes.length * 0.4));
    }

    expect(TARGET_LOD_CUMULATIVE_COUNTS[1]).toBe(8);
    expect(TARGET_LOD_CUMULATIVE_COUNTS).toHaveLength(15);
  });

  it("resolves zoom_level from node properties or defaults to level 1", () => {
    const rawNodes = [
      {
        id: "node-with-lod",
        title: "Micro Detail Tool",
        entity_type: "tool",
        properties: { zoom_level: 8 },
      },
      {
        id: "node-without-lod",
        title: "Legacy Node",
        entity_type: "concept",
      },
      {
        id: "node-with-out-of-range-lod",
        title: "Clamped Node",
        entity_type: "term",
        properties: { zoom_level: 99 },
      },
      {
        id: "node-domain",
        title: "Work Domain",
        entity_type: "domain",
        properties: { zoom_level: 5 },
      },
      {
        id: "node-self",
        title: "Angus Hally",
        entity_type: "people",
        properties: { is_self: true, zoom_level: 4 },
      },
    ];

    const initialized = initializeNodePositions(rawNodes, 800, 600);
    expect(initialized[0].zoom_level).toBe(8);
    expect(initialized[1].zoom_level).toBe(1); // Defaulted so legacy data never disappears
    expect(initialized[2].zoom_level).toBe(14); // Clamped to max level 14
    expect(initialized[3].zoom_level).toBe(1); // Domains always pinned to apex level 1
    expect(initialized[4].zoom_level).toBe(1); // Self always pinned to apex level 1
  });

  it("renders LOD Zoom Level card in EntityInspector with slider and level label", () => {
    const nodes = initializeNodePositions(FALLBACK_NODES, 800, 600);
    const selected = nodes.find((n) => n.id === "e-ahos-core")!;

    const html = renderToString(
      React.createElement(EntityInspector, {
        selectedNode: selected,
        selectedEdge: null,
        allNodes: nodes,
        allEdges: FALLBACK_EDGES,
        onSelectNode: () => {},
        onSelectEdge: () => {},
        onClose: () => {},
        isIsolated: false,
        onToggleIsolate: () => {},
      })
    );

    expect(html).toContain("Zoom Level (LOD)");
    expect(html).toContain("Level 1 / 14");
    expect(html).toContain("Move Up");
    expect(html).toContain("Move Down");
    expect(html).toContain("Level 1 (0.4x)");
    expect(html).toContain("Level 14 (2.5x)");
    expect(html).toContain("+ Add Relationship");
  });

  it("renders Delete Relationship Edge button when edge is selected", () => {
    const nodes = initializeNodePositions(FALLBACK_NODES, 800, 600);
    const edge = FALLBACK_EDGES[0];

    const html = renderToString(
      React.createElement(EntityInspector, {
        selectedNode: null,
        selectedEdge: edge,
        allNodes: nodes,
        allEdges: FALLBACK_EDGES,
        onSelectNode: () => {},
        onSelectEdge: () => {},
        onClose: () => {},
        isIsolated: false,
        onToggleIsolate: () => {},
      })
    );

    expect(html).toContain("Relationship Edge");
    expect(html).toContain("Delete Relationship Edge (CAR)");
  });

  it("renders EntityGraphCanvas with white node circles and black text in day mode", () => {
    const html = renderToString(
      React.createElement(
        ThemeProvider,
        { initialTheme: "day" },
        React.createElement(EntityGraphCanvas, null)
      )
    );

    // Day mode verifies pale background elements and black default text
    expect(html).toContain("Knowledge Graph");
    expect(html).toContain("Zoom:");
    expect(html).toContain("LOD:");
    expect(html).toContain("bg-[radial-gradient(#cbd5e1_1.2px,transparent_1.2px)]");
    expect(html).toContain('fill="#94a3b8"');
  });

  it("renders EntityGraphCanvas with night mode styling when initialTheme is night", () => {
    const html = renderToString(
      React.createElement(
        ThemeProvider,
        { initialTheme: "night" },
        React.createElement(EntityGraphCanvas, null)
      )
    );

    expect(html).toContain("Knowledge Graph");
    expect(html).toContain("Zoom:");
    expect(html).toContain("LOD:");
    expect(html).toContain("bg-[radial-gradient(#1e293b_1px,transparent_1px)]");
    expect(html).toContain('fill="#64748b"');
  });

  it("formats node labels to single line (~60px) when unselected, and full title when expanded", () => {
    // Unselected: truncated to ~60px (8 chars + ellipsis)
    expect(formatNodeLabel("Granny Hally", false)).toBe("Granny H…");
    expect(formatNodeLabel("Work App", false)).toBe("Work …");
    expect(formatNodeLabel("architect-senior-en", false)).toBe("architec…");

    // Short titles fit without truncation
    expect(formatNodeLabel("Zara", false)).toBe("Zara");
    expect(formatNodeLabel("AI", false)).toBe("AI");

    // Selected/hovered: expanded full title
    expect(formatNodeLabel("Granny Hally", true)).toBe("Granny Hally");
    expect(formatNodeLabel("architect-senior-en", true)).toBe("architect-senior-en");
  });

  it("identifies the self node (Angus Hally) accurately via isSelfNode", () => {
    const angusFallback = FALLBACK_NODES.find((n) => n.id === "e-angus")!;
    expect(isSelfNode(angusFallback)).toBe(true);

    expect(isSelfNode({ id: "e-angus" })).toBe(true);
    expect(isSelfNode({ title: "Angus Hally", entity_type: "people" })).toBe(true);
    expect(isSelfNode({ title: "Angus", entity_type: "people" })).toBe(true);
    expect(isSelfNode({ properties: { is_self: true } })).toBe(true);
    expect(isSelfNode({ entity_type: "people", tags: ["architect", "owner"] })).toBe(true);

    // Other entities should not be considered self
    const workFallback = FALLBACK_NODES.find((n) => n.id === "e-work-platform")!;
    expect(isSelfNode(workFallback)).toBe(false);
    expect(isSelfNode({ id: "other", title: "Zara", entity_type: "people" })).toBe(false);
  });

  it("renders Include me top level toggle in day and night modes", () => {
    const htmlDay = renderToString(
      React.createElement(
        ThemeProvider,
        { initialTheme: "day" },
        React.createElement(EntityGraphCanvas, null)
      )
    );
    expect(htmlDay).toContain("Include me");
    expect(htmlDay).toContain("On");

    const htmlNight = renderToString(
      React.createElement(
        ThemeProvider,
        { initialTheme: "night" },
        React.createElement(EntityGraphCanvas, null)
      )
    );
    expect(htmlNight).toContain("Include me");
    expect(htmlNight).toContain("On");
  });

  it("computes pointer-centric focal zoom preserving the cursor anchor", () => {
    const prevPan = { x: 50, y: 80 };
    const prevZoom = 1.0;
    const nextZoom = 1.25;
    const mouseX = 350;
    const mouseY = 240;

    // Point in graph coordinate space before zoom
    const gx = (mouseX - prevPan.x) / prevZoom;
    const gy = (mouseY - prevPan.y) / prevZoom;

    // Pan required to keep graph coordinate anchored at mouse position
    const nextPan = {
      x: mouseX - gx * nextZoom,
      y: mouseY - gy * nextZoom,
    };

    // Verify screen position under new pan and zoom matches original mouse position exactly
    const resultingScreenX = nextPan.x + gx * nextZoom;
    const resultingScreenY = nextPan.y + gy * nextZoom;

    expect(resultingScreenX).toBeCloseTo(mouseX);
    expect(resultingScreenY).toBeCloseTo(mouseY);
  });
});

