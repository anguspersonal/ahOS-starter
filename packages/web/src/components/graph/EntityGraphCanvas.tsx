import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { GraphEdge, GraphNode, GraphSpecialisedView, GraphPhysicsConfig } from "./types.js";
import { fetchGraphData, isSelfNode } from "./graphData.js";
import { stepSimulation, type ConcentricConstraint } from "./forceSimulation.js";
import { EntityInspector, getTypeBadgeColor } from "./EntityInspector.js";
import {
  PhysicsControlsPopover,
  DEFAULT_PHYSICS_CONFIG,
} from "./PhysicsControlsPopover.js";
import { NodeContextMenu } from "./NodeContextMenu.js";
import { MiniChatWidget } from "../chat/MiniChatWidget.js";
import { registerGraphFilterListener } from "../../lib/graphActions.js";
import { defaultClientActionRegistry } from "../../lib/actionRegistry.js";
import { registerGraphEntitySelectionListener, setGraphScreen } from "../../lib/screenState.js";
import { buildHierarchy, applyHierarchyGrouping } from "./hierarchy.js";

import { isTBoxEntity, formatTypeLabel, TBOX_TYPE } from "./tbox.js";
import {
  NETWORK_RINGS,
  applyConcentricNetworkLayout,
  getNetworkRingDefinition,
  isPersonEntity,
  resolveNodeClosenessRing,
  getNetworkRingCounts,
} from "./networkView.js";
import { useTheme } from "../../lib/theme.js";


const DEFAULT_VIEWPORT_WIDTH = 1200;
const DEFAULT_VIEWPORT_HEIGHT = 680;

/**
 * Scale thresholds for the 14 Level of Detail (LOD) zoom levels.
 * Level 1 begins at <= 0.40x (apex macro view), scaling progressively up to Level 14 at >= 2.50x.
 */
export const ZOOM_SCALE_THRESHOLDS = [
  0.40, // Level 1 (apex)
  0.45, // Level 2
  0.50, // Level 3
  0.58, // Level 4
  0.68, // Level 5
  0.80, // Level 6
  0.95, // Level 7
  1.15, // Level 8
  1.35, // Level 9
  1.60, // Level 10
  1.90, // Level 11
  2.20, // Level 12
  2.40, // Level 13
  2.50, // Level 14 (substrate)
];

/**
 * Maps continuous zoom scale [0.4, 2.5] to a discrete zoom level integer [1..14]
 */
export function computeDiscreteZoomLevel(zoom: number): number {
  for (let i = ZOOM_SCALE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (zoom >= ZOOM_SCALE_THRESHOLDS[i]) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * Formats node labels: truncates to ~60px single line when not selected/hovered (doubling previous ~30px width),
 * and preserves full title when selected or hovered.
 */
export function formatNodeLabel(title: string, isExpanded: boolean): string {
  if (isExpanded) return title;
  return title.length > 9 ? `${title.slice(0, 8)}…` : title;
}

export type DetailStrategy = "tiered" | "clusters" | "landmarks";
export type ScopeTier = "pillars" | "core" | "standard" | "all";

export interface ClusterGroup {
  key: string;
  label: string;
  color: string;
  nodes: GraphNode[];
  centerX: number;
  centerY: number;
  radius: number;
  isCollapsed: boolean;
}

export function resolveNodeClusterKey(node: GraphNode): string {
  if (node.domain_override && node.domain_override.trim()) {
    return node.domain_override.trim().toLowerCase();
  }
  const domainTag = node.tags?.find((t) =>
    ["work", "tech", "personal", "health", "finance", "wedding", "ahos"].includes(t.toLowerCase())
  );
  if (domainTag) return domainTag.toLowerCase();
  return (node.entity_type || "other").toLowerCase();
}

export const CLUSTER_COLOR_PALETTE: Record<string, string> = {
  angus: "#6366f1",
  work: "#3b82f6",
  tech: "#06b6d4",
  personal: "#10b981",
  ahos: "#8b5cf6",
  project: "#f59e0b",
  people: "#6366f1",
  area: "#14b8a6",
  concept: "#a855f7",
  capability: "#38bdf8",
  "t-box": "#eab308",
  tbox: "#eab308",
  other: "#64748b",
};

export function getClusterColor(key: string): string {
  return CLUSTER_COLOR_PALETTE[key] || "#6366f1";
}

/**
 * Computes the outer radius for a collapsed cluster macro-bubble,
 * scaling gracefully based on the number of contained entities.
 */
export function getClusterMacroRadius(nodesCount: number): number {
  return Math.min(64, Math.max(46, 44 + Math.log2(Math.max(1, nodesCount)) * 2.5));
}

/**
 * Resolves overlaps between cluster bubbles (both collapsed macro-bubbles and expanded boundary envelopes)
 * using an iterative collision relaxation constraint solver.
 * Ensures that no two cluster bubbles overlap.
 */
export function relaxClusterPositions(
  clusters: ClusterGroup[],
  pinnedKey?: string
): ClusterGroup[] {
  if (clusters.length <= 1) return clusters;

  const relaxed: ClusterGroup[] = clusters.map((c) => ({ ...c }));

  const getCollisionRadius = (c: ClusterGroup) => {
    if (c.isCollapsed) {
      return getClusterMacroRadius(c.nodes.length) + 16;
    }
    return c.radius + 20;
  };

  const collisionRadii = relaxed.map(getCollisionRadius);
  const MIN_MARGIN = 24;

  let gcx = 0;
  let gcy = 0;
  for (const c of relaxed) {
    gcx += c.centerX;
    gcy += c.centerY;
  }
  gcx /= relaxed.length;
  gcy /= relaxed.length;

  for (let iter = 0; iter < 60; iter++) {
    let hadCollision = false;

    for (let i = 0; i < relaxed.length; i++) {
      for (let j = i + 1; j < relaxed.length; j++) {
        const c1 = relaxed[i];
        const c2 = relaxed[j];

        // If both are expanded, skip (constituent nodes repel in the main physics simulation)
        if (!c1.isCollapsed && !c2.isCollapsed) continue;

        const r1 = collisionRadii[i];
        const r2 = collisionRadii[j];
        const minDistance = r1 + r2 + MIN_MARGIN;

        let dx = c2.centerX - c1.centerX;
        let dy = c2.centerY - c1.centerY;
        let dist = Math.hypot(dx, dy);

        if (dist < minDistance) {
          hadCollision = true;

          // Break symmetry deterministically if centers coincide
          if (dist < 1) {
            const angle = ((i * 3 + j * 7) * 2 * Math.PI) / relaxed.length;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            dist = 1;
          }

          const overlap = minDistance - dist;
          const ux = dx / dist;
          const uy = dy / dist;

          let w1 = 0.5;
          let w2 = 0.5;

          const isPinned1 = c1.key === pinnedKey;
          const isPinned2 = c2.key === pinnedKey;

          if (isPinned1 && !isPinned2) {
            w1 = 0;
            w2 = 1;
          } else if (isPinned2 && !isPinned1) {
            w1 = 1;
            w2 = 0;
          } else if (!c1.isCollapsed && c2.isCollapsed) {
            // Expanded cluster stays anchored to its simulated nodes; collapsed macro-bubble yields
            w1 = 0;
            w2 = 1;
          } else if (!c2.isCollapsed && c1.isCollapsed) {
            w1 = 1;
            w2 = 0;
          } else {
            const totalRadius = r1 + r2;
            w1 = r2 / totalRadius;
            w2 = r1 / totalRadius;
          }

          const step = overlap * 0.55;
          c1.centerX -= ux * step * w1;
          c1.centerY -= uy * step * w1;
          c2.centerX += ux * step * w2;
          c2.centerY += uy * step * w2;
        }
      }
    }

    // Soft centering force on collapsed bubbles to keep cluster bouquet centered
    for (let i = 0; i < relaxed.length; i++) {
      const c = relaxed[i];
      if (c.isCollapsed && c.key !== pinnedKey) {
        c.centerX += (gcx - c.centerX) * 0.005;
        c.centerY += (gcy - c.centerY) * 0.005;
      }
    }

    if (!hadCollision) break;
  }

  return relaxed;
}

export function EntityGraphCanvas() {
  const { theme } = useTheme();
  const isNight = theme === "night";

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  // Selection & Hover
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [isIsolated, setIsIsolated] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [isMiniChatOpen, setIsMiniChatOpen] = useState(false);

  // Right-click node context menu state
  const [contextMenu, setContextMenu] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const [pinnedNodeIds, setPinnedNodeIds] = useState<Set<string>>(new Set());

  // Level of Detail (LOD) zoom visibility mode ("auto" | "show_all")
  const [lodMode, setLodMode] = useState<"auto" | "show_all">("auto");

  // Detail presentation strategy: "tiered" | "clusters" | "landmarks"
  const [detailStrategy, setDetailStrategy] = useState<DetailStrategy>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlStrat = params.get("detail_strategy");
      if (urlStrat === "tiered" || urlStrat === "clusters" || urlStrat === "landmarks") return urlStrat;
      const saved = localStorage.getItem("ahos_graph_detail_strategy");
      if (saved === "tiered" || saved === "clusters" || saved === "landmarks") return saved;
    }
    return "tiered";
  });

  // Active scope tier in "tiered" strategy: "pillars" | "core" | "standard" | "all"
  const [scopeTier, setScopeTier] = useState<ScopeTier>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlTier = params.get("scope_tier");
      if (urlTier === "pillars" || urlTier === "core" || urlTier === "standard" || urlTier === "all") return urlTier;
      const saved = localStorage.getItem("ahos_graph_scope_tier");
      if (saved === "pillars" || saved === "core" || saved === "standard" || saved === "all") return saved;
    }
    return "standard";
  });

  // Collapsed cluster keys in "clusters" strategy
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());

  // Container measurement for dynamic widescreen space
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: typeof window !== "undefined" ? Math.max(window.innerWidth - 380, 1100) : DEFAULT_VIEWPORT_WIDTH,
    height: DEFAULT_VIEWPORT_HEIGHT,
  });

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  // Top level "Include me" toggle (self node: Angus Hally) - persists to localStorage, defaults to true
  const [includeMe, setIncludeMe] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("ahos_graph_include_me");
      if (saved !== null) return saved === "true";
    }
    return true;
  });

  const handleToggleIncludeMe = useCallback(() => {
    setIncludeMe((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("ahos_graph_include_me", String(next));
      }
      if (!next && selectedNode && isSelfNode(selectedNode)) {
        setSelectedNode(null);
      }
      return next;
    });
  }, [selectedNode]);

  // Dynamic hierarchy grouping state (null = All levels expanded)
  const [hierarchyLevel, setHierarchyLevel] = useState<number | null>(null);

  // Multi-select type dropdown popover state
  const [isTypePickerOpen, setIsTypePickerOpen] = useState(false);
  const typePickerRef = useRef<HTMLDivElement | null>(null);

  // Specialised Views state ("default" | "network")
  const [activeView, setActiveView] = useState<GraphSpecialisedView>("default");
  // Specific network ring filter (null = all 7 concentric rings)
  const [selectedRingFilter, setSelectedRingFilter] = useState<number | null>(null);

  // Viewport Pan & Zoom
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });


  // Physics simulation
  const [isPaused, setIsPaused] = useState(false);
  const [isPhysicsOpen, setIsPhysicsOpen] = useState(false);
  const [physicsConfig, setPhysicsConfig] = useState<GraphPhysicsConfig>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("ahos_graph_physics_config");
        if (saved) {
          const parsed = JSON.parse(saved);
          return { ...DEFAULT_PHYSICS_CONFIG, ...parsed };
        }
      } catch {
        // fallback to default
      }
    }
    return DEFAULT_PHYSICS_CONFIG;
  });

  const handleUpdatePhysics = useCallback((updates: Partial<GraphPhysicsConfig>) => {
    setPhysicsConfig((prev) => {
      const next = { ...prev, ...updates };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("ahos_graph_physics_config", JSON.stringify(next));
        } catch {
          // ignore
        }
      }
      return next;
    });
    // Wake up physics simulation
    alphaRef.current = Math.max(alphaRef.current, 0.45);
    setIsPaused(false);
  }, []);

  const handleResetPhysics = useCallback(() => {
    setPhysicsConfig(DEFAULT_PHYSICS_CONFIG);
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem("ahos_graph_physics_config");
      } catch {
        // ignore
      }
    }
    alphaRef.current = 0.85;
    setIsPaused(false);
  }, []);

  const handleReheatSimulation = useCallback(() => {
    alphaRef.current = 1.0;
    setIsPaused(false);
  }, []);

  const alphaRef = useRef(1.0);
  const animationFrameRef = useRef<number | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  // Drag states
  const draggedNodeRef = useRef<GraphNode | null>(null);
  const draggedClusterRef = useRef<{
    clusterKey: string;
    initX: number;
    initY: number;
    startX: number;
    startY: number;
    hasDragged: boolean;
  } | null>(null);
  const clusterPositionOverridesRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const isPanningRef = useRef<{ isPanning: boolean; startX: number; startY: number; initPanX: number; initPanY: number }>({
    isPanning: false,
    startX: 0,
    startY: 0,
    initPanX: 0,
    initPanY: 0,
  });

  const svgRef = useRef<SVGSVGElement | null>(null);

  // Persistent coordinate and velocity cache to preserve in-flight simulation state across re-renders and filter changes
  const nodePositionCacheRef = useRef<
    Map<string, { x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null }>
  >(new Map());

  const syncNodePositions = useCallback((nodeList: GraphNode[]) => {
    for (const node of nodeList) {
      const cached = nodePositionCacheRef.current.get(node.id);
      if (cached) {
        node.x = cached.x;
        node.y = cached.y;
        node.vx = cached.vx;
        node.vy = cached.vy;
        if (cached.fx !== undefined) node.fx = cached.fx;
        if (cached.fy !== undefined) node.fy = cached.fy;
      }
    }
    return nodeList;
  }, []);

  // Dynamic ResizeObserver to maximize canvas across available horizontal space
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth > 250 && clientHeight > 250) {
        setViewportSize((prev) => {
          if (Math.abs(prev.width - clientWidth) < 8 && Math.abs(prev.height - clientHeight) < 8) {
            return prev;
          }
          return { width: clientWidth, height: clientHeight };
        });
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isInspectorOpen]);

  // Keep module screenState synchronized with current graph view, live state, selection and filters (ADR-100 §2)
  useEffect(() => {
    setGraphScreen({
      view: activeView,
      live: isLive,
      selected_entity: selectedNode
        ? {
            id: selectedNode.id,
            title: selectedNode.title,
            entity_type: selectedNode.entity_type,
          }
        : null,
      selected_edge: selectedEdge
        ? {
            id: selectedEdge.id,
            from_entity_id: selectedEdge.from_entity_id,
            to_entity_id: selectedEdge.to_entity_id,
            relationship_type: selectedEdge.relationship_type,
          }
        : null,
      filters: {
        query: searchQuery,
        entity_types: Array.from(selectedTypes),
        hierarchy_level: hierarchyLevel,
        show_archived: showArchived,
        include_me: includeMe,
        scope_tier: scopeTier,
        detail_strategy: detailStrategy,
        lod_mode: lodMode,
        isolated: isIsolated,
      },
    });

    return () => {
      setGraphScreen(null);
    };
  }, [
    activeView,
    isLive,
    selectedNode,
    selectedEdge,
    searchQuery,
    selectedTypes,
    hierarchyLevel,
    showArchived,
    includeMe,
    scopeTier,
    detailStrategy,
    lodMode,
    isIsolated,
  ]);

  // Click outside listener for the multi-select entity type picker popover
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (typePickerRef.current && !typePickerRef.current.contains(event.target as Node)) {
        setIsTypePickerOpen(false);
      }
    }
    if (isTypePickerOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isTypePickerOpen]);

  // Subscribe to Centralised Action Registry (CAR) graph_filter actions
  useEffect(() => {
    const unsubscribe = registerGraphFilterListener((filter) => {
      if (filter.reset) {
        setSearchQuery("");
        setSelectedTypes(new Set());
        setShowArchived(false);
        setHierarchyLevel(null);
        setLodMode("auto");
        setDetailStrategy("tiered");
        setScopeTier("standard");
        setCollapsedClusters(new Set());
        setIncludeMe(true);
        handleResetPhysics();
      } else {
        if (filter.query !== undefined) {
          setSearchQuery(filter.query);
        }
        if (filter.entity_types !== undefined) {
          setSelectedTypes(new Set(filter.entity_types));
        } else if (filter.entity_type !== undefined) {
          setSelectedTypes(new Set([filter.entity_type]));
        }
        if (filter.hierarchy_level !== undefined) {
          setHierarchyLevel(filter.hierarchy_level);
        }
        if (filter.show_archived !== undefined) {
          setShowArchived(filter.show_archived);
        }
        if (filter.lod_mode !== undefined) {
          setLodMode(filter.lod_mode);
        }
        if (filter.detail_strategy !== undefined) {
          setDetailStrategy(filter.detail_strategy);
        }
        if (filter.scope_tier !== undefined) {
          setScopeTier(filter.scope_tier);
        }
        if (filter.include_me !== undefined) {
          setIncludeMe(filter.include_me);
        }
        if (filter.physics !== undefined) {
          handleUpdatePhysics(filter.physics);
        }
      }
    });
    return unsubscribe;
  }, [handleResetPhysics, handleUpdatePhysics]);

  // Load data
  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const w = containerRef.current?.clientWidth || viewportSize.width || DEFAULT_VIEWPORT_WIDTH;
      const h = containerRef.current?.clientHeight || viewportSize.height || DEFAULT_VIEWPORT_HEIGHT;
      const data = await fetchGraphData(w, h);
      nodePositionCacheRef.current.clear();
      setNodes(data.nodes);
      setEdges(data.edges);
      setIsLive(data.isLive);
      alphaRef.current = 1.0;
      setRenderTick((c) => (c + 1) % 1000000);
    } finally {
      setIsLoading(false);
    }
  }, [viewportSize.width, viewportSize.height]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Subscribe to graph entity selection requests (e.g. from navigate({ tab: "graph", entity_id }))
  useEffect(() => {
    return registerGraphEntitySelectionListener((entityId) => {
      const targetNode = nodes.find((n) => n.id === entityId);
      if (!targetNode) {
        return false;
      }
      setContextMenu(null);
      setSelectedNode(targetNode);
      setSelectedEdge(null);
      setIsInspectorOpen(true);
      return true;
    });
  }, [nodes]);


  // Handle select node
  const handleSelectNode = (node: GraphNode | null) => {
    setContextMenu(null);
    setSelectedNode(node);
    setSelectedEdge(null);
    if (!isInspectorOpen && node) {
      setIsInspectorOpen(true);
    }
  };

  // Handle select edge
  const handleSelectEdge = (edge: GraphEdge | null) => {
    setContextMenu(null);
    setSelectedEdge(edge);
    setSelectedNode(null);
    if (!isInspectorOpen && edge) {
      setIsInspectorOpen(true);
    }
  };

  // Switch specialised view
  const handleSwitchView = useCallback(
    (view: GraphSpecialisedView) => {
      setContextMenu(null);
      if (view === activeView) return;
      setActiveView(view);
      setSelectedRingFilter(null);
      if (view === "network") {
        const centerX = viewportSize.width / 2;
        const centerY = viewportSize.height / 2;
        applyConcentricNetworkLayout(nodes, { x: centerX, y: centerY });
        alphaRef.current = 0.6;
        setPan({ x: 0, y: 0 });
        setZoom(0.85);
      } else {
        alphaRef.current = 0.8;
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
      setRenderTick((c) => (c + 1) % 1000000);
    },
    [activeView, nodes, viewportSize.width, viewportSize.height]
  );

  // Reset zoom & pan to default centered framing
  const handleResetView = () => {
    setContextMenu(null);
    setPan({ x: 0, y: 0 });
    setZoom(activeView === "network" ? 0.85 : 1);
    alphaRef.current = 0.8;
    setRenderTick((c) => (c + 1) % 1000000);
  };


  // Zoom buttons (+ / -)
  const handleZoom = (delta: number) => {
    setContextMenu(null);
    setZoom((prev) => {
      const next = Math.max(0.2, Math.min(3.5, prev + delta));
      return Number(next.toFixed(2));
    });
  };

  // Active discrete zoom level (1..14) derived from continuous canvas scale
  const activeZoomLevel = useMemo(() => {
    return computeDiscreteZoomLevel(zoom);
  }, [zoom]);

  // Update entity zoom level (stored in properties.zoom_level)
  const handleUpdateZoomLevel = useCallback(
    async (nodeId: string, zoomLevel: number) => {
      const clampedLevel = Math.min(Math.max(Math.round(zoomLevel), 1), 14);

      // 1. Optimistically update local nodes state
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id === nodeId) {
            const updatedProps = {
              ...(n.properties || {}),
              zoom_level: clampedLevel,
            };
            return {
              ...n,
              zoom_level: clampedLevel,
              properties: updatedProps,
            };
          }
          return n;
        })
      );

      // 2. Also update selectedNode reference if matching
      setSelectedNode((prev) => {
        if (prev && prev.id === nodeId) {
          return {
            ...prev,
            zoom_level: clampedLevel,
            properties: {
              ...(prev.properties || {}),
              zoom_level: clampedLevel,
            },
          };
        }
        return prev;
      });

      // 3. Persist update via Centralised Action Registry (CAR)
      try {
        await defaultClientActionRegistry.execute("graph_node_level", {
          id: nodeId,
          direction: "set",
          target_level: clampedLevel,
        });
      } catch (err) {
        console.warn("Could not persist entity zoom_level via CAR:", err);
      }
    },
    [],
  );

  // Toggle T-box classification (stored in properties.in_box per ADR-036 §1)
  const handleToggleTBox = useCallback(
    async (nodeId: string, isTBox: boolean) => {
      let nextProps: Record<string, unknown> = {};

      // 1. Optimistically update local nodes state
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id === nodeId) {
            const currentProps = { ...(n.properties || {}) };
            if (isTBox) {
              currentProps.in_box = "TBox";
              currentProps.level = currentProps.level || "ontology";
            } else {
              delete currentProps.in_box;
              delete currentProps.inBox;
              delete currentProps.box;
              delete currentProps.box_type;
              delete currentProps.tbox;
              delete currentProps.is_tbox;
              delete currentProps.is_t_box;
              delete currentProps.t_box;
              delete currentProps["T-box"];
              delete currentProps["t-box"];
            }
            nextProps = currentProps;
            return {
              ...n,
              properties: currentProps,
            };
          }
          return n;
        })
      );

      // 2. Also update selectedNode reference if matching
      setSelectedNode((prev) => {
        if (prev && prev.id === nodeId) {
          return {
            ...prev,
            properties: nextProps,
          };
        }
        return prev;
      });

      // 3. Persist update via Centralised Action Registry (CAR)
      try {
        await defaultClientActionRegistry.execute("entity_crud", {
          operation: "update",
          id: nodeId,
          patch: {
            properties: nextProps,
          },
        });
      } catch (err) {
        console.warn("Could not persist entity T-box property:", err);
      }
    },
    [],
  );

  // Update Network Closeness Ring (stored in properties.closeness_ring)
  const handleUpdateClosenessRing = useCallback(
    async (nodeId: string, ring: number) => {
      const clampedRing = Math.min(Math.max(Math.round(ring), 1), 7);
      let nextProps: Record<string, unknown> = {};

      // 1. Optimistically update local nodes state
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id === nodeId) {
            const currentProps = { ...(n.properties || {}), closeness_ring: clampedRing };
            nextProps = currentProps;
            return {
              ...n,
              closeness_ring: clampedRing,
              properties: currentProps,
            };
          }
          return n;
        })
      );

      // 2. Also update selectedNode reference if matching
      setSelectedNode((prev) => {
        if (prev && prev.id === nodeId) {
          return {
            ...prev,
            closeness_ring: clampedRing,
            properties: { ...(prev.properties || {}), closeness_ring: clampedRing },
          };
        }
        return prev;
      });

      // 3. Kick simulation so node animates smoothly to new orbit
      alphaRef.current = 0.5;

      // 4. Persist update via CAR if live
      try {
        await defaultClientActionRegistry.execute("entity_crud", {
          operation: "update",
          id: nodeId,
          patch: {
            properties: nextProps,
          },
        });
      } catch (err) {
        console.warn("Could not persist entity closeness_ring property:", err);
      }
    },
    []
  );

  // Handle relationship edge created via CAR
  const handleRelationshipCreated = useCallback((newEdge: GraphEdge) => {
    setEdges((prev) => [newEdge, ...prev.filter((e) => e.id !== newEdge.id)]);
  }, []);

  // Handle relationship edge deleted via CAR
  const handleRelationshipDeleted = useCallback((edgeId: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
    setSelectedEdge((prev) => (prev?.id === edgeId ? null : prev));
  }, []);

  // Right-click context menu handler for graph nodes
  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: GraphNode) => {
      e.preventDefault();
      e.stopPropagation();

      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();

      const rawX = e.clientX - containerRect.left;
      const rawY = e.clientY - containerRect.top;

      // Menu estimated dimensions: ~260px wide, ~440px high
      const menuWidth = 260;
      const menuHeight = 440;

      const clampedX = Math.max(10, Math.min(containerRect.width - menuWidth - 10, rawX));
      const clampedY = Math.max(10, Math.min(containerRect.height - menuHeight - 10, rawY));

      setContextMenu({
        node,
        x: clampedX,
        y: clampedY,
      });
    },
    []
  );

  // Center camera directly on a node
  const handleCenterOnNode = useCallback(
    (node: GraphNode) => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth || viewportSize.width || DEFAULT_VIEWPORT_WIDTH;
      const h = containerRef.current.clientHeight || viewportSize.height || DEFAULT_VIEWPORT_HEIGHT;

      const targetZoom = Math.max(zoom, 1.0);
      const targetPanX = w / 2 - node.x * targetZoom;
      const targetPanY = h / 2 - node.y * targetZoom;

      setZoom(targetZoom);
      setPan({ x: targetPanX, y: targetPanY });
      setRenderTick((c) => (c + 1) % 1000000);
    },
    [viewportSize.width, viewportSize.height, zoom]
  );

  // Toggle pinning a node at its current position
  const handleTogglePinNode = useCallback((node: GraphNode) => {
    setPinnedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
        node.fx = null;
        node.fy = null;
        alphaRef.current = Math.max(alphaRef.current, 0.35);
      } else {
        next.add(node.id);
        node.fx = node.x;
        node.fy = node.y;
      }
      return next;
    });
    setRenderTick((c) => (c + 1) % 1000000);
  }, []);

  // Toggle Hot priority on an entity
  const handleToggleHot = useCallback(async (node: GraphNode) => {
    const nextHot = !node.hot;
    setNodes((prev) =>
      prev.map((n) => (n.id === node.id ? { ...n, hot: nextHot } : n))
    );
    setSelectedNode((prev) => (prev && prev.id === node.id ? { ...prev, hot: nextHot } : prev));

    try {
      await defaultClientActionRegistry.execute("entity_crud", {
        op: "update",
        id: node.id,
        patch: { hot: nextHot },
      });
    } catch (err) {
      console.warn("Could not persist entity hot status:", err);
    }
  }, []);

  // Archive an entity
  const handleArchiveEntity = useCallback(
    async (node: GraphNode) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === node.id ? { ...n, archived: true } : n))
      );
      if (selectedNode?.id === node.id) {
        setSelectedNode(null);
      }

      try {
        await defaultClientActionRegistry.execute("entity_crud", {
          op: "update",
          id: node.id,
          patch: { archived: true, archived_at: new Date().toISOString() },
        });
      } catch (err) {
        console.warn("Could not archive entity:", err);
      }
    },
    [selectedNode?.id]
  );

  // Network ring member counts for Network view
  const networkRingCounts = useMemo(() => {
    const people = nodes.filter(isPersonEntity);
    return getNetworkRingCounts(people);
  }, [nodes]);

  // Extract all distinct entity types and their frequencies.
  // Includes T-box "as if it's an entity type", derived dynamically from node.properties (ADR-036 §1).
  const { availableTypes, typeCounts } = useMemo(() => {

    const counts = new Map<string, number>();
    for (const n of nodes) {
      counts.set(n.entity_type, (counts.get(n.entity_type) || 0) + 1);
    }
    const types = Array.from(counts.keys()).sort();

    // Include T-box as if it's an entity type (derived from node.properties)
    const tBoxCount = nodes.filter(isTBoxEntity).length;
    counts.set(TBOX_TYPE, tBoxCount);
    if (!types.includes(TBOX_TYPE)) {
      types.push(TBOX_TYPE);
    }

    return {
      availableTypes: types,
      typeCounts: counts,
    };
  }, [nodes]);

  // Toggle type filter for multi-select
  const toggleTypeFilter = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // Build hierarchy dynamically from all nodes & edges (calculates longest chain)
  const hierarchy = useMemo(() => {
    return buildHierarchy(nodes, edges);
  }, [nodes, edges]);

  // Neighborhood computation decoupled for hover (purely visual) and isolation (filtering)
  const activeFocusNodeId = hoveredNodeId || (isIsolated && selectedNode ? selectedNode.id : null);

  // 1. Isolated neighborhood for filtering (ONLY active when isIsolated is true)
  const isolatedNeighborNodeIds = useMemo(() => {
    if (!isIsolated || !selectedNode) return null;
    const ids = new Set<string>();
    ids.add(selectedNode.id);
    for (const e of edges) {
      if (e.from_entity_id === selectedNode.id) ids.add(e.to_entity_id);
      if (e.to_entity_id === selectedNode.id) ids.add(e.from_entity_id);
    }
    return ids;
  }, [isIsolated, selectedNode, edges]);

  // 2. Hovered neighborhood for visual dimming only (NEVER affects node filtering or simulation)
  const hoveredNeighborNodeIds = useMemo(() => {
    if (!hoveredNodeId) return null;
    const ids = new Set<string>();
    ids.add(hoveredNodeId);
    for (const e of edges) {
      if (e.from_entity_id === hoveredNodeId) ids.add(e.to_entity_id);
      if (e.to_entity_id === hoveredNodeId) ids.add(e.from_entity_id);
    }
    return ids;
  }, [hoveredNodeId, edges]);

  // Base filtered nodes (by search query, type selection, archived status, LOD zoom level, neighborhood isolation, includeMe, specialised views)
  const baseFilteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (!showArchived && node.archived) return false;

      // Specialised Network View: filter exclusively to people entities
      if (activeView === "network") {
        if (!isPersonEntity(node)) return false;
        if (selectedRingFilter !== null && resolveNodeClosenessRing(node) !== selectedRingFilter) {
          return false;
        }
      }

      // Filter out self node (Angus Hally) when "Include me" is toggled off (unless in Network view where Angus anchors the centre)
      if (activeView !== "network" && !includeMe && isSelfNode(node)) return false;

      // Filter by entity type or T-box pseudo-type (in general view)
      if (activeView !== "network" && selectedTypes.size > 0) {
        const matchesBaseType = selectedTypes.has(node.entity_type);
        const matchesTBox =
          (selectedTypes.has(TBOX_TYPE) || selectedTypes.has("t-box") || selectedTypes.has("T-box")) &&
          isTBoxEntity(node);
        if (!matchesBaseType && !matchesTBox) return false;
      }

      if (isIsolated && selectedNode && isolatedNeighborNodeIds && !isolatedNeighborNodeIds.has(node.id)) return false;

      // Detail Presentation Strategy Filtering
      if (activeView !== "network") {
        const isInteractingWithNode =
          node.id === selectedNode?.id ||
          searchQuery.trim() !== "";

        if (detailStrategy === "tiered") {
          const nodeZoom = node.zoom_level ?? 1;
          if (!isInteractingWithNode) {
            if (scopeTier === "pillars" && nodeZoom > 2) return false;
            if (scopeTier === "core" && nodeZoom > 5) return false;
            if (scopeTier === "standard" && nodeZoom > 8) return false;
            // "all" shows all
          }
        } else if (detailStrategy === "clusters") {
          // If cluster is collapsed, its child nodes are hidden from normal list (macro-node is rendered)
          const clusterKey = resolveNodeClusterKey(node);
          if (collapsedClusters.has(clusterKey) && !isInteractingWithNode) {
            return false;
          }
        } else if (detailStrategy === "landmarks") {
          // All nodes remain in the graph; zoom scale determines dots vs cards
          // No level-based pruning
        } else if (lodMode === "auto") {
          const nodeZoom = node.zoom_level ?? 1;
          if (!isInteractingWithNode && nodeZoom > activeZoomLevel) {
            return false;
          }
        }
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesTitle = node.title.toLowerCase().includes(q);
        const matchesType = node.entity_type.toLowerCase().includes(q);
        const matchesTag = node.tags?.some((t) => t.toLowerCase().includes(q));
        const matchesAlias = node.aliases?.some((a) => a.toLowerCase().includes(q));
        const matchesTBox = (q === "tbox" || q === "t-box") && isTBoxEntity(node);
        if (!matchesTitle && !matchesType && !matchesTag && !matchesAlias && !matchesTBox) return false;
      }
      return true;
    });
  }, [
    nodes,
    showArchived,
    includeMe,
    selectedTypes,
    isIsolated,
    selectedNode,
    isolatedNeighborNodeIds,
    searchQuery,
    lodMode,
    activeZoomLevel,
    detailStrategy,
    scopeTier,
    collapsedClusters,
    activeView,
    selectedRingFilter,
  ]);

  // Apply dynamic hierarchy grouping based on selected level (or bypass for specialised Network view)
  const { visibleNodes, visibleEdges, totalGroupedNodesCount } = useMemo(() => {
    const positionedNodes = syncNodePositions(baseFilteredNodes);
    if (activeView === "network") {
      const visibleNodeIds = new Set(positionedNodes.map((n) => n.id));
      const validEdges = edges.filter(
        (edge) => visibleNodeIds.has(edge.from_entity_id) && visibleNodeIds.has(edge.to_entity_id)
      );
      return {
        visibleNodes: positionedNodes,
        visibleEdges: validEdges,
        totalGroupedNodesCount: 0,
      };
    }

    const grouped = applyHierarchyGrouping(positionedNodes, edges, hierarchy, hierarchyLevel);
    const isolatedEdges = isIsolated && selectedNode
      ? grouped.visibleEdges.filter(
          (edge) => edge.from_entity_id === selectedNode.id || edge.to_entity_id === selectedNode.id
        )
      : grouped.visibleEdges;

    const visibleNodeIds = new Set(grouped.visibleNodes.map((n) => n.id));
    const validEdges = isolatedEdges.filter(
      (edge) => visibleNodeIds.has(edge.from_entity_id) && visibleNodeIds.has(edge.to_entity_id)
    );

    return {
      visibleNodes: grouped.visibleNodes,
      visibleEdges: validEdges,
      totalGroupedNodesCount: grouped.totalGroupedNodesCount,
    };
  }, [baseFilteredNodes, syncNodePositions, edges, hierarchy, hierarchyLevel, isIsolated, selectedNode, activeView]);

  // Wake up physics simulation when visibleNodes count changes
  const prevVisibleCountRef = useRef(visibleNodes.length);
  useEffect(() => {
    if (visibleNodes.length !== prevVisibleCountRef.current) {
      prevVisibleCountRef.current = visibleNodes.length;
      alphaRef.current = Math.max(alphaRef.current, 0.65);
    }
  }, [visibleNodes.length]);

  // Physics animation loop
  useEffect(() => {
    if (isPaused || isLoading || visibleNodes.length === 0) return;

    let isMounted = true;

    const tick = () => {
      if (!isMounted) return;

      if (alphaRef.current > 0.003) {
        let concentricConstraints: Map<string, ConcentricConstraint> | undefined;
        if (activeView === "network") {
          concentricConstraints = new Map();
          const centerX = viewportSize.width / 2;
          const centerY = viewportSize.height / 2;
          for (const node of visibleNodes) {
            const ring = resolveNodeClosenessRing(node);
            const ringDef = getNetworkRingDefinition(ring);
            const isSelf = isSelfNode(node);
            concentricConstraints.set(node.id, {
              centerX,
              centerY,
              targetRadius: ringDef.baseRadius,
              isCenter: isSelf && ring === 1,
            });
          }
        }

        const dynamicRepulsion =
          activeView === "network"
            ? Math.round(physicsConfig.repulsion * 0.2)
            : visibleNodes.length > 80
            ? Math.round(physicsConfig.repulsion * 0.75)
            : physicsConfig.repulsion;
        const newAlpha = stepSimulation(visibleNodes, visibleEdges, {
          width: viewportSize.width,
          height: viewportSize.height,
          repulsion: dynamicRepulsion,
          springLength:
            activeView === "network" ? Math.round(physicsConfig.springLength * 0.6) : physicsConfig.springLength,
          springStrength:
            activeView === "network" ? physicsConfig.springStrength * 1.4 : physicsConfig.springStrength,
          gravity: activeView === "network" ? physicsConfig.gravity * 2.5 : physicsConfig.gravity,
          damping: physicsConfig.damping,
          collisionBuffer: physicsConfig.collisionBuffer,
          coolingRate: physicsConfig.coolingRate,
          alpha: alphaRef.current,
          concentricConstraints,
        });
        alphaRef.current = newAlpha;
        for (const n of visibleNodes) {
          nodePositionCacheRef.current.set(n.id, {
            x: n.x,
            y: n.y,
            vx: n.vx,
            vy: n.vy,
            fx: n.fx,
            fy: n.fy,
          });
        }
        setRenderTick((c) => (c + 1) % 1000000);
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      isMounted = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [
    isPaused,
    isLoading,
    visibleNodes,
    visibleEdges,
    viewportSize.width,
    viewportSize.height,
    activeView,
    physicsConfig,
  ]);

  // Interactive Pan Handlers (Mouse Drag on Background)
  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (contextMenu) {
      setContextMenu(null);
    }
    if (e.target !== svgRef.current && (e.target as HTMLElement).tagName !== "svg") {
      return;
    }
    isPanningRef.current = {
      isPanning: true,
      startX: e.clientX,
      startY: e.clientY,
      initPanX: pan.x,
      initPanY: pan.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    // 1. Pan background
    if (isPanningRef.current.isPanning) {
      const dx = e.clientX - isPanningRef.current.startX;
      const dy = e.clientY - isPanningRef.current.startY;
      setPan({
        x: isPanningRef.current.initPanX + dx,
        y: isPanningRef.current.initPanY + dy,
      });
      return;
    }

    // 2. Drag node
    if (draggedNodeRef.current && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left - pan.x) / zoom;
      const mouseY = (e.clientY - rect.top - pan.y) / zoom;

      draggedNodeRef.current.x = mouseX;
      draggedNodeRef.current.y = mouseY;
      draggedNodeRef.current.fx = mouseX;
      draggedNodeRef.current.fy = mouseY;
      alphaRef.current = Math.max(alphaRef.current, 0.45);
      setRenderTick((c) => (c + 1) % 1000000);
      return;
    }

    // 3. Drag cluster bubble
    if (draggedClusterRef.current && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left - pan.x) / zoom;
      const mouseY = (e.clientY - rect.top - pan.y) / zoom;
      const dx = mouseX - draggedClusterRef.current.startX;
      const dy = mouseY - draggedClusterRef.current.startY;

      if (Math.hypot(dx, dy) > 3) {
        draggedClusterRef.current.hasDragged = true;
      }

      clusterPositionOverridesRef.current.set(draggedClusterRef.current.clusterKey, {
        x: draggedClusterRef.current.initX + dx,
        y: draggedClusterRef.current.initY + dy,
      });
      setRenderTick((c) => (c + 1) % 1000000);
      return;
    }
  };

  const handleMouseUp = () => {
    isPanningRef.current.isPanning = false;
    if (draggedNodeRef.current) {
      if (!pinnedNodeIds.has(draggedNodeRef.current.id)) {
        draggedNodeRef.current.fx = null;
        draggedNodeRef.current.fy = null;
      }
      draggedNodeRef.current = null;
    }
    if (draggedClusterRef.current) {
      draggedClusterRef.current = null;
    }
  };

  // Node Drag Initiator
  const handleNodeMouseDown = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    draggedNodeRef.current = node;
    node.fx = node.x;
    node.fy = node.y;
    alphaRef.current = Math.max(alphaRef.current, 0.45);
    setRenderTick((c) => (c + 1) % 1000000);
  };

  // Cluster Drag Initiator
  const handleClusterMouseDown = (e: React.MouseEvent, cluster: ClusterGroup) => {
    e.stopPropagation();
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left - pan.x) / zoom;
    const mouseY = (e.clientY - rect.top - pan.y) / zoom;
    draggedClusterRef.current = {
      clusterKey: cluster.key,
      initX: cluster.centerX,
      initY: cluster.centerY,
      startX: mouseX,
      startY: mouseY,
      hasDragged: false,
    };
  };

  // Native non-passive wheel listener on graph container:
  // Intercepts wheel events on the canvas, cancels default browser page scrolling,
  // and smoothly zooms into the pointer coordinates.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      // Allow scrolling inside child widgets that handle their own scroll (e.g. MiniChatWidget)
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-no-canvas-zoom]")) {
        return;
      }

      // Explicitly prevent default browser page vertical scrolling
      e.preventDefault();
      e.stopPropagation();

      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const svg = svgRef.current;

      if (svg) {
        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        setZoom((prevZoom) => {
          const nextZoom = Math.max(0.15, Math.min(4.0, prevZoom * zoomFactor));
          const roundedZoom = Number(nextZoom.toFixed(3));

          // Smooth focal zoom: preserve graph coordinate under mouse pointer
          setPan((prevPan) => {
            const gx = (mouseX - prevPan.x) / prevZoom;
            const gy = (mouseY - prevPan.y) / prevZoom;
            return {
              x: mouseX - gx * roundedZoom,
              y: mouseY - gy * roundedZoom,
            };
          });

          return roundedZoom;
        });
      } else {
        setZoom((prev) => {
          const next = Math.max(0.15, Math.min(4.0, prev * zoomFactor));
          return Number(next.toFixed(3));
        });
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Map node id to current live physics node object reference
  const nodePositionMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of visibleNodes) {
      map.set(n.id, n);
    }
    return map;
  }, [visibleNodes, renderTick]);

  // Cluster groups computation for "clusters" strategy
  const clusterGroups = useMemo<ClusterGroup[]>(() => {
    if (activeView === "network") return [];
    const groupsMap = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (!showArchived && n.archived) continue;
      if (!includeMe && isSelfNode(n)) continue;
      const key = resolveNodeClusterKey(n);
      const list = groupsMap.get(key) || [];
      list.push(n);
      groupsMap.set(key, list);
    }

    const result: ClusterGroup[] = [];
    for (const [key, clusterNodes] of groupsMap.entries()) {
      if (clusterNodes.length === 0) continue;
      const override = clusterPositionOverridesRef.current.get(key);
      let cx = 0;
      let cy = 0;
      if (override) {
        cx = override.x;
        cy = override.y;
      } else {
        let sumX = 0;
        let sumY = 0;
        for (const n of clusterNodes) {
          sumX += n.x;
          sumY += n.y;
        }
        cx = sumX / clusterNodes.length;
        cy = sumY / clusterNodes.length;
      }

      let maxDist = 0;
      for (const n of clusterNodes) {
        const d = Math.hypot(n.x - cx, n.y - cy) + (n.radius || 28);
        if (d > maxDist) maxDist = d;
      }
      const radius = Math.max(maxDist + 32, 60);
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      const color = getClusterColor(key);

      result.push({
        key,
        label,
        color,
        nodes: clusterNodes,
        centerX: cx,
        centerY: cy,
        radius,
        isCollapsed: collapsedClusters.has(key),
      });
    }
    const pinnedKey = draggedClusterRef.current?.clusterKey;
    return relaxClusterPositions(result, pinnedKey);
  }, [nodes, activeView, showArchived, includeMe, collapsedClusters, renderTick]);

  return (
    <div className="space-y-4">
      {/* 1. Header Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-slate-800">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <span>Knowledge Graph</span>
            <span
              className={`px-2 py-0.5 text-xs font-mono font-medium rounded-full border ${
                isLive
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-indigo-500/10 text-indigo-400 border-indigo-500/30"
              }`}
            >
              {isLive ? "● Supabase Live" : "● Offline / In-Memory"}
            </span>
            <span className="text-xs font-mono text-slate-400">
              ({visibleNodes.length} {activeView === "network" ? "people" : "nodes"} · {visibleEdges.length} edges
              {totalGroupedNodesCount > 0 ? ` · ${totalGroupedNodesCount} grouped` : ""})
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {activeView === "network"
              ? "Specialised Network View: 7 concentric circles of personal & professional connections."
              : "Dynamic relational topology representing entity nodes and directed relationships."}
          </p>
        </div>

        {/* Action buttons & View Switcher */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Specialised View Switcher Segment */}
          <div className="flex items-center bg-slate-900/90 p-0.5 rounded-lg border border-slate-700/80 shadow-inner mr-1">
            <button
              type="button"
              onClick={() => handleSwitchView("default")}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                activeView === "default"
                  ? "bg-indigo-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
              title="General Graph: standard force-directed layout across all entities"
            >
              <span>🌐 General Graph</span>
            </button>
            <button
              type="button"
              onClick={() => handleSwitchView("network")}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                activeView === "network"
                  ? "bg-indigo-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
              title="Network View: filtered to people nodes in 7 concentric circles"
            >
              <span>👥 Network View</span>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                  activeView === "network"
                    ? "bg-indigo-800 text-indigo-100 font-bold"
                    : "bg-slate-800 text-slate-400"
                }`}
              >
                7 Rings
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={loadData}
            disabled={isLoading}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors border border-slate-700/60 flex items-center gap-1.5"
            title="Refresh graph from database"
          >
            <span>↻</span>
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setIsPaused(!isPaused)}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors border border-slate-700/60"
            title={isPaused ? "Resume physics simulation" : "Pause physics simulation"}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsPhysicsOpen((v) => !v)}
              className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors border flex items-center gap-1.5 ${
                isPhysicsOpen
                  ? "bg-indigo-600 text-white border-indigo-500 shadow-sm font-semibold"
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700/60"
              }`}
              title="Tune physics forces, repulsion, link distance, gravity, and speed"
            >
              <span>⚡</span>
              <span>Physics</span>
            </button>
            <PhysicsControlsPopover
              isOpen={isPhysicsOpen}
              onClose={() => setIsPhysicsOpen(false)}
              config={physicsConfig}
              onChange={handleUpdatePhysics}
              onReset={handleResetPhysics}
              onReheat={handleReheatSimulation}
              isPaused={isPaused}
              onTogglePause={() => setIsPaused((p) => !p)}
            />
          </div>
          <button
            type="button"
            onClick={handleResetView}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors border border-slate-700/60"
            title="Reset zoom & pan"
          >
            🎯 Fit View
          </button>
          {/* Tri-Modal Detail Strategy Switcher (active in General Graph) */}
          {activeView !== "network" && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="flex items-center bg-slate-900/90 p-0.5 rounded-lg border border-slate-700/80 shadow-inner">
                <button
                  type="button"
                  onClick={() => {
                    setDetailStrategy("tiered");
                    if (typeof window !== "undefined") {
                      localStorage.setItem("ahos_graph_detail_strategy", "tiered");
                    }
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                    detailStrategy === "tiered"
                      ? "bg-indigo-600 text-white shadow-sm font-semibold"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                  }`}
                  title="View 1: Scoped Tiers (Pillars / Core / Standard / All) with decoupled spatial camera zoom"
                >
                  <span>🎯 Scoped Tiers</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDetailStrategy("clusters");
                    if (typeof window !== "undefined") {
                      localStorage.setItem("ahos_graph_detail_strategy", "clusters");
                    }
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                    detailStrategy === "clusters"
                      ? "bg-indigo-600 text-white shadow-sm font-semibold"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                  }`}
                  title="View 2: Semantic Domain Clusters with interactive expand and collapse"
                >
                  <span>🫧 Cluster Bubbles</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDetailStrategy("landmarks");
                    if (typeof window !== "undefined") {
                      localStorage.setItem("ahos_graph_detail_strategy", "landmarks");
                    }
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                    detailStrategy === "landmarks"
                      ? "bg-indigo-600 text-white shadow-sm font-semibold"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                  }`}
                  title="View 3: Landmark Pinning (Google Maps / Constellation style with invariant landmark hubs)"
                >
                  <span>🌟 Landmark Galaxy</span>
                </button>
              </div>

              {/* Strategy-Specific Secondary Controls */}
              {detailStrategy === "tiered" && (
                <div className="flex items-center gap-1 bg-slate-900/70 p-0.5 rounded-lg border border-slate-700/60">
                  <button
                    type="button"
                    onClick={() => {
                      setScopeTier("pillars");
                      if (typeof window !== "undefined") {
                        localStorage.setItem("ahos_graph_scope_tier", "pillars");
                      }
                      handleResetView();
                    }}
                    className={`px-2 py-0.5 text-xs rounded transition-all ${
                      scopeTier === "pillars"
                        ? "bg-indigo-500/25 text-indigo-300 font-semibold border border-indigo-500/40"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                    title="Pillars: Apex Level 1-2 Entities (Domains & Self) at readable scale"
                  >
                    🏛️ Pillars (~10)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScopeTier("core");
                      if (typeof window !== "undefined") {
                        localStorage.setItem("ahos_graph_scope_tier", "core");
                      }
                    }}
                    className={`px-2 py-0.5 text-xs rounded transition-all ${
                      scopeTier === "core"
                        ? "bg-indigo-500/25 text-indigo-300 font-semibold border border-indigo-500/40"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                    title="Core: Levels 1-5 Core Projects & Entities (~35)"
                  >
                    ⭐ Core (~35)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScopeTier("standard");
                      if (typeof window !== "undefined") {
                        localStorage.setItem("ahos_graph_scope_tier", "standard");
                      }
                    }}
                    className={`px-2 py-0.5 text-xs rounded transition-all ${
                      scopeTier === "standard"
                        ? "bg-indigo-500/25 text-indigo-300 font-semibold border border-indigo-500/40"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                    title="Standard: Levels 1-8 Standard Graph (~100)"
                  >
                    🌐 Standard (~100)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScopeTier("all");
                      if (typeof window !== "undefined") {
                        localStorage.setItem("ahos_graph_scope_tier", "all");
                      }
                    }}
                    className={`px-2 py-0.5 text-xs rounded transition-all ${
                      scopeTier === "all"
                        ? "bg-indigo-500/25 text-indigo-300 font-semibold border border-indigo-500/40"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                    title="Universe: All Entities"
                  >
                    🌌 All ({nodes.length})
                  </button>
                </div>
              )}

              {detailStrategy === "clusters" && (
                <div className="flex items-center gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setCollapsedClusters(new Set())}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60"
                    title="Expand all clusters to show individual entity nodes"
                  >
                    ⤢ Expand All
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const allKeys = new Set(clusterGroups.map((c) => c.key));
                      setCollapsedClusters(allKeys);
                    }}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60"
                    title="Collapse all clusters into high-level domain macro-bubbles"
                  >
                    ⤓ Collapse All
                  </button>
                </div>
              )}

              {detailStrategy === "landmarks" && (
                <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-indigo-950/40 border border-indigo-800/40 text-indigo-300">
                  <span>🌟 Invariant Landmarks</span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {zoom < 0.65 ? "Galaxy starfield" : "Full cards"}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Include me (Self Node / Angus) Toggle */}
          <button
            type="button"
            onClick={handleToggleIncludeMe}
            className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors border flex items-center gap-1.5 ${
              includeMe
                ? (isNight
                    ? "bg-indigo-600/30 text-indigo-200 border-indigo-500/50 hover:bg-indigo-600/40"
                    : "bg-indigo-100 text-indigo-800 border-indigo-300 hover:bg-indigo-200")
                : (isNight
                    ? "bg-slate-800 hover:bg-slate-700 text-slate-400 border-slate-700/60"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-500 border-slate-300")
            }`}
            title={
              includeMe
                ? "Self node (Angus) is included in the graph. Click to toggle off."
                : "Self node (Angus) is excluded from the graph. Click to toggle on."
            }
          >
            <span>👤 Include me</span>
            <span
              className={`font-mono text-[10px] px-1 py-0.2 rounded border ${
                includeMe
                  ? (isNight
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : "bg-emerald-100 text-emerald-800 border-emerald-300")
                  : (isNight
                      ? "bg-slate-950/70 text-slate-400 border-slate-700/50"
                      : "bg-slate-200/80 text-slate-600 border-slate-300")
              }`}
            >
              {includeMe ? "On" : "Off"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setIsInspectorOpen(!isInspectorOpen)}
            className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors border flex items-center gap-1.5 ${
              isInspectorOpen
                ? "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700/60"
                : "bg-indigo-600/20 text-indigo-300 border-indigo-500/40 hover:bg-indigo-600/30"
            }`}
            title={isInspectorOpen ? "Collapse Inspector drawer to give graph maximum width" : "Expand Inspector drawer"}
          >
            <span>{isInspectorOpen ? "◧ Hide Inspector" : "◨ Inspector"}</span>
          </button>
          <button
            type="button"
            onClick={() => setIsMiniChatOpen(!isMiniChatOpen)}
            className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors border flex items-center gap-1.5 ${
              isMiniChatOpen
                ? "bg-indigo-600/30 text-indigo-200 border-indigo-500/50"
                : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700/60"
            }`}
            title={isMiniChatOpen ? "Close Mini Chat" : "Open Mini Chat (CAR)"}
          >
            <span>💬 Mini Chat</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          </button>
        </div>
      </div>

      {/* 2. Filter & Search Controls */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 text-xs">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search entities by title, alias, or tag..."
            className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
            >
              ✕
            </button>
          )}
        </div>

        {/* Multi-Select Entity Type Picker & Quick Chips (or Concentric Rings Selector when in Network View) */}
        {activeView === "network" ? (
          <div className="flex items-center gap-1.5 flex-wrap flex-1">
            <span
              className="text-[11px] font-mono text-indigo-300 font-semibold flex items-center gap-1 mr-1"
              title="Filter by specific concentric closeness ring or view all"
            >
              <span>🎯</span>
              <span>Concentric Circles:</span>
            </span>

            {/* All Rings chip */}
            <button
              type="button"
              onClick={() => setSelectedRingFilter(null)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-mono transition-all flex items-center gap-1.5 border ${
                selectedRingFilter === null
                  ? "bg-indigo-600 text-white border-indigo-500 shadow-sm font-bold"
                  : "bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border-slate-700"
              }`}
            >
              <span>All 7 Rings</span>
              <span className="text-[10px] px-1 rounded bg-black/40 font-bold">
                {nodes.filter(isPersonEntity).length}
              </span>
            </button>

            {/* 7 Concentric Ring pills */}
            {NETWORK_RINGS.map((ringDef) => {
              const count = networkRingCounts.get(ringDef.ring) || 0;
              const isSelected = selectedRingFilter === ringDef.ring;
              return (
                <button
                  key={ringDef.ring}
                  type="button"
                  onClick={() => setSelectedRingFilter(isSelected ? null : ringDef.ring)}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-mono transition-all flex items-center gap-1.5 border ${
                    isSelected
                      ? `${ringDef.badgeBg} ${ringDef.badgeText} ${ringDef.badgeBorder} ring-1 ring-indigo-400/50 font-bold shadow-sm scale-105`
                      : "bg-slate-800/80 hover:bg-slate-700/80 text-slate-400 border-slate-700"
                  }`}
                  title={`Ring ${ringDef.ring}: ${ringDef.label}: ${ringDef.description}`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full inline-block"
                    style={{ backgroundColor: ringDef.color }}
                  />
                  <span>
                    {ringDef.ring}. {ringDef.label}
                  </span>
                  <span className="text-[10px] opacity-75 font-normal">({count})</span>
                </button>
              );
            })}

            {selectedRingFilter !== null && (
              <button
                type="button"
                onClick={() => setSelectedRingFilter(null)}
                className="text-[10px] text-slate-400 hover:text-slate-200 underline ml-1 font-mono"
              >
                Clear
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {/* Multi-Select Dropdown Popover */}
              <div className="relative" ref={typePickerRef}>
                <button
                  type="button"
                  onClick={() => setIsTypePickerOpen(!isTypePickerOpen)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 border ${
                    selectedTypes.size > 0
                      ? "bg-indigo-900/40 text-indigo-200 border-indigo-500/50 shadow-sm font-semibold"
                      : "bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-700/80"
                  }`}
                  title="Multi-select entity types"
                >
                  <span>🏷️ Types:</span>
                  <span className={selectedTypes.size > 0 ? "text-indigo-300 font-bold" : "text-slate-400"}>
                    {selectedTypes.size === 0 ? "All" : `${selectedTypes.size} selected`}
                  </span>
                  <span className="text-[10px] text-slate-400">▼</span>
                </button>

                {/* Dropdown Menu */}
                {isTypePickerOpen && (
                  <div className="absolute left-0 top-full mt-1.5 z-40 w-64 bg-slate-900/98 border border-slate-700 rounded-xl shadow-2xl p-2.5 backdrop-blur-md">
                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
                      <span className="text-[11px] font-semibold text-slate-200 uppercase tracking-wider">
                        Filter Types
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedTypes(new Set(availableTypes))}
                          className="text-[10px] text-indigo-400 hover:text-indigo-300 font-mono hover:underline"
                        >
                          Select All
                        </button>
                        <span className="text-slate-600">|</span>
                        <button
                          type="button"
                          onClick={() => setSelectedTypes(new Set())}
                          className="text-[10px] text-slate-400 hover:text-slate-200 font-mono hover:underline"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                      {availableTypes.map((type) => {
                        const isChecked = selectedTypes.has(type);
                        const badge = getTypeBadgeColor(type);
                        const count = typeCounts.get(type) || 0;
                        return (
                          <label
                            key={type}
                            className={`flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer text-xs transition-colors ${
                              isChecked
                                ? "bg-indigo-950/60 text-slate-100 border border-indigo-700/40"
                                : "hover:bg-slate-800/60 text-slate-300 border border-transparent"
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleTypeFilter(type)}
                                className="rounded bg-slate-950 border-slate-700 text-indigo-500 focus:ring-0 cursor-pointer"
                              />
                              <span className="text-sm">{badge.icon}</span>
                              <span className="truncate font-mono text-[11px]">{formatTypeLabel(type)}</span>
                            </div>
                            <span className="text-[10px] font-mono text-slate-500">{count}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Quick toggle chips */}
              <div className="flex items-center gap-1 flex-wrap">
                {availableTypes.map((type) => {
                  const isSelected = selectedTypes.has(type);
                  const badge = getTypeBadgeColor(type);
                  const count = typeCounts.get(type) || 0;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleTypeFilter(type)}
                      className={`px-2 py-0.5 rounded-full text-[11px] font-mono transition-all flex items-center gap-1 border ${
                        isSelected
                          ? `${badge.bg} ${badge.text} ${badge.border} ring-1 ring-indigo-500/40 font-bold`
                          : "bg-slate-800/80 hover:bg-slate-700/80 text-slate-400 border-slate-700"
                      }`}
                      title={
                        type === TBOX_TYPE
                          ? `${isSelected ? "Deselect" : "Select"} T-box (in properties) • ${count} entities`
                          : `${isSelected ? "Deselect" : "Select"} ${type} • ${count} entities`
                      }
                    >
                      {isSelected && <span className="text-[10px] text-emerald-400 font-bold">✓</span>}
                      <span>{badge.icon}</span>
                      <span>{formatTypeLabel(type)}</span>
                      <span className="text-[10px] opacity-75 font-normal">({count})</span>
                    </button>
                  );
                })}
                {selectedTypes.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedTypes(new Set())}
                    className="text-[10px] text-slate-400 hover:text-slate-200 underline ml-1 font-mono"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Dynamic Hierarchy Grouping Level Picker */}
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] font-mono text-slate-400 flex items-center gap-1"
                title="Collapse children and grandchildren into grouped parent nodes"
              >
                <span>🌳</span>
                <span>Hierarchy:</span>
              </span>
              <select
                value={hierarchyLevel === null ? "all" : String(hierarchyLevel)}
                onChange={(e) => {
                  const val = e.target.value;
                  setHierarchyLevel(val === "all" ? null : parseInt(val, 10));
                }}
                className="bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                title={`Longest chain: ${hierarchy.maxLevels} levels (${hierarchy.maxDepth} generations deep)`}
              >
                <option value="all">
                  All Levels (Expanded - {hierarchy.maxLevels} {hierarchy.maxLevels === 1 ? "level" : "levels"})
                </option>
                {Array.from({ length: Math.max(1, hierarchy.maxLevels - 1) }, (_, i) => i + 1).map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl === 1
                      ? "Level 1: Roots only (Group all descendants)"
                      : `Level ${lvl}: Up to Gen ${lvl} (Group Gen ${lvl + 1}+)`}
                  </option>
                ))}
              </select>
              {totalGroupedNodesCount > 0 && (
                <span
                  className="px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-700/60 text-[10px] font-mono font-medium animate-pulse"
                  title={`${totalGroupedNodesCount} nodes collapsed into parent groups`}
                >
                  {totalGroupedNodesCount} grouped
                </span>
              )}
            </div>
          </>
        )}

        {/* Archived Toggle */}
        <label className="flex items-center gap-2 cursor-pointer text-slate-400 hover:text-slate-300">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded bg-slate-950 border-slate-700 text-indigo-500 focus:ring-0"
          />
          <span className="text-[11px]">Show Archived</span>
        </label>
      </div>

      {/* 3. Main Interactive Graph Canvas & Inspector */}
      <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden relative flex min-h-[620px] h-[76vh] shadow-2xl">
        {/* SVG Viewport */}
        <div
          ref={containerRef}
          className={`flex-1 relative overflow-hidden overscroll-contain touch-none [background-size:24px_24px] ${
            isNight
              ? "bg-[radial-gradient(#1e293b_1px,transparent_1px)]"
              : "bg-[radial-gradient(#cbd5e1_1.2px,transparent_1.2px)]"
          }`}
        >
          {/* Zoom buttons floating inside canvas */}
          <div className="absolute top-4 left-4 z-20 flex flex-col bg-slate-900/90 border border-slate-800 rounded-lg shadow-lg overflow-hidden backdrop-blur">
            <button
              type="button"
              onClick={() => handleZoom(0.15)}
              className="w-8 h-8 flex items-center justify-center text-slate-300 hover:bg-slate-800 hover:text-white border-b border-slate-800"
              title="Zoom In"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => handleZoom(-0.15)}
              className="w-8 h-8 flex items-center justify-center text-slate-300 hover:bg-slate-800 hover:text-white"
              title="Zoom Out"
            >
              −
            </button>
          </div>

          {/* Scale indicator pill floating in bottom-left */}
          <div className="absolute bottom-4 left-4 z-20 px-2.5 py-1 bg-slate-900/80 border border-slate-800 rounded-lg text-[10px] font-mono text-slate-400 pointer-events-none backdrop-blur flex items-center gap-2">
            <span>Zoom: {Math.round(zoom * 100)}%</span>
            <span>·</span>
            {activeView === "network" ? (
              <span className="text-indigo-300 font-semibold">
                👥 Network View (7 Concentric Circles · {visibleNodes.length} people)
              </span>
            ) : (
              <span>
                LOD: {lodMode === "auto" ? `Level ${activeZoomLevel}/14` : "Show All (Overruled)"}
              </span>
            )}
            <span>·</span>
            <span>Pan: ({Math.round(pan.x)}, {Math.round(pan.y)})</span>
            {totalGroupedNodesCount > 0 && (
              <>
                <span>·</span>
                <span className="text-indigo-300">🌳 {totalGroupedNodesCount} collapsed</span>
              </>
            )}
          </div>

          <svg
            ref={svgRef}
            className="w-full h-full cursor-grab active:cursor-grabbing select-none overscroll-contain touch-none"
            onMouseDown={handleSvgMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <defs>
              {/* Arrowhead marker for directed edges */}
              <marker
                id="arrowhead"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill={isNight ? "#64748b" : "#94a3b8"} />
              </marker>

              {/* Arrowhead marker for active/selected edges */}
              <marker
                id="arrowhead-selected"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="#818cf8" />
              </marker>
            </defs>

            {/* Transform Group for Pan & Zoom */}
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* If no nodes match search/filters */}
              {visibleNodes.length === 0 && !isLoading && (
                <text
                  x={viewportSize.width / 2}
                  y={viewportSize.height / 2}
                  fill="#64748b"
                  textAnchor="middle"
                  fontSize="14"
                  fontFamily="sans-serif"
                >
                  No entities match the current filter criteria.
                </text>
              )}

              {/* Main Graph Content */}
              {visibleNodes.length > 0 && (
                <>
                  {/* Concentric Circles Guide Background Layer (Specialised Network View) */}
                  {activeView === "network" && (
                    <g className="network-concentric-circles pointer-events-none select-none">
                      {/* Central radiant anchor */}
                      <circle
                        cx={viewportSize.width / 2}
                        cy={viewportSize.height / 2}
                        r={28}
                        fill="#818cf8"
                        fillOpacity="0.08"
                        stroke="#818cf8"
                        strokeWidth="1.5"
                        strokeDasharray="3 3"
                      />
                      <circle
                        cx={viewportSize.width / 2}
                        cy={viewportSize.height / 2}
                        r={4}
                        fill="#818cf8"
                        fillOpacity="0.8"
                      />

                      {/* 7 Concentric Rings & Labels */}
                      {NETWORK_RINGS.map((ringDef) => {
                        const cx = viewportSize.width / 2;
                        const cy = viewportSize.height / 2;
                        const r = ringDef.baseRadius;
                        const isRingFiltered =
                          selectedRingFilter !== null && selectedRingFilter !== ringDef.ring;
                        return (
                          <g
                            key={ringDef.ring}
                            className={`ring-guide ring-${ringDef.ring} transition-opacity duration-300 ${
                              isRingFiltered ? "opacity-25" : "opacity-100"
                            }`}
                          >
                            {/* Concentric orbit stroke */}
                            <circle
                              cx={cx}
                              cy={cy}
                              r={r}
                              fill={ringDef.ringFill}
                              stroke={ringDef.ringStroke}
                              strokeWidth={1.5}
                              strokeDasharray={ringDef.ring === 1 ? "4 4" : "6 5"}
                            />
                            {/* Ring Label Badge at 12 o'clock */}
                            <g transform={`translate(${cx}, ${cy - r})`}>
                              <rect
                                x={-60}
                                y={-18}
                                width={120}
                                height={16}
                                rx={8}
                                fill={isNight ? "#090d16" : "#ffffff"}
                                fillOpacity={0.88}
                                stroke={ringDef.color}
                                strokeWidth={1}
                                strokeOpacity={0.4}
                              />
                              <text
                                x={0}
                                y={-6}
                                textAnchor="middle"
                                fontSize={9}
                                fontFamily="monospace"
                                fontWeight="bold"
                                fill={ringDef.color}
                                opacity={0.95}
                              >
                                {ringDef.shortLabel}
                              </text>
                            </g>
                          </g>
                        );
                      })}
                    </g>
                  )}

                  {/* Cluster Bubbles Background Layer (Strategy 2: clusters) */}
                  {activeView !== "network" && detailStrategy === "clusters" && (
                    <g className="cluster-bubbles">
                      {clusterGroups.map((cluster) => {
                        if (cluster.isCollapsed) return null;
                        const badgeWidth = cluster.label.length * 8 + 65;
                        return (
                          <g key={`cluster-hull-${cluster.key}`}>
                            {/* Radiant boundary envelope */}
                            <circle
                              cx={cluster.centerX}
                              cy={cluster.centerY}
                              r={cluster.radius}
                              fill={cluster.color}
                              fillOpacity="0.04"
                              stroke={cluster.color}
                              strokeWidth="1.5"
                              strokeDasharray="6 4"
                              className="pointer-events-none select-none transition-all duration-300"
                            />
                            {/* Floating cluster header pill */}
                            <g
                              transform={`translate(${cluster.centerX}, ${cluster.centerY - cluster.radius})`}
                              className="cursor-pointer"
                              onClick={() => {
                                setCollapsedClusters((prev) => {
                                  const next = new Set(prev);
                                  next.add(cluster.key);
                                  return next;
                                });
                              }}
                            >
                              <rect
                                x={-badgeWidth / 2}
                                y="-12"
                                width={badgeWidth}
                                height="22"
                                rx="11"
                                fill={isNight ? "#090d16" : "#ffffff"}
                                stroke={cluster.color}
                                strokeWidth="1.2"
                              />
                              <text
                                x="0"
                                y="3"
                                fill={cluster.color}
                                fontSize="10"
                                fontWeight="bold"
                                textAnchor="middle"
                                className="pointer-events-none select-none font-sans"
                              >
                                🫧 {cluster.label} ({cluster.nodes.length}) · ⤓
                              </text>
                            </g>
                          </g>
                        );
                      })}
                    </g>
                  )}

                  {/* 1. Edges */}
                  <g className="edges">
                    {visibleEdges.map((edge) => {
                      const from = nodePositionMap.get(edge.from_entity_id);
                      const to = nodePositionMap.get(edge.to_entity_id);
                      if (!from || !to) return null;

                      const isSelected = selectedEdge?.id === edge.id;
                      const isConnectedToActiveNode =
                        activeFocusNodeId &&
                        (edge.from_entity_id === activeFocusNodeId || edge.to_entity_id === activeFocusNodeId);
                      const isFaded = activeFocusNodeId && !isConnectedToActiveNode;

                      const strokeColor = isSelected
                        ? "#818cf8"
                        : isConnectedToActiveNode
                        ? "#6366f1"
                        : isNight
                        ? "#334155"
                        : "#94a3b8";
                      const strokeWidth = isSelected ? 2.5 : isConnectedToActiveNode ? 2.0 : 1.2;

                      // Midpoint for relationship label
                      const midX = (from.x + to.x) / 2;
                      const midY = (from.y + to.y) / 2;

                      // Vector calculation connecting clean node perimeters rather than hidden centers
                      const rFrom = from.radius || 28;
                      const rTo = to.radius || 28;
                      const dx = to.x - from.x;
                      const dy = to.y - from.y;
                      const dist = Math.hypot(dx, dy);

                      let x1 = from.x;
                      let y1 = from.y;
                      let x2 = to.x;
                      let y2 = to.y;

                      if (dist > rFrom + rTo + 6) {
                        const nx = dx / dist;
                        const ny = dy / dist;
                        x1 = from.x + nx * rFrom;
                        y1 = from.y + ny * rFrom;
                        x2 = to.x - nx * (rTo + 2);
                        y2 = to.y - ny * (rTo + 2);
                      }

                      return (
                        <g
                          key={edge.id}
                          className={`cursor-pointer transition-opacity duration-200 ${
                            isFaded ? "opacity-10" : "opacity-100"
                          }`}
                          onClick={() => handleSelectEdge(edge)}
                        >
                          {/* Thick invisible stroke for easier hover/click target */}
                          <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke="transparent"
                            strokeWidth={14}
                          />

                          {/* Rendered Edge Line */}
                          <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke={strokeColor}
                            strokeWidth={strokeWidth}
                            strokeDasharray={edge.relationship_type.includes("relates") ? "4 3" : undefined}
                            markerEnd={isSelected || isConnectedToActiveNode ? "url(#arrowhead-selected)" : "url(#arrowhead)"}
                          />

                          {/* Edge label pill on hover or selection */}
                          {(isSelected || isConnectedToActiveNode) && (
                            <g transform={`translate(${midX}, ${midY})`}>
                              <rect
                                x={-(edge.relationship_type.length * 3.5 + 6)}
                                y="-8"
                                width={edge.relationship_type.length * 7 + 12}
                                height="16"
                                rx="4"
                                fill={isNight ? "#0f172a" : "#ffffff"}
                                stroke={isSelected ? "#818cf8" : isNight ? "#475569" : "#cbd5e1"}
                                strokeWidth="1"
                              />
                              <text
                                x="0"
                                y="3"
                                fill={isSelected ? (isNight ? "#c7d2fe" : "#4338ca") : isNight ? "#94a3b8" : "#475569"}
                                fontSize="9"
                                fontFamily="monospace"
                                textAnchor="middle"
                                className="pointer-events-none select-none"
                              >
                                {edge.relationship_type}
                              </text>
                            </g>
                          )}
                        </g>
                      );
                    })}
                  </g>

                  {/* 2. Nodes */}
                  <g className="nodes">
                    {visibleNodes.map((node) => {
                      const isSelected = selectedNode?.id === node.id;
                      const isHovered = hoveredNodeId === node.id;
                      const activeFocusNeighbors = hoveredNodeId ? hoveredNeighborNodeIds : isolatedNeighborNodeIds;
                      const isNeighbor = activeFocusNeighbors?.has(node.id);
                      const isFaded = activeFocusNodeId && !isNeighbor;

                      const badge = getTypeBadgeColor(node.entity_type);
                      const hasGroupedDescendants = Boolean(node.groupedDescendantCount && node.groupedDescendantCount > 0);
                      const ring = isPersonEntity(node) ? resolveNodeClosenessRing(node) : 5;
                      const ringDef = getNetworkRingDefinition(ring);

                      // Landmark Galaxy Starfield & Invariant Scaling (Strategy 3: landmarks)
                      const isLandmark = (node.zoom_level ?? 1) <= 2 || isSelfNode(node) || node.hot;
                      const isWideGalaxy = activeView !== "network" && detailStrategy === "landmarks" && zoom < 0.65;
                      const isStarryDot = isWideGalaxy && !isLandmark && !isSelected && !isHovered;

                      if (isStarryDot) {
                        return (
                          <g
                            key={node.id}
                            transform={`translate(${node.x}, ${node.y})`}
                            className={`transition-opacity duration-200 cursor-pointer ${
                              isFaded ? "opacity-15" : "opacity-90"
                            } hover:opacity-100 hover:scale-150`}
                            onMouseDown={(e) => handleNodeMouseDown(e, node)}
                            onClick={() => handleSelectNode(node)}
                            onContextMenu={(e) => handleNodeContextMenu(e, node)}
                            onMouseEnter={() => setHoveredNodeId(node.id)}
                            onMouseLeave={() => setHoveredNodeId(null)}
                          >
                            <title>
                              {node.title} ({node.entity_type}
                              {isTBoxEntity(node) ? " · T-box" : ""})
                            </title>
                            <circle
                              r={node.hot ? 5 : 3.5}
                              fill={getClusterColor(resolveNodeClusterKey(node))}
                              fillOpacity={0.85}
                              stroke={isNight ? "#0f172a" : "#ffffff"}
                              strokeWidth={1}
                            />
                          </g>
                        );
                      }

                      const landmarkScale = isWideGalaxy && isLandmark ? Math.min(2.0, Math.max(1.0, 0.85 / zoom)) : 1.0;

                      return (
                        <g
                          key={node.id}
                          transform={
                            landmarkScale !== 1.0
                              ? `translate(${node.x}, ${node.y}) scale(${landmarkScale})`
                              : `translate(${node.x}, ${node.y})`
                          }
                          className={`transition-opacity duration-200 cursor-pointer ${
                            isFaded ? "opacity-15" : "opacity-100"
                          }`}
                          onMouseDown={(e) => handleNodeMouseDown(e, node)}
                          onClick={() => handleSelectNode(node)}
                          onContextMenu={(e) => handleNodeContextMenu(e, node)}
                          onMouseEnter={() => setHoveredNodeId(node.id)}
                          onMouseLeave={() => setHoveredNodeId(null)}
                        >
                          <title>
                            {node.title} ({node.entity_type}
                            {isTBoxEntity(node) ? " · T-box" : ""}
                            {activeView === "network" ? ` · Ring ${ring}: ${ringDef.label}` : ""})
                            {hasGroupedDescendants
                              ? ` • ${node.groupedDescendantCount} children & grandchildren grouped inside`
                              : ""}
                          </title>

                          {/* Selection & Hover highlight rings */}
                          {isSelected && (
                            <circle
                              r={node.radius + 7}
                              fill="none"
                              stroke="#6366f1"
                              strokeWidth="2.5"
                              className="animate-pulse"
                            />
                          )}
                          {isHovered && !isSelected && (
                            <circle r={node.radius + 5} fill="none" stroke="#94a3b8" strokeWidth="1.5" />
                          )}

                          {/* Grouped descendant indicator halo */}
                          {hasGroupedDescendants && (
                            <circle
                              r={node.radius + 6}
                              fill="none"
                              stroke="#818cf8"
                              strokeWidth="1.8"
                              strokeDasharray="3 3"
                              className="animate-pulse"
                            />
                          )}

                          {/* Node Body Circle */}
                          <circle
                            r={node.radius}
                            fill={isNight ? "#0f172a" : "#ffffff"}
                            stroke={
                              isSelected
                                ? "#818cf8"
                                : activeView === "network"
                                ? ringDef.color
                                : isTBoxEntity(node)
                                ? "#a855f7"
                                : node.hot
                                ? "#f59e0b"
                                : node.entity_type === "project"
                                ? "#10b981"
                                : node.entity_type === "people"
                                ? "#3b82f6"
                                : node.entity_type === "place" || node.entity_type === "places"
                                ? "#ef4444"
                                : isNight
                                ? "#475569"
                                : "#94a3b8"
                            }
                            strokeWidth={
                              node.hot || isSelected || isTBoxEntity(node) || activeView === "network" ? 2.5 : 1.8
                            }
                            className="shadow-lg"
                          />

                          {/* Icon inside circle */}
                          <text
                            x="0"
                            y="1"
                            fontSize={node.radius * 0.7}
                            textAnchor="middle"
                            dominantBaseline="central"
                            className="pointer-events-none select-none"
                          >
                            {badge.icon}
                          </text>

                          {/* Hot fire badge indicator */}
                          {node.hot && (
                            <g transform={`translate(${node.radius * 0.7}, -${node.radius * 0.7})`}>
                              <circle r="8" fill="#78350f" stroke="#f59e0b" strokeWidth="1" />
                              <text
                                x="0"
                                y="1"
                                fontSize="9"
                                textAnchor="middle"
                                dominantBaseline="central"
                                className="pointer-events-none"
                              >
                                🔥
                              </text>
                            </g>
                          )}

                          {/* Grouped descendants badge indicator */}
                          {hasGroupedDescendants && (
                            <g
                              transform={`translate(${node.hot ? -node.radius * 0.75 : node.radius * 0.75}, -${node.radius * 0.75})`}
                            >
                              <rect
                                x={node.groupedDescendantCount! > 9 ? -12 : -9}
                                y="-8"
                                width={node.groupedDescendantCount! > 9 ? 24 : 18}
                                height="16"
                                rx="8"
                                fill="#3730a3"
                                stroke="#a5b4fc"
                                strokeWidth="1.2"
                              />
                              <text
                                x="0"
                                y="1"
                                fill="#e0e7ff"
                                fontSize="9"
                                fontFamily="monospace"
                                fontWeight="bold"
                                textAnchor="middle"
                                dominantBaseline="central"
                                className="pointer-events-none select-none"
                              >
                                +{node.groupedDescendantCount}
                              </text>
                            </g>
                          )}

                          {/* T-box schema badge indicator */}
                          {isTBoxEntity(node) && (
                            <g
                              transform={`translate(${node.hot ? -node.radius * 0.75 : node.radius * 0.75}, ${
                                hasGroupedDescendants ? node.radius * 0.75 : -node.radius * 0.75
                              })`}
                            >
                              <circle r="7.5" fill="#3b0764" stroke="#c084fc" strokeWidth="1" />
                              <text
                                x="0"
                                y="1"
                                fontSize="8"
                                textAnchor="middle"
                                dominantBaseline="central"
                                className="pointer-events-none select-none"
                              >
                                🏛️
                              </text>
                            </g>
                          )}

                          {/* Network View Closeness Ring badge indicator */}
                          {activeView === "network" && isPersonEntity(node) && (
                            <g transform={`translate(${node.radius * 0.72}, -${node.radius * 0.72})`}>
                              <circle
                                r="8.5"
                                fill={ringDef.color}
                                stroke={isNight ? "#090d16" : "#ffffff"}
                                strokeWidth="1.5"
                              />
                              <text
                                x="0"
                                y="1"
                                fill="#ffffff"
                                fontSize="9"
                                fontFamily="monospace"
                                fontWeight="bold"
                                textAnchor="middle"
                                dominantBaseline="central"
                                className="pointer-events-none select-none"
                              >
                                {ring}
                              </text>
                            </g>
                          )}

                          {/* Pinned node badge indicator */}
                          {pinnedNodeIds.has(node.id) && (
                            <g transform={`translate(-${node.radius * 0.72}, ${node.radius * 0.72})`}>
                              <circle
                                r="7.5"
                                fill="#1e1b4b"
                                stroke="#818cf8"
                                strokeWidth="1"
                              />
                              <text
                                x="0"
                                y="1"
                                fontSize="8"
                                textAnchor="middle"
                                dominantBaseline="central"
                                className="pointer-events-none select-none"
                              >
                                📌
                              </text>
                            </g>
                          )}

                          {/* Node Label below circle: single line, no background or border, ~60px when not selected */}
                          {(() => {
                            const isExpanded = isSelected || isHovered;
                            const labelText = formatNodeLabel(node.title, isExpanded);

                            return (
                              <g transform={`translate(0, ${node.radius + 12})`}>
                                <text
                                  x="0"
                                  y="0"
                                  fill={
                                    isSelected
                                      ? (isNight ? "#818cf8" : "#4338ca")
                                      : isHovered
                                      ? (isNight ? "#ffffff" : "#1e293b")
                                      : isNight
                                      ? "#cbd5e1"
                                      : "#0f172a"
                                  }
                                  fontSize={isExpanded ? "11" : "10"}
                                  fontFamily="system-ui, -apple-system, sans-serif"
                                  fontWeight={isSelected ? "600" : isHovered ? "500" : "normal"}
                                  textAnchor="middle"
                                  dominantBaseline="hanging"
                                  className="pointer-events-none select-none tracking-tight"
                                >
                                  {labelText}
                                </text>
                              </g>
                            );
                          })()}
                        </g>
                      );
                    })}
                  </g>

                  {/* 3. Collapsed Cluster Macro-Nodes (Strategy 2: clusters) */}
                  {activeView !== "network" && detailStrategy === "clusters" && (
                    <g className="collapsed-clusters">
                      {clusterGroups.map((cluster) => {
                        if (!cluster.isCollapsed) return null;
                        const outerRadius = getClusterMacroRadius(cluster.nodes.length);
                        const innerRadius = outerRadius - 8;
                        const displayLabel =
                          cluster.label.length > 14
                            ? `${cluster.label.slice(0, 13)}…`
                            : cluster.label;

                        return (
                          <g
                            key={`macro-${cluster.key}`}
                            transform={`translate(${cluster.centerX}, ${cluster.centerY})`}
                            className="cursor-grab active:cursor-grabbing transition-transform hover:scale-105"
                            onMouseDown={(e) => handleClusterMouseDown(e, cluster)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (draggedClusterRef.current?.hasDragged) return;
                              setCollapsedClusters((prev) => {
                                const next = new Set(prev);
                                next.delete(cluster.key);
                                return next;
                              });
                            }}
                          >
                            <circle
                              r={outerRadius}
                              fill={cluster.color}
                              fillOpacity="0.18"
                              stroke={cluster.color}
                              strokeWidth="2.5"
                              strokeDasharray="4 2"
                            />
                            <circle
                              r={innerRadius}
                              fill={isNight ? "#090d16" : "#ffffff"}
                              stroke={cluster.color}
                              strokeWidth="1.5"
                            />
                            <text
                              x="0"
                              y="-6"
                              textAnchor="middle"
                              fill={isNight ? "#f8fafc" : "#0f172a"}
                              fontSize={outerRadius > 54 ? "12" : "11"}
                              fontWeight="bold"
                              className="select-none font-sans"
                            >
                              {displayLabel}
                            </text>
                            <text
                              x="0"
                              y="10"
                              textAnchor="middle"
                              fill={cluster.color}
                              fontSize={outerRadius > 54 ? "11" : "9.5"}
                              fontWeight="600"
                              className="select-none font-mono"
                            >
                              {cluster.nodes.length} entities
                            </text>
                            <text
                              x="0"
                              y="24"
                              textAnchor="middle"
                              fill="#94a3b8"
                              fontSize="8"
                              className="select-none font-sans"
                            >
                              Click to expand ⤢
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  )}
                </>
              )}
            </g>
          </svg>

          {/* Node Right-Click Context Menu */}
          {contextMenu && (
            <NodeContextMenu
              node={contextMenu.node}
              position={{ x: contextMenu.x, y: contextMenu.y }}
              onClose={() => setContextMenu(null)}
              isNight={isNight}
              isPinned={pinnedNodeIds.has(contextMenu.node.id)}
              isIsolated={isIsolated && selectedNode?.id === contextMenu.node.id}
              onInspect={(node) => {
                handleSelectNode(node);
                setIsInspectorOpen(true);
              }}
              onCenter={handleCenterOnNode}
              onTogglePin={handleTogglePinNode}
              onToggleIsolate={(node) => {
                if (selectedNode?.id === node.id && isIsolated) {
                  setIsIsolated(false);
                } else {
                  handleSelectNode(node);
                  setIsIsolated(true);
                }
              }}
              onToggleHot={handleToggleHot}
              onToggleTBox={handleToggleTBox}
              onUpdateZoomLevel={handleUpdateZoomLevel}
              onUpdateClosenessRing={handleUpdateClosenessRing}
              onOpenMiniChat={(node) => {
                handleSelectNode(node);
                setIsMiniChatOpen(true);
              }}
              onArchiveEntity={handleArchiveEntity}
            />
          )}

          {/* Mini Chat Floating Copilot Dock */}
          <MiniChatWidget
            isOpen={isMiniChatOpen}
            onToggle={() => setIsMiniChatOpen(!isMiniChatOpen)}
            selectedEntity={
              selectedNode
                ? {
                    id: selectedNode.id,
                    title: selectedNode.title,
                    entity_type: selectedNode.entity_type,
                  }
                : null
            }
            onRefreshGraph={loadData}
            onFilterGraph={({ query, entityType, entityTypes, hierarchyLevel: hLevel, reset }) => {
              if (reset) {
                setSearchQuery("");
                setSelectedTypes(new Set());
                setHierarchyLevel(null);
              } else {
                if (query !== undefined) setSearchQuery(query);
                if (entityTypes !== undefined) {
                  setSelectedTypes(new Set(entityTypes));
                } else if (entityType !== undefined) {
                  setSelectedTypes(new Set([entityType]));
                }
                if (hLevel !== undefined) {
                  setHierarchyLevel(hLevel);
                }
              }
            }}
            onSelectNode={(id) => {
              const target = nodes.find((n) => n.id === id);
              if (target) handleSelectNode(target);
            }}
          />
        </div>

        {/* 4. Entity Inspector Drawer */}
        {isInspectorOpen && (
          <EntityInspector
            selectedNode={selectedNode}
            selectedEdge={selectedEdge}
            allNodes={nodes}
            allEdges={edges}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            onClose={() => {
              handleSelectNode(null);
              handleSelectEdge(null);
              setIsIsolated(false);
            }}
            isIsolated={isIsolated}
            onToggleIsolate={() => setIsIsolated(!isIsolated)}
            onUpdateZoomLevel={handleUpdateZoomLevel}
            onToggleTBox={handleToggleTBox}
            onUpdateClosenessRing={handleUpdateClosenessRing}
            onRelationshipCreated={handleRelationshipCreated}
            onRelationshipDeleted={handleRelationshipDeleted}
          />
        )}
      </div>
    </div>
  );
}
