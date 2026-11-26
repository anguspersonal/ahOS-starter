import { describe, it, expect } from "vitest";
import { ARCHITECTURE_VIEWS, VIEW_ORDER } from "../components/visual-meaning/views/index.js";

describe("Visual Meaning Architecture Views (@ahkms/web)", { timeout: 30_000 }, () => {
  it("registers exactly the seven architectural views", () => {
    expect(VIEW_ORDER).toEqual([
      "repo-current",
      "infra-current",
      "db-current",
      "gitdiagram",
      "repo-vision",
      "infra-vision",
      "db-vision",
    ]);

    for (const viewId of VIEW_ORDER) {
      expect(ARCHITECTURE_VIEWS[viewId]).toBeDefined();
      expect(ARCHITECTURE_VIEWS[viewId].id).toBe(viewId);
    }
  });

  describe("View 2: Monorepo Architecture & CI Delivery Pipeline (repo-current)", () => {
    const view = ARCHITECTURE_VIEWS["repo-current"];

    it("has valid metadata and boundaries", () => {
      expect(view.title).toContain("View 2: Monorepo Architecture");
      expect(view.badge.text).toBe("Monorepo & CI");
      expect(view.groups.length).toBeGreaterThanOrEqual(2);
      expect(view.groups.map((g) => g.id)).toContain("grp-monorepo");
    });

    it("includes @ahkms/core absorbing shared, MCP, worker, web (ADR-100), and CI guards", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      expect(nodeIds).toContain("node-core");
      expect(nodeIds).toContain("node-mcp");
      expect(nodeIds).toContain("node-worker");
      expect(nodeIds).toContain("node-web");
      expect(nodeIds).toContain("node-mobile");
      expect(nodeIds).toContain("node-guards");
      expect(nodeIds).toContain("node-turbo");
      expect(nodeIds).toContain("node-workflows");
      expect(nodeIds).toContain("node-migrations");

      const webNode = view.nodes.find((n) => n.id === "node-web");
      expect(webNode?.variant).toBe("primary");
      expect(webNode?.details?.adrOrIssue).toBe("ADR-100");
    });

    it("has complete sequential step sequence [1] through [5]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("View 3: Modular Toolpacks & Target Evolution Roadmap (repo-vision)", () => {
    const view = ARCHITECTURE_VIEWS["repo-vision"];

    it("includes modular connector packages, domain kernel, and verification gates", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      expect(nodeIds).toContain("node-core-engine");
      expect(nodeIds).toContain("node-core-schemas");
      expect(nodeIds).toContain("node-gateway-http");
      expect(nodeIds).toContain("node-mcp-adapter");
      expect(nodeIds).toContain("node-conn-google");
      expect(nodeIds).toContain("node-conn-crm");
      expect(nodeIds).toContain("node-conn-graph");
      expect(nodeIds).toContain("node-conn-synth");
      expect(nodeIds).toContain("node-cli-web");
      expect(nodeIds).toContain("node-cli-mobile");
      expect(nodeIds).toContain("node-gate-db");
      expect(nodeIds).toContain("node-gate-rdf");
    });

    it("has step sequence [1] through [5]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("View 0: System Context & Landscape (infra-current)", () => {
    const view = ARCHITECTURE_VIEWS["infra-current"];

    it("maps Railway services, Supabase platform, SaaS of record, and operator clients", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      expect(nodeIds).toContain("node-claude-client");
      expect(nodeIds).toContain("node-antigravity");
      expect(nodeIds).toContain("node-web-client");
      expect(nodeIds).toContain("node-mobile-client");
      expect(nodeIds).toContain("node-railway-mcp");
      expect(nodeIds).toContain("node-railway-worker");
      expect(nodeIds).toContain("node-supabase-db");
      expect(nodeIds).toContain("node-supabase-storage");
      expect(nodeIds).toContain("node-supabase-auth");
      expect(nodeIds).toContain("node-external-saas");
      expect(nodeIds).toContain("node-l3-matrix");

      const l3Node = view.nodes.find((n) => n.id === "node-l3-matrix");
      expect(l3Node?.details?.adrOrIssue).toContain("ADR-091");
    });

    it("has complete sequential step sequence [1] through [5]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("View 1: Runtime & Capability Topology (infra-vision)", () => {
    const view = ARCHITECTURE_VIEWS["infra-vision"];

    it("includes canonical Hexagonal ports, Central Action Registry, and secondary systems", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      expect(nodeIds).toContain("node-human-op");
      expect(nodeIds).toContain("node-ai-agent");
      expect(nodeIds).toContain("node-sched-actors");
      expect(nodeIds).toContain("node-port-http");
      expect(nodeIds).toContain("node-port-mcp");
      expect(nodeIds).toContain("node-port-sched");
      expect(nodeIds).toContain("node-hexagon-core");
      expect(nodeIds).toContain("node-port-db");
      expect(nodeIds).toContain("node-port-ext");
      expect(nodeIds).toContain("node-sys-db");
      expect(nodeIds).toContain("node-sys-notion");
      expect(nodeIds).toContain("node-sys-google");
    });

    it("has complete sequential step sequence [1] through [5]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("View 5: Database Schema ERD (Simplified Conceptual Model) (db-current)", () => {
    const view = ARCHITECTURE_VIEWS["db-current"];

    it("maps core conceptual tables: artifacts, derived, links, entities, relationships, tasks, events, preferences", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      expect(nodeIds).toContain("tbl-artifacts");
      expect(nodeIds).toContain("tbl-derived-artifacts");
      expect(nodeIds).toContain("tbl-external-links");
      expect(nodeIds).toContain("tbl-entities");
      expect(nodeIds).toContain("tbl-entity-rel");
      expect(nodeIds).toContain("tbl-art-entity-links");
      expect(nodeIds).toContain("tbl-user-tasks");
      expect(nodeIds).toContain("tbl-events");
      expect(nodeIds).toContain("tbl-user-edits");
      expect(nodeIds).toContain("tbl-preferences");
      expect(nodeIds).toContain("tbl-integrations");
      expect(nodeIds).toContain("tbl-bindings");
    });

    it("has sequential step sequence [1] through [5]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("View 6: Database Schema ERD (Actual PostgreSQL Storage Substrate) (db-vision)", () => {
    const view = ARCHITECTURE_VIEWS["db-vision"];

    it("maps physical 35-table PostgreSQL schema: artifacts, derived, graph, workflows, multi-tenancy, schedulers", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      expect(nodeIds).toContain("node-tbl-artifacts");
      expect(nodeIds).toContain("node-tbl-derived");
      expect(nodeIds).toContain("node-tbl-ext-links");
      expect(nodeIds).toContain("node-tbl-art-edit-log");
      expect(nodeIds).toContain("node-tbl-entities");
      expect(nodeIds).toContain("node-tbl-entity-rel");
      expect(nodeIds).toContain("node-tbl-art-ent-links");
      expect(nodeIds).toContain("node-tbl-bindings");
      expect(nodeIds).toContain("node-tbl-workflows");
      expect(nodeIds).toContain("node-tbl-steps");
      expect(nodeIds).toContain("node-tbl-training");
      expect(nodeIds).toContain("node-tbl-decisions");
      expect(nodeIds).toContain("node-tbl-teams-users");
      expect(nodeIds).toContain("node-tbl-preferences");
      expect(nodeIds).toContain("node-tbl-integrations");
      expect(nodeIds).toContain("node-tbl-schedulers");
    });

    it("has sequential step sequence [1] through [4]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4]);
    });
  });

  describe("View 4: Execution & Data Lifecycle Flow (gitdiagram)", () => {
    const view = ARCHITECTURE_VIEWS["gitdiagram"];

    it("includes exact execution lifecycle metadata and raw mermaid source", () => {
      expect(view.title).toContain("View 4: Execution & Data Lifecycle Flow");
      expect(view.badge.text).toBe("Operational Lifecycles");
      expect(view.rawMermaid).toBeDefined();
      expect(view.rawMermaid).toContain("flowchart TD");
      expect(view.rawMermaid).toContain("Pathway 1: Direct Capture & Vectorization");
    });

    it("includes all 4 operational pathways and knowledge substrate nodes", () => {
      const nodeIds = view.nodes.map((n) => n.id);
      // Pathway 1
      expect(nodeIds).toContain("node_op_capture");
      expect(nodeIds).toContain("node_act_capture");
      expect(nodeIds).toContain("node_vec_embed");
      // Pathway 2
      expect(nodeIds).toContain("node_sched");
      expect(nodeIds).toContain("node_discover");
      expect(nodeIds).toContain("node_enrich");
      // Pathway 3
      expect(nodeIds).toContain("node_dos_queue");
      expect(nodeIds).toContain("node_dos_confirm");
      expect(nodeIds).toContain("node_daily_twin");
      expect(nodeIds).toContain("node_state_update");
      // Substrate
      expect(nodeIds).toContain("node_artifacts");
      expect(nodeIds).toContain("node_ext_links");
      expect(nodeIds).toContain("node_entities");
      // Pathway 4
      expect(nodeIds).toContain("node_search");
      expect(nodeIds).toContain("node_fused_rerank");
      expect(nodeIds).toContain("node_ctx_assemble");
    });

    it("has sequential step sequence [1] through [6]", () => {
      const steps = view.stepBreakdown.map((s) => s.step);
      expect(steps).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("Component Data Integrity Across All Views", () => {
    it("ensures all nodes have valid dimensions, positions, and titles", () => {
      for (const viewId of VIEW_ORDER) {
        const view = ARCHITECTURE_VIEWS[viewId];
        for (const node of view.nodes) {
          expect(node.id).toBeDefined();
          expect(node.title).toBeTruthy();
          expect(node.width).toBeGreaterThan(0);
          expect(node.height).toBeGreaterThan(0);
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.y).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("ensures all groups have valid coordinates within the viewBox", () => {
      for (const viewId of VIEW_ORDER) {
        const view = ARCHITECTURE_VIEWS[viewId];
        for (const group of view.groups) {
          expect(group.id).toBeDefined();
          expect(group.title).toBeTruthy();
          expect(group.width).toBeGreaterThan(0);
          expect(group.height).toBeGreaterThan(0);
        }
      }
    });

    it("ensures all lines have SVG path syntax", () => {
      for (const viewId of VIEW_ORDER) {
        const view = ARCHITECTURE_VIEWS[viewId];
        for (const line of view.lines) {
          expect(line.id).toBeDefined();
          expect(line.path).toMatch(/^M\s+\d+/);
        }
      }
    });
  });

  describe("Component Rendering", () => {
    it("renders VisualMeaningCanvas and ArchitectureView without errors", async () => {
      const React = (await import("react")).default;
      const { renderToString } = await import("react-dom/server");
      const { VisualMeaningCanvas } = await import("../components/visual-meaning/VisualMeaningCanvas.js");
      const { ArchitectureView } = await import("../components/visual-meaning/ArchitectureView.js");

      const canvasHtml = renderToString(React.createElement(VisualMeaningCanvas));
      expect(canvasHtml).toContain("Visual Meaning");
      expect(canvasHtml).toContain("7 views");
      expect(canvasHtml).toContain("Current State");
      expect(canvasHtml).toContain("Target Roadmap");
      expect(canvasHtml).toContain('data-testid="group-container-current"');
      expect(canvasHtml).toContain('data-testid="group-container-future"');
      expect(canvasHtml).toContain('data-testid="tab-repo-current"');
      expect(canvasHtml).toContain('data-testid="tab-infra-current"');
      expect(canvasHtml).toContain('data-testid="tab-db-current"');
      expect(canvasHtml).toContain('data-testid="tab-gitdiagram"');
      expect(canvasHtml).toContain('data-testid="tab-repo-vision"');
      expect(canvasHtml).toContain('data-testid="tab-infra-vision"');
      expect(canvasHtml).toContain('data-testid="tab-db-vision"');
      expect(canvasHtml).toContain("<svg");

      for (const viewId of VIEW_ORDER) {
        const view = ARCHITECTURE_VIEWS[viewId];
        const viewHtml = renderToString(React.createElement(ArchitectureView, { view }));
        expect(viewHtml).toContain("<svg");
        expect(viewHtml).toContain(`data-testid="node-${view.nodes[0].id}"`);
        expect(viewHtml).toContain(`data-testid="group-${view.groups[0].id}"`);
      }
    });

    it("renders consolidated perspectives and live observation mode controls", async () => {
      const React = (await import("react")).default;
      const { renderToString } = await import("react-dom/server");
      const { VisualMeaningCanvas } = await import("../components/visual-meaning/VisualMeaningCanvas.js");

      const canvasHtml = renderToString(React.createElement(VisualMeaningCanvas));
      expect(canvasHtml).toContain("Observation Panel");
      expect(canvasHtml).toContain('data-testid="toggle-observation-mode"');
      expect(canvasHtml).toContain('data-testid="button-probe-all"');
      expect(canvasHtml).toContain('data-testid="perspective-infra"');
      expect(canvasHtml).toContain('data-testid="perspective-repo"');
      expect(canvasHtml).toContain('data-testid="perspective-db"');
      expect(canvasHtml).toContain('data-testid="perspective-flow"');
      expect(canvasHtml).toContain('data-testid="horizon-current"');
      expect(canvasHtml).toContain('data-testid="horizon-future"');
    });

    it("renders live telemetry badges on ArchitectureNodes when observation mode is active", async () => {
      const React = (await import("react")).default;
      const { renderToString } = await import("react-dom/server");
      const { ArchitectureView } = await import("../components/visual-meaning/ArchitectureView.js");
      const view = ARCHITECTURE_VIEWS["infra-current"];

      const mockTelemetry = {
        "node-railway-mcp": {
          status: "healthy" as const,
          statusText: "Online",
          latencyMs: 14,
          metricLabel: "Tools",
          metricValue: "30+ registered",
        },
      };

      const viewHtml = renderToString(
        React.createElement(ArchitectureView, {
          view,
          isObservationMode: true,
          telemetryMap: mockTelemetry,
        })
      );

      expect(viewHtml).toContain('data-testid="node-telemetry-node-railway-mcp"');
      expect(viewHtml).toContain("14ms");
    });
  });
});
