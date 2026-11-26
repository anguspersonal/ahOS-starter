import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  DEFAULT_PHYSICS_CONFIG,
  PHYSICS_PRESETS,
  PhysicsControlsPopover,
} from "../components/graph/PhysicsControlsPopover.js";
import { stepSimulation } from "../components/graph/forceSimulation.js";
import { graphFilterInputSchema } from "../lib/graphActions.js";
import type { GraphNode, GraphEdge } from "../components/graph/types.js";

describe("Physics & Force Controls", () => {
  it("provides valid default physics configuration values", () => {
    expect(DEFAULT_PHYSICS_CONFIG.repulsion).toBeGreaterThan(0);
    expect(DEFAULT_PHYSICS_CONFIG.springLength).toBeGreaterThan(0);
    expect(DEFAULT_PHYSICS_CONFIG.springStrength).toBeGreaterThan(0);
    expect(DEFAULT_PHYSICS_CONFIG.gravity).toBeGreaterThan(0);
    expect(DEFAULT_PHYSICS_CONFIG.collisionBuffer).toBeGreaterThan(0);
    expect(DEFAULT_PHYSICS_CONFIG.damping).toBeGreaterThan(0);
    expect(DEFAULT_PHYSICS_CONFIG.damping).toBeLessThan(1.0);
    expect(DEFAULT_PHYSICS_CONFIG.coolingRate).toBeGreaterThan(0.9);
    expect(DEFAULT_PHYSICS_CONFIG.coolingRate).toBeLessThan(1.0);
  });

  it("defines standard physics presets with safe numerical bounds", () => {
    const presetKeys = ["balanced", "sprawling", "compact", "fluid"];
    for (const key of presetKeys) {
      const preset = PHYSICS_PRESETS[key];
      expect(preset).toBeDefined();
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.config.repulsion).toBeGreaterThanOrEqual(3000);
      expect(preset.config.repulsion).toBeLessThanOrEqual(40000);
      expect(preset.config.springLength).toBeGreaterThanOrEqual(50);
      expect(preset.config.springLength).toBeLessThanOrEqual(350);
      expect(preset.config.springStrength).toBeGreaterThanOrEqual(0.005);
      expect(preset.config.gravity).toBeGreaterThanOrEqual(0.001);
      expect(preset.config.collisionBuffer).toBeGreaterThanOrEqual(10);
      expect(preset.config.damping).toBeGreaterThanOrEqual(0.60);
      expect(preset.config.coolingRate).toBeGreaterThanOrEqual(0.970);
    }
  });

  it("passes custom coolingRate and collisionBuffer into stepSimulation", () => {
    const nodes: GraphNode[] = [
      {
        id: "n1",
        title: "Alpha",
        entity_type: "project",
        x: 100,
        y: 100,
        vx: 0,
        vy: 0,
        radius: 20,
      },
      {
        id: "n2",
        title: "Beta",
        entity_type: "task",
        x: 120,
        y: 100,
        vx: 0,
        vy: 0,
        radius: 20,
      },
    ];
    const edges: GraphEdge[] = [
      {
        id: "e1",
        from_entity_id: "n1",
        to_entity_id: "n2",
        relationship_type: "relates_to",
      },
    ];

    const initialAlpha = 0.5;
    const customCoolingRate = 0.985;
    const nextAlpha = stepSimulation(nodes, edges, {
      alpha: initialAlpha,
      collisionBuffer: 40,
      coolingRate: customCoolingRate,
      repulsion: 12000,
      springLength: 150,
      springStrength: 0.04,
      gravity: 0.005,
      damping: 0.85,
    });

    expect(nextAlpha).toBeCloseTo(initialAlpha * customCoolingRate, 4);
    // Nodes should have been pushed apart due to collision buffer
    expect(nodes[0].x).toBeLessThan(100);
    expect(nodes[1].x).toBeGreaterThan(120);
  });

  it("validates physics parameters in graphFilterInputSchema", () => {
    const parsed = graphFilterInputSchema.safeParse({
      physics: {
        repulsion: 24000,
        springLength: 200,
        springStrength: 0.04,
        gravity: 0.005,
        collisionBuffer: 42,
        damping: 0.87,
        coolingRate: 0.992,
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.physics?.repulsion).toBe(24000);
      expect(parsed.data.physics?.springLength).toBe(200);
    }
  });

  it("renders PhysicsControlsPopover cleanly without crashing", () => {
    const html = renderToString(
      React.createElement(PhysicsControlsPopover, {
        isOpen: true,
        onClose: vi.fn(),
        config: DEFAULT_PHYSICS_CONFIG,
        onChange: vi.fn(),
        onReset: vi.fn(),
        onReheat: vi.fn(),
        isPaused: false,
        onTogglePause: vi.fn(),
      })
    );

    expect(html).toContain("Physics &amp; Forces");
    expect(html).toContain("Node Repulsion");
    expect(html).toContain("Link Distance");
    expect(html).toContain("Center Gravity");
    expect(html).toContain("Collision Buffer");
    expect(html).toContain("Friction / Damping");
    expect(html).toContain("Re-heat / Shake");
    expect(html).toContain("Reset Defaults");
  });

  it("returns null when PhysicsControlsPopover is closed", () => {
    const html = renderToString(
      React.createElement(PhysicsControlsPopover, {
        isOpen: false,
        onClose: vi.fn(),
        config: DEFAULT_PHYSICS_CONFIG,
        onChange: vi.fn(),
        onReset: vi.fn(),
        onReheat: vi.fn(),
        isPaused: false,
        onTogglePause: vi.fn(),
      })
    );

    expect(html).toBe("");
  });
});
