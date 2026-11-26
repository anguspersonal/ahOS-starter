import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `flowchart TD
  %% STYLING
  classDef human fill:#fffbeb,stroke:#d97706,stroke-width:2px,color:#78350f;
  classDef client fill:#f8fafc,stroke:#475569,stroke-width:2px,color:#0f172a;
  classDef railway fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a;
  classDef supabase fill:#f0fdf4,stroke:#16a34a,stroke-width:2px,color:#14532d;
  classDef external fill:#fef2f2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d;

  %% CLIENTS & OPERATOR
  subgraph G_CLIENTS["Human Operator & Client Surfaces"]
    OPERATOR["Human Operator (Angus)"]:::human
    CLAUDE_CODE["Claude Code (CLI Agent)<br/>stdio local session"]:::client
    IDE["Antigravity / Cursor IDE<br/>Pair programming IDE"]:::client
    WEB_APP["Web Co-Editing SPA (packages/web)<br/>React 19 + Vite (ADR-100)"]:::client
    MOBILE_APP["Expo Mobile Companion<br/>packages/mobile (ADR-010)"]:::client
  end

  %% HOSTED SERVICES
  subgraph G_RAILWAY["Railway Cloud Substrate"]
    MCP_SERVER["mcp-server (@ahkms/mcp-server)<br/>Streamable HTTP + OAuth<br/>Centralised Action Registry (CAR)"]:::railway
    WORKER["worker (@ahkms/worker)<br/>Express API + Scheduled Cadences<br/>PDF Processing & Locks"]:::railway
  end

  %% PERSISTENCE CORE
  subgraph G_SUPABASE["Supabase Cloud Platform"]
    DB_CORE[("PostgreSQL 15+ Core<br/>Relational Tables + pgvector HNSW<br/>GIN tsvector Full-Text Index")]:::supabase
    BLOB_STORE[("Supabase Object Storage<br/>raw-inputs & derived-artifacts")]:::supabase
    AUTH_GATE["Supabase Auth & RLS<br/>Row-Level Security Policies"]:::supabase
  end

  %% EXTERNAL SYSTEMS OF RECORD
  subgraph G_EXTERNAL["External SaaS Systems of Record"]
    GOOGLE["Google Workspace<br/>(Drive, Gmail, Calendar)"]:::external
    NOTION["Notion Workspaces<br/>(State Docs, Tasks DB)"]:::external
    COMM_CRM["Communications & CRM<br/>(Slack, GitHub, Dex, Brevo)"]:::external
  end

  %% RELATIONSHIPS
  OPERATOR -->|Directs & authors| CLAUDE_CODE
  OPERATOR -->|Pairs via| IDE
  OPERATOR -->|Reviews on| WEB_APP
  OPERATOR -->|Quick capture| MOBILE_APP

  CLAUDE_CODE -->|MCP Streamable HTTP / stdio| MCP_SERVER
  IDE -->|MCP Streamable HTTP / stdio| MCP_SERVER
  WEB_APP -->|CAR Actions & Supabase Auth| MCP_SERVER
  WEB_APP -.->|Direct reads / RLS| DB_CORE
  MOBILE_APP -->|Ingress REST / Auth| WORKER

  MCP_SERVER <==>|PostgreSQL connection pool| DB_CORE
  WORKER <==>|Cadence locks & job state| DB_CORE
  WORKER -->|Stores processed chunks| BLOB_STORE

  MCP_SERVER <==>|OAuth / REST Ingestion| GOOGLE
  MCP_SERVER <==>|State doc updates & tasks| NOTION
  MCP_SERVER <==>|APIs & CRM proxies| COMM_CRM`;

export const infraCurrentViewData: ViewDefinition = {
  id: "infra-current",
  title: "View 0: System Context & Landscape",
  subtitle:
    "Macroscopic 30,000 ft view: Operator surfaces, Railway services, Supabase data core, and external SaaS of record.",
  badge: {
    text: "Production Landscape",
    color: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
  },
  summary:
    "Production runtime spans human and AI client surfaces (Claude Code, Antigravity IDE, Web SPA, Mobile), Railway cloud hosting (mcp-server CAR adapter and worker compute), Supabase platform (PostgreSQL 15+, pgvector HNSW, object storage, and Auth), and external SaaS of record (Google Workspace, Notion, Slack, GitHub, Dex CRM).",
  viewBox: "0 0 1180 640",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp-clients",
      title: "Human Operator & Client Surfaces",
      icon: "💻",
      x: 25,
      y: 30,
      width: 200,
      height: 580,
      color: "#3b82f6",
      bg: "#f8fafc",
    },
    {
      id: "grp-railway",
      title: "Railway Cloud (Project: ahOS)",
      icon: "🚂",
      x: 290,
      y: 30,
      width: 330,
      height: 580,
      color: "#7c3aed",
      bg: "#ffffff",
    },
    {
      id: "grp-supabase",
      title: "Supabase Cloud Platform",
      icon: "⚡",
      x: 660,
      y: 30,
      width: 260,
      height: 580,
      color: "#16a34a",
      bg: "#f0fdf4",
    },
    {
      id: "grp-external-surfaces",
      title: "External SaaS Systems of Record",
      icon: "🌐",
      x: 945,
      y: 30,
      width: 215,
      height: 580,
      color: "#d97706",
      bg: "#f8fafc",
    },
  ],
  nodes: [
    {
      id: "node-claude-client",
      title: "Claude Code / Desk",
      subtitle: "stdio / Streamable",
      description: ["Primary agent coding CLI", "Directs ritual & tools"],
      icon: "💻",
      iconBg: "#3b82f6",
      x: 40,
      y: 90,
      width: 170,
      height: 90,
      variant: "default",
      details: {
        role: "Primary agent caller",
        notes: "Connects via stdio locally or Streamable HTTP remotely.",
      },
    },
    {
      id: "node-antigravity",
      title: "Antigravity / Cursor",
      subtitle: "Pair Programming IDE",
      description: ["Interactive workspace", "MCP tools connected"],
      icon: "🤖",
      iconBg: "#2563eb",
      x: 40,
      y: 210,
      width: 170,
      height: 90,
      variant: "primary",
      details: {
        role: "Interactive developer environment",
        notes: "Connected to ahkms-knowledge MCP server.",
      },
    },
    {
      id: "node-mobile-client",
      title: "Expo Mobile App",
      subtitle: "Direct REST / Auth",
      description: ["Quick capture surface", "Mobile companion (ADR-010)"],
      icon: "📱",
      iconBg: "#0284c7",
      x: 40,
      y: 330,
      width: 170,
      height: 90,
      variant: "default",
      details: {
        role: "Mobile companion",
        notes: "Connects to Supabase Auth and worker ingress endpoints.",
      },
    },
    {
      id: "node-web-client",
      title: "Web Co-Editing SPA",
      subtitle: "React 19 / AuthGate",
      description: ["Agent-Native Workspace", "Knowledge Graph Canvas", "CAR Action Protocol"],
      icon: "🌐",
      iconBg: "#0284c7",
      x: 40,
      y: 440,
      width: 170,
      height: 90,
      variant: "primary",
      details: {
        role: "Agent-Native Co-Editing UI & Knowledge Graph",
        adrOrIssue: "ADR-100",
        notes: "Unarchived under ADR-100; communicates via CAR actions and Supabase Auth.",
      },
    },
    {
      id: "node-railway-mcp",
      title: "mcp-server (Railway)",
      subtitle: "Streamable HTTP + OAuth",
      description: [
        "Centralised Action Registry (CAR):",
        "- capture, knowledge_search",
        "- entities, people, entity_relate",
        "- Google Drive / Gmail / Calendar",
        "- Notion database query & pages",
        "- Dex CRM, Brevo, Meta Ads proxies",
        "- dos synthesis & State Doc update",
        "Scheduled Ingestion Cadences:",
        "Drive discovery & batch enrichment",
      ],
      icon: "MCP",
      iconBg: "#7c3aed",
      x: 310,
      y: 85,
      width: 290,
      height: 225,
      variant: "purple",
      details: {
        role: "Core MCP serving service",
        notes: "Hosted on Railway; executes tool calls and scheduled Google Drive sync.",
      },
    },
    {
      id: "node-railway-worker",
      title: "worker (Express API)",
      subtitle: "Railway Background Worker",
      description: [
        "- PDF processing & page splitting",
        "- Asynchronous ingestion routes",
        "- Single-flighted background cron",
        "- Resend notification dispatches",
      ],
      icon: "⚙️",
      iconBg: "#6d28d9",
      x: 310,
      y: 335,
      width: 290,
      height: 225,
      variant: "default",
      details: {
        role: "Worker orchestrator",
        notes: "Scheduled for progressive retirement as pure actions absorb its capabilities into @ahkms/core.",
      },
    },
    {
      id: "node-supabase-db",
      title: "PostgreSQL 15+ Core",
      subtitle: "Supabase Hosted",
      description: [
        "Core Relational Tables (35 tables):",
        "- artifacts & derived_artifacts",
        "- entities & entity_relationships",
        "- user_preferences & user_integrations",
        "- capabilities & bindings",
        "- scheduler_locks & scheduler_runs",
        "pgvector HNSW Search:",
        "1536-dim vector embeddings + GIN FTS",
      ],
      icon: "🗄️",
      iconBg: "#16a34a",
      x: 680,
      y: 85,
      width: 220,
      height: 225,
      variant: "success",
      details: {
        role: "Primary datastore and vector index",
        notes: "Enforces foreign keys, RLS policies, and HNSW cosine similarity search.",
      },
    },
    {
      id: "node-supabase-storage",
      title: "Supabase Storage",
      subtitle: "Object Buckets",
      description: [
        "- raw-inputs (user uploads)",
        "- derived-artifacts (extracted PDFs)",
      ],
      icon: "🪣",
      iconBg: "#059669",
      x: 680,
      y: 335,
      width: 220,
      height: 110,
      variant: "default",
      details: {
        role: "Object blob storage",
        notes: "Stores original uploaded files and generated artifacts.",
      },
    },
    {
      id: "node-supabase-auth",
      title: "Supabase Auth & RLS",
      subtitle: "Identity & Security",
      description: [
        "- Row-Level Security (RLS)",
        "- JWT session verification",
        "- Multi-tenant tenant_id isolation",
      ],
      icon: "🔒",
      iconBg: "#0d9488",
      x: 680,
      y: 465,
      width: 220,
      height: 95,
      variant: "default",
      details: {
        role: "Authentication and security perimeter",
        filesOrPath: "supabase/migrations/",
      },
    },
    {
      id: "node-external-saas",
      title: "Connected SaaS Platforms",
      subtitle: "Systems of Record",
      description: [
        "Google Workspace:",
        "- Drive files, Gmail threads, Calendar",
        "Notion Workspaces:",
        "- State Docs & canonical Tasks DB",
        "Communications & CRMs:",
        "- Slack, GitHub, Dex CRM, Brevo, Meta Ads",
      ],
      icon: "🌐",
      iconBg: "#ea580c",
      x: 955,
      y: 85,
      width: 195,
      height: 125,
      variant: "warning",
      details: {
        role: "Upstream and downstream systems of record",
        notes: "Accessed via user_integrations with credential vault refs.",
      },
    },
    {
      id: "node-l3-matrix",
      title: "L3 Storage Policy (ADR-091)",
      subtitle: "Store vs. Map Split",
      description: [
        "Stored (bytes kept):",
        "- Gmail, Slack, Drive <25MB, Plaud",
        "Mapped (bytes live):",
        "- Notion, GitHub, Dex CRM, Brevo",
        "- PostHog, Drive >25MB",
        "Ritual Projections:",
        "✓ work State Doc",
        "✗ angus personal (unwired)",
        "1,713 unconsumed atoms",
        "Coverage gap, not ingest",
      ],
      icon: "📊",
      iconBg: "#d97706",
      x: 955,
      y: 230,
      width: 195,
      height: 360,
      variant: "default",
      details: {
        role: "Storage classification and synthesis coverage",
        adrOrIssue: "ADR-091, ADR-088",
        notes: "Distinguishes high-risk surfaces that need local bytes from surfaces where upstream is the source of truth.",
      },
    },
  ],
  lines: [
    {
      id: "l-client-to-mcp",
      path: "M 210 135 L 310 135",
      color: "#545b64",
      width: 2,
    },
    {
      id: "l-ide-to-mcp",
      path: "M 210 255 L 310 255",
      color: "#545b64",
      width: 2,
    },
    {
      id: "l-web-to-mcp",
      path: "M 210 485 L 260 485 L 260 200 L 310 200",
      color: "#0284c7",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-mobile-to-worker",
      path: "M 210 375 L 310 375",
      color: "#0284c7",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-mcp-to-db",
      path: "M 600 180 L 680 180",
      color: "#545b64",
      width: 2,
    },
    {
      id: "l-worker-to-storage",
      path: "M 600 420 L 680 420",
      color: "#545b64",
      width: 2,
    },
    {
      id: "l-mcp-to-surfaces",
      path: "M 600 145 L 955 145",
      color: "#ea580c",
      width: 1.5,
      dashed: true,
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Human Operator & Agent Interaction",
      detail:
        "The operator interacts through Claude Code CLI, Antigravity IDE, the Web Co-Editing SPA (ADR-100), or the mobile app companion.",
    },
    {
      step: 2,
      title: "Centralised Action Registry (CAR) Execution",
      detail:
        "Railway hosted mcp-server handles incoming tool calls, verifies OAuth identity, routes actions, and calls external services.",
    },
    {
      step: 3,
      title: "Background Compute & Cadences",
      detail:
        "Railway worker executes heavy asynchronous processing (PDF text extraction) and scheduled cadence jobs under distributed locks.",
    },
    {
      step: 4,
      title: "Relational Persistence & Vector Indexing",
      detail:
        "Supabase PostgreSQL holds the canonical 35-table schema, enforcing relational integrity, HNSW vector search, and GIN full-text search.",
    },
    {
      step: 5,
      title: "Upstream SaaS Synchronization & Projections",
      detail:
        "Integrations sync data from Google Workspace, Slack, and CRMs, while the daily synthesis ritual projects confirmed updates into Notion State Docs.",
    },
  ],
};
