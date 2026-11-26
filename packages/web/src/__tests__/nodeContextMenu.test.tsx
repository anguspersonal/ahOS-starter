import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { NodeContextMenu } from "../components/graph/NodeContextMenu.js";
import type { GraphNode } from "../components/graph/types.js";

describe("NodeContextMenu", () => {
  const dummyNode: GraphNode = {
    id: "node-123-abc",
    title: "Project Obsidian",
    entity_type: "project",
    x: 200,
    y: 300,
    vx: 0,
    vy: 0,
    radius: 20,
    hot: false,
    zoom_level: 2,
    properties: {},
  };

  const dummyPersonNode: GraphNode = {
    id: "person-456-def",
    title: "Ada Lovelace",
    entity_type: "person",
    x: 100,
    y: 150,
    vx: 0,
    vy: 0,
    radius: 24,
    hot: true,
    zoom_level: 1,
    properties: { closeness_ring: 2 },
  };

  const defaultProps = {
    node: dummyNode,
    position: { x: 120, y: 180 },
    onClose: vi.fn(),
    isNight: true,
    isPinned: false,
    isIsolated: false,
    onInspect: vi.fn(),
    onCenter: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleIsolate: vi.fn(),
    onToggleHot: vi.fn(),
    onToggleTBox: vi.fn(),
    onUpdateZoomLevel: vi.fn(),
    onUpdateClosenessRing: vi.fn(),
    onOpenMiniChat: vi.fn(),
    onArchiveEntity: vi.fn(),
  };

  const cleanRender = (el: React.ReactElement): string => {
    return renderToString(el).replace(/<!-- -->/g, "");
  };

  it("renders node title, type badge, and hierarchy level", () => {
    const html = cleanRender(<NodeContextMenu {...defaultProps} />);
    expect(html).toContain("Project Obsidian");
    expect(html).toContain("project");
    expect(html).toContain("L2");
    expect(html).toContain("Inspect Details");
    expect(html).toContain("Center Camera");
    expect(html).toContain("Isolate Neighborhood");
    expect(html).toContain("Pin in Place");
    expect(html).toContain("Mark as Hot Priority");
    expect(html).toContain("Set as T-Box Concept");
    expect(html).toContain("Discuss with AI");
    expect(html).toContain("Copy Entity ID");
    expect(html).toContain("Copy Markdown Link");
    expect(html).toContain("Archive Entity");
  });

  it("displays pinned and isolated states correctly", () => {
    const html = cleanRender(
      <NodeContextMenu
        {...defaultProps}
        isPinned={true}
        isIsolated={true}
      />
    );
    expect(html).toContain("📌 Pinned");
    expect(html).toContain("Unpin Node");
    expect(html).toContain("Clear Neighborhood Isolation");
  });

  it("displays hot and t-box status chips when enabled", () => {
    const tboxNode: GraphNode = {
      ...dummyNode,
      hot: true,
      properties: { is_tbox: true },
    };
    const html = cleanRender(
      <NodeContextMenu
        {...defaultProps}
        node={tboxNode}
      />
    );
    expect(html).toContain("⭐ Hot");
    expect(html).toContain("🏷️ T-Box");
    expect(html).toContain("Remove Hot Priority");
    expect(html).toContain("Unset T-Box Concept");
  });

  it("renders closeness ring menu for person entities", () => {
    const html = cleanRender(
      <NodeContextMenu
        {...defaultProps}
        node={dummyPersonNode}
      />
    );
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Closeness Ring");
    expect(html).toContain("Ring 2 of 7");
  });

  it("omits closeness ring menu for non-person entities", () => {
    const html = cleanRender(
      <NodeContextMenu
        {...defaultProps}
        node={dummyNode}
      />
    );
    expect(html).not.toContain("Closeness Ring");
  });

  it("respects light mode styling classes", () => {
    const html = cleanRender(
      <NodeContextMenu
        {...defaultProps}
        isNight={false}
      />
    );
    expect(html).toContain("bg-white/95");
    expect(html).toContain("border-slate-200/90");
  });
});
