import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `flowchart TD
  %% STYLING
  classDef actor fill:#f8fafc,stroke:#475569,stroke-width:2px,color:#0f172a;
  classDef portIn fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a;
  classDef core fill:#dcfce7,stroke:#16a34a,stroke-width:3px,color:#14532d;
  classDef portOut fill:#fdf4ff,stroke:#9333ea,stroke-width:2px,color:#581c87;
  classDef extSystem fill:#fef2f2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d;

  %% 1. DRIVING ACTORS
  subgraph G_ACTORS["1. Driving Actors (Clients & Automation)"]
    ACT_HUMAN["Human Operator (Angus)"]:::actor
    ACT_AI["AI Agents (Claude Code / IDE)"]:::actor
    ACT_AUTO["System Schedulers (Cron / Timers)"]:::actor
  end

  %% 2. DRIVING PORTS & ADAPTERS (INBOUND)
  subgraph G_PORTS_IN["2. Inbound Driving Ports & Adapters"]
    direction TB
    PORT_HTTP["HTTP Ingress Port (@ahkms/gateway-http)<br/>POST /api/actions/:id · SSE Streams<br/>(Adapter: Web SPA & Mobile)"]:::portIn
    PORT_MCP["MCP Tool Port (packages/mcp-server)<br/>Stateless Streamable HTTP / stdio<br/>(Adapter: Claude & IDEs)"]:::portIn
    PORT_SCHED["Scheduled Ingestion Port<br/>scheduler_locks · single-flight cadences<br/>(Adapter: Worker Ingest)"]:::portIn
  end

  %% 3. THE CORE DOMAIN (HEXAGON)
  subgraph G_CORE["3. Core Domain (Centralised Action Registry - CAR)"]
    direction TB
    CAR_CORE["@ahkms/core (Kernel)<br/>Central Action Registry (CAR) · Universal Dispatcher"]:::core
    CAR_ACTIONS["Pure Actions & Domain Logic<br/>• capture · knowledge_search · entity_upsert<br/>• dos_synthesis · state_doc_update<br/>• Domain Rules & Audit Logging"]:::core
    CAR_CORE --- CAR_ACTIONS
  end

  %% 4. DRIVEN PORTS & ADAPTERS (OUTBOUND)
  subgraph G_PORTS_OUT["4. Outbound Driven Ports & Adapters"]
    direction TB
    PORT_DB["Database & Storage Port<br/>(Supabase PostgreSQL 15+ & Storage)<br/>pgvector HNSW · GIN Full-Text Index"]:::portOut
    PORT_EXT["External Services Port<br/>(Google Workspace, Notion, CRMs)<br/>OAuth Handshake · Rate Limits"]:::portOut
  end

  %% 5. DRIVEN SECONDARY ACTORS
  subgraph G_SYSTEMS["5. Driven Secondary Actors (State & Records)"]
    SYS_DB[("PostgreSQL 15+ Core<br/>Relational Tables & Vector Index")]:::extSystem
    SYS_NOTION["Notion Workspaces<br/>State Docs & Tasks DB"]:::extSystem
    SYS_GOOGLE["Google Cloud / Workspace<br/>Drive, Gmail, Calendar"]:::extSystem
  end

  %% INBOUND INVOCATION FLOWS
  ACT_HUMAN ==>|Direct UI Interaction| PORT_HTTP
  ACT_AI ==>|Stdio / Streamable MCP| PORT_MCP
  ACT_AUTO ==>|Scheduled Cadences| PORT_SCHED

  PORT_HTTP ==>|Typed Actions| CAR_CORE
  PORT_MCP ==>|Tool Execution| CAR_CORE
  PORT_SCHED ==>|Batch Sync| CAR_CORE

  %% OUTBOUND DISPATCH FLOWS
  CAR_ACTIONS ==>|Normalized State Writes| PORT_DB
  CAR_ACTIONS -.->|External API Updates| PORT_EXT

  PORT_DB ==>|SQL DDL / Mutations| SYS_DB
  PORT_EXT ==>|REST / OAuth API| SYS_NOTION
  PORT_EXT ==>|REST / OAuth API| SYS_GOOGLE`;

export const infraVisionViewData: ViewDefinition = {
  id: "infra-vision",
  title: "View 1: Runtime & Capability Topology",
  subtitle:
    "Canonical Hexagonal Architecture: Inbound Driving Ports, Centralised Action Registry (CAR), and Outbound Driven Ports.",
  badge: {
    text: "Hexagonal Ports & Adapters",
    color: "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30",
  },
  summary:
    "Formalizes the runtime boundary around a decoupled Hexagon. Driving actors (Human, Claude, Schedulers) connect through Inbound Ports (HTTP, MCP, Scheduled Ingestion) to invoke pure actions in the Centralised Action Registry (CAR). Actions interact with external state exclusively via Outbound Driven Ports (Database, Object Storage, External APIs).",
  viewBox: "0 0 1180 640",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp-actors",
      title: "1. Driving Actors",
      icon: "👤",
      x: 20,
      y: 30,
      width: 200,
      height: 580,
      color: "#475569",
      bg: "#f8fafc",
    },
    {
      id: "grp-ports-in",
      title: "2. Inbound Driving Ports",
      icon: "📥",
      x: 240,
      y: 30,
      width: 230,
      height: 580,
      color: "#2563eb",
      bg: "#eff6ff",
    },
    {
      id: "grp-core-hexagon",
      title: "3. Core Domain (Hexagon SSOT)",
      icon: "⬡",
      x: 490,
      y: 30,
      width: 270,
      height: 580,
      color: "#16a34a",
      bg: "#f0fdf4",
    },
    {
      id: "grp-ports-out",
      title: "4. Outbound Driven Ports",
      icon: "📤",
      x: 780,
      y: 30,
      width: 200,
      height: 580,
      color: "#9333ea",
      bg: "#faf5ff",
    },
    {
      id: "grp-secondary-systems",
      title: "5. Driven Systems of Record",
      icon: "🌐",
      x: 1000,
      y: 30,
      width: 160,
      height: 580,
      color: "#dc2626",
      bg: "#fef2f2",
    },
  ],
  nodes: [
    {
      id: "node-human-op",
      title: "Human Operator (Angus)",
      subtitle: "Primary Intent Driver",
      description: ["Co-editing in Web UI", "Directs Claude sessions", "Validates synthesis"],
      icon: "👤",
      iconBg: "#475569",
      x: 35,
      y: 85,
      width: 170,
      height: 110,
      variant: "default",
      details: {
        role: "Primary system operator",
      },
    },
    {
      id: "node-ai-agent",
      title: "AI Assistants",
      subtitle: "Claude Code / IDE",
      description: ["Executes MCP tools", "Drafts daily synthesis", "Refactors codebase"],
      icon: "🤖",
      iconBg: "#334155",
      x: 35,
      y: 245,
      width: 170,
      height: 110,
      variant: "default",
      details: {
        role: "Autonomous & interactive assistant",
      },
    },
    {
      id: "node-sched-actors",
      title: "System Schedulers",
      subtitle: "Automated Cadences",
      description: ["scheduler_locks cron", "Ingest triggers", "Alert evaluations"],
      icon: "⏱️",
      iconBg: "#1e293b",
      x: 35,
      y: 405,
      width: 170,
      height: 110,
      variant: "default",
      details: {
        role: "Background automation trigger",
      },
    },
    {
      id: "node-port-http",
      title: "HTTP Ingress Port",
      subtitle: "@ahkms/gateway-http",
      description: [
        "- POST /api/actions/:id",
        "- SSE streamable events",
        "- Supabase JWT AuthGate",
      ],
      icon: "🌐",
      iconBg: "#2563eb",
      x: 255,
      y: 85,
      width: 200,
      height: 150,
      variant: "primary",
      details: {
        role: "Inbound HTTP Adapter for Web SPA and Mobile companion",
        adrOrIssue: "ADR-100",
      },
    },
    {
      id: "node-port-mcp",
      title: "MCP Tool Port",
      subtitle: "packages/mcp-server",
      description: [
        "- Streamable HTTP + stdio",
        "- Dynamic tool definitions",
        "- OAuth authentication",
      ],
      icon: "MCP",
      iconBg: "#1d4ed8",
      x: 255,
      y: 260,
      width: 200,
      height: 150,
      variant: "primary",
      details: {
        role: "Inbound Protocol Adapter for Model Context Protocol callers",
      },
    },
    {
      id: "node-port-sched",
      title: "Scheduled Ingestion Port",
      subtitle: "Cadence Adapter",
      description: [
        "- Single-flight mutex locks",
        "- Rate-budgeted batches",
        "- Failure retry policies",
      ],
      icon: "⚙️",
      iconBg: "#1e40af",
      x: 255,
      y: 435,
      width: 200,
      height: 150,
      variant: "primary",
      details: {
        role: "Inbound Cadence Adapter for background synchronization",
      },
    },
    {
      id: "node-hexagon-core",
      title: "@ahkms/core (Kernel)",
      subtitle: "Central Action Registry (CAR)",
      description: [
        "Universal Action Dispatcher:",
        "- capture, knowledge_search",
        "- entity_upsert, entity_relate",
        "- dos_synthesis, state_doc_update",
        "Domain Guarantees:",
        "- Zod input/output schemas",
        "- Bitemporal timestamp assertion",
        "- Append-only audit logging",
      ],
      icon: "⬡",
      iconBg: "#16a34a",
      x: 505,
      y: 85,
      width: 240,
      height: 500,
      variant: "success",
      details: {
        role: "Domain Kernel & Single Source of Truth for Business Rules",
        adrOrIssue: "ADR-100",
      },
    },
    {
      id: "node-port-db",
      title: "Database Port",
      subtitle: "Storage Adapter",
      description: [
        "- Supabase PostgreSQL 15+",
        "- 1536-dim HNSW pgvector",
        "- GIN full-text index",
        "- Object storage buckets",
      ],
      icon: "🗄️",
      iconBg: "#9333ea",
      x: 795,
      y: 110,
      width: 170,
      height: 220,
      variant: "purple",
      details: {
        role: "Outbound Persistence Adapter",
      },
    },
    {
      id: "node-port-ext",
      title: "External Services Port",
      subtitle: "Integration Adapter",
      description: [
        "- Google Workspace APIs",
        "- Notion SDK & Client",
        "- Slack, GitHub, Dex CRM",
        "- Credential vault refs",
      ],
      icon: "🔌",
      iconBg: "#7e22ce",
      x: 795,
      y: 360,
      width: 170,
      height: 225,
      variant: "purple",
      details: {
        role: "Outbound External API Adapter",
      },
    },
    {
      id: "node-sys-db",
      title: "PostgreSQL 15+",
      subtitle: "Primary Relational Core",
      description: ["Supabase Hosted", "35 Relational Tables", "Vector Embeddings"],
      icon: "🐘",
      iconBg: "#dc2626",
      x: 1015,
      y: 110,
      width: 130,
      height: 220,
      variant: "warning",
      details: {
        role: "Secondary Actor: Relational Substrate",
      },
    },
    {
      id: "node-sys-notion",
      title: "Notion Workspaces",
      subtitle: "State Docs & Tasks",
      description: ["Living documentation", "Tasks database", "Project registries"],
      icon: "N",
      iconBg: "#b91c1c",
      x: 1015,
      y: 360,
      width: 130,
      height: 105,
      variant: "warning",
      details: {
        role: "Secondary Actor: State of Record",
      },
    },
    {
      id: "node-sys-google",
      title: "Google Workspace",
      subtitle: "Drive, Gmail, Cal",
      description: ["Drive files", "Gmail threads", "Calendar events"],
      icon: "G",
      iconBg: "#991b1b",
      x: 1015,
      y: 480,
      width: 130,
      height: 105,
      variant: "warning",
      details: {
        role: "Secondary Actor: Ingestion Sources",
      },
    },
  ],
  lines: [
    {
      id: "l-actor-human",
      path: "M 205 140 L 255 140",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-actor-ai",
      path: "M 205 300 L 255 300",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-actor-sched",
      path: "M 205 460 L 255 460",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-http-to-core",
      path: "M 455 160 L 505 160",
      color: "#2563eb",
      width: 2.5,
    },
    {
      id: "l-mcp-to-core",
      path: "M 455 335 L 505 335",
      color: "#2563eb",
      width: 2.5,
    },
    {
      id: "l-sched-to-core",
      path: "M 455 510 L 505 510",
      color: "#2563eb",
      width: 2.5,
    },
    {
      id: "l-core-to-dbport",
      path: "M 745 220 L 795 220",
      color: "#9333ea",
      width: 2.5,
    },
    {
      id: "l-core-to-extport",
      path: "M 745 470 L 795 470",
      color: "#9333ea",
      width: 2.5,
    },
    {
      id: "l-dbport-to-sysdb",
      path: "M 965 220 L 1015 220",
      color: "#dc2626",
      width: 2,
    },
    {
      id: "l-extport-to-notion",
      path: "M 965 412 L 1015 412",
      color: "#dc2626",
      width: 2,
    },
    {
      id: "l-extport-to-google",
      path: "M 965 532 L 1015 532",
      color: "#dc2626",
      width: 2,
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Driving Actor Invocations",
      detail:
        "Human operators and AI assistants trigger requests through specific client interfaces, while timers fire scheduled cadences.",
    },
    {
      step: 2,
      title: "Inbound Port Translation",
      detail:
        "Inbound adapters (HTTP, MCP, Ingestion) validate payloads and translate surface-specific requests into unified, typed CAR action calls.",
    },
    {
      step: 3,
      title: "Decoupled Hexagonal Core Execution",
      detail:
        "The core kernel (@ahkms/core) enforces domain invariants, validates Zod schemas, asserts bitemporal timestamps, and appends audit ledger entries.",
    },
    {
      step: 4,
      title: "Outbound Port Delegation",
      detail:
        "Pure actions communicate outward strictly through Driven Ports, isolating database operations and third-party rate limits from domain rules.",
    },
    {
      step: 5,
      title: "Downstream Persistence & Projections",
      detail:
        "Secondary actors (Supabase PostgreSQL, Notion, Google Workspace) persist relational state or receive projected document updates.",
    },
  ],
};
