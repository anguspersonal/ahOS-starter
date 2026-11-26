import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `flowchart TD
  %% STYLING
  classDef tooling fill:#f8fafc,stroke:#475569,stroke-width:1px,color:#0f172a;
  classDef guards fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a;
  classDef pkgCore fill:#dcfce7,stroke:#16a34a,stroke-width:3px,color:#14532d;
  classDef pkgServer fill:#fdf4ff,stroke:#c026d3,stroke-width:2px,color:#701a75;
  classDef pkgClient fill:#fffbeb,stroke:#d97706,stroke-width:2px,color:#78350f;
  classDef pkgDb fill:#f0fdf4,stroke:#059669,stroke-width:2px,color:#064e3b;

  %% 1. MONOREPO ORCHESTRATION & ZERO-DB GUARDS
  subgraph S_PIPELINE["1. Monorepo Orchestration & Zero-DB CI Guards"]
    direction LR
    TURBO["turbo.json<br/>Package cache keys · Isolated inputs"]:::tooling
    GUARDS["scripts/guards.js<br/>check-signatures · check-collisions · check-drift"]:::guards
    WORKFLOWS[".github/workflows/<br/>ci-dev.yml · pr-guards.yml · commit-author"]:::guards
  end

  %% 2. CORE DOMAIN KERNEL (HEXAGON SSOT - ABSORBS SHARED)
  subgraph S_CORE["2. Core Domain Kernel: packages/core (@ahkms/core)"]
    direction TB
    PKG_CORE["packages/core (@ahkms/core)<br/>• Domain Types & Zod Schemas (absorbs shared)<br/>• Central Action Registry (CAR) & Dispatcher<br/>• Domain Rules & Audit Ledger<br/>Exports: . (engine) · ./schemas · ./client"]:::pkgCore
  end

  %% 3. INGRESS ADAPTERS & CO-EDITING CLIENTS
  subgraph S_PACKAGES["3. Ingress Adapters & Co-Editing Clients"]
    direction LR
    PKG_MCP["packages/mcp-server<br/>MCP Protocol Adapter<br/>Streamable HTTP + stdio<br/>Unit: Vitest"]:::pkgServer
    PKG_WEB["packages/web (@ahkms/web)<br/>Agent-Native Co-Editing SPA (ADR-100)<br/>Canvas & Graph Surface<br/>Unit: Vitest"]:::pkgClient
    PKG_MOBILE["packages/mobile<br/>Expo Baseline (ADR-010)<br/>Mobile Client"]:::pkgClient
  end

  %% 4. PERSISTENCE & MIGRATIONS
  subgraph S_PERSIST["4. Database Schema & Migration Deployment"]
    direction TB
    MIGRATIONS["supabase/migrations/ (001-105+)<br/>14-digit timestamps · DROP+CREATE signatures<br/>Deploy: PR -> supabase db push (Never apply_migration)"]:::pkgDb
  end

  %% DEPENDENCY FLOWS
  TURBO -.->|Orchestrates| S_PACKAGES
  GUARDS -.->|Protects| S_CORE
  GUARDS -.->|Protects| S_PACKAGES
  GUARDS -.->|Protects| MIGRATIONS

  PKG_CORE ==>|Full Domain Engine| PKG_MCP
  PKG_CORE ==>|import from @ahkms/core/schemas & /client| PKG_WEB
  PKG_CORE ==>|import from @ahkms/core/schemas & /client| PKG_MOBILE

  PKG_CORE ==>|Direct DB Mutations| MIGRATIONS`;

export const repoCurrentViewData: ViewDefinition = {
  id: "repo-current",
  title: "View 2: Monorepo Architecture & CI Delivery Pipeline",
  subtitle:
    "Turborepo monorepo with @ahkms/core Kernel, ingress adapters, co-editing surfaces, and zero-DB CI guardrails.",
  badge: {
    text: "Monorepo & CI",
    color: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  },
  summary:
    "The repo is organized around npm workspaces managed by Turborepo. packages/core (@ahkms/core) forms the domain kernel absorbing shared; packages/mcp-server is the primary public tool surface; packages/web is the authenticated Agent-Native Co-Editing workspace and interactive Knowledge Graph canvas.",
  viewBox: "0 0 1180 640",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp-dev-env",
      title: "Agent & Dev Workspace",
      icon: "✓",
      x: 25,
      y: 30,
      width: 220,
      height: 580,
      color: "#059669",
      bg: "#f8fafc",
    },
    {
      id: "grp-monorepo",
      title: "ahOS Monorepo (Turborepo + npm workspaces)",
      icon: "ah",
      x: 310,
      y: 30,
      width: 840,
      height: 580,
      color: "#2563eb",
      bg: "#ffffff",
    },
    {
      id: "grp-ci-guards",
      title: "Zero-DB CI Guards & Tooling",
      x: 330,
      y: 75,
      width: 480,
      height: 110,
      color: "#94a3b8",
      bg: "#f8fafc",
      dashed: true,
    },
  ],
  nodes: [
    {
      id: "node-claude-code",
      title: "Claude Code",
      subtitle: "Local stdio session",
      description: ["Target: dev branch", "Local terminal agent"],
      icon: "CLI",
      iconBg: "#d97706",
      x: 50,
      y: 100,
      width: 170,
      height: 95,
      variant: "default",
      details: {
        role: "Primary agent coding interface",
        filesOrPath: ".claude/skills/",
        notes: "Operates with PreToolUse hooks blocking pushes from scratch claude/* branches.",
      },
    },
    {
      id: "node-ide",
      title: "Antigravity / Cursor",
      subtitle: "Pair programming IDE",
      description: ["Local MCP connection", "Full workspace editing"],
      icon: "IDE",
      iconBg: "#2563eb",
      x: 50,
      y: 240,
      width: 170,
      height: 95,
      variant: "default",
      details: {
        role: "Interactive developer environment",
        filesOrPath: ".gemini/antigravity/",
        notes: "Connected to ahkms-knowledge and work-ops MCP servers.",
      },
    },
    {
      id: "node-mobile",
      title: "packages/mobile",
      subtitle: "Expo baseline (ADR-010)",
      description: ["Quick capture hooks", "Mobile client target"],
      icon: "📱",
      iconBg: "#0284c7",
      x: 50,
      y: 440,
      width: 170,
      height: 95,
      variant: "default",
      details: {
        role: "Lightweight mobile capture client",
        filesOrPath: "packages/mobile/src/",
        adrOrIssue: "ADR-010",
      },
    },
    {
      id: "node-turbo",
      title: "turbo.json",
      subtitle: "Package cache keys",
      description: ["Task pipeline config", "Isolated package inputs"],
      icon: "⚡",
      iconBg: "#0f172a",
      x: 345,
      y: 110,
      width: 140,
      height: 60,
      variant: "default",
      details: {
        role: "Turborepo build & test orchestrator",
        filesOrPath: "turbo.json",
        notes: "Enforces package-level cache key isolation.",
      },
    },
    {
      id: "node-guards",
      title: "scripts/guards.js",
      subtitle: "Zero-DB static checks",
      description: ["check-signatures", "check-collisions", "check-drift"],
      icon: "🛡️",
      iconBg: "#475569",
      x: 495,
      y: 110,
      width: 150,
      height: 60,
      variant: "default",
      details: {
        role: "Zero-database static linter suite",
        filesOrPath: "packages/worker/scripts/check-*.js",
        notes: "Guards against bare CREATE OR REPLACE, migration timestamp collisions, and architecture drift.",
      },
    },
    {
      id: "node-workflows",
      title: ".github/workflows/",
      subtitle: "ci-dev & pr-guards",
      description: ["Commit author guard", "Autonomous PR checks"],
      icon: "✓",
      iconBg: "#059669",
      x: 655,
      y: 110,
      width: 140,
      height: 60,
      variant: "default",
      details: {
        role: "GitHub Actions CI pipeline",
        filesOrPath: ".github/workflows/pr-guards.yml",
      },
    },
    {
      id: "node-core",
      title: "packages/core",
      subtitle: "@ahkms/core (Kernel)",
      description: [
        "Single source of truth (absorbs shared):",
        "- Zod schemas & TypeScript types",
        "- Central Action Registry (CAR)",
        "- Exports: . /schemas /client",
      ],
      icon: "TS",
      iconBg: "#16a34a",
      x: 345,
      y: 215,
      width: 250,
      height: 120,
      variant: "success",
      details: {
        role: "Universal Domain Kernel & Action Registry",
        filesOrPath: "packages/core/src/index.ts",
        adrOrIssue: "ADR-100",
        notes: "Absorbs packages/shared into a unified, zero-server-leakage domain core.",
      },
    },
    {
      id: "node-mcp",
      title: "packages/mcp-server",
      subtitle: "Primary Serving Surface (CAR)",
      description: [
        "- Streamable HTTP + OAuth (Railway)",
        "- 30+ tools: capture, search, graph",
        "- Unit Tests: Vitest (src/**/*.test.ts)",
      ],
      icon: "MCP",
      iconBg: "#2563eb",
      x: 650,
      y: 215,
      width: 250,
      height: 120,
      variant: "primary",
      details: {
        role: "Primary tool & CAR action serving surface for ahOS",
        filesOrPath: "packages/mcp-server/src/server.ts",
        adrOrIssue: "ADR-096, ADR-100",
        notes: "Exposes capture, knowledge_search, entities, Notion, and Google integrations.",
      },
    },
    {
      id: "node-worker",
      title: "packages/worker",
      subtitle: "Express Ingress & Cadences",
      description: [
        "- Docker deploy on Railway",
        "- Upload & PDF processing routes",
        "- Background schedulers",
        "- Unit Tests: Jest",
      ],
      icon: "⚙️",
      iconBg: "#6d28d9",
      x: 930,
      y: 215,
      width: 200,
      height: 120,
      variant: "default",
      details: {
        role: "Background worker service",
        filesOrPath: "packages/worker/src/index.js",
        notes: "Scheduled for phased absorption into @ahkms/core under ADR-100.",
      },
    },
    {
      id: "node-web",
      title: "packages/web",
      subtitle: "Agent-Native Co-Editing SPA",
      description: [
        "- Vite + React 19 + Tailwind CSS",
        "- Unarchived under ADR-100",
        "- Interactive Knowledge Graph (/graph)",
        "- Direct CAR Action execution",
      ],
      icon: "🌐",
      iconBg: "#0284c7",
      x: 345,
      y: 380,
      width: 250,
      height: 120,
      variant: "primary",
      details: {
        role: "Agent-Native Co-Editing workspace and visual architecture canvas",
        filesOrPath: "packages/web/src/App.tsx",
        adrOrIssue: "ADR-100",
      },
    },
    {
      id: "node-migrations",
      title: "supabase/migrations/",
      subtitle: "PostgreSQL 15+ DDL SSOT",
      description: [
        "- 14-digit timestamps + _NNN_ sequence",
        "- Versioned by DROP+CREATE (no bare REPLACE)",
        "- Applied via PR -> supabase db push",
        "- Guarded by static linters",
      ],
      icon: "🗄️",
      iconBg: "#059669",
      x: 650,
      y: 380,
      width: 480,
      height: 120,
      variant: "default",
      details: {
        role: "Single write path for production database DDL",
        filesOrPath: "supabase/migrations/",
        notes: "Never use apply_migration directly from sessions.",
      },
    },
  ],
  lines: [
    {
      id: "l-claude-to-mcp",
      path: "M 220 145 L 650 250",
      color: "#2563eb",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-ide-to-mcp",
      path: "M 220 270 L 650 270",
      color: "#2563eb",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-core-to-mcp",
      path: "M 595 260 L 650 260",
      color: "#16a34a",
      width: 2.5,
    },
    {
      id: "l-core-to-web",
      path: "M 470 335 L 470 380",
      color: "#16a34a",
      width: 2,
    },
    {
      id: "l-core-to-migrations",
      path: "M 595 440 L 650 440",
      color: "#059669",
      width: 2,
    },
    {
      id: "l-guards-to-core",
      path: "M 570 170 L 470 215",
      color: "#475569",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-guards-to-migrations",
      path: "M 570 170 L 890 380",
      color: "#475569",
      width: 1.5,
      dashed: true,
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Monorepo Task Pipeline & Cache Keys",
      detail:
        "Turborepo orchestrates builds, tests, and linting. Each package declares explicit input globs to prevent false-pass cache replay bugs.",
    },
    {
      step: 2,
      title: "Zero-Database CI Guard Suite",
      detail:
        "Pre-commit and PR workflows execute check-signatures, check-collisions, and check-architecture-drift without requiring live database access.",
    },
    {
      step: 3,
      title: "Core Domain Kernel (@ahkms/core)",
      detail:
        "packages/core acts as the single source of truth for business logic, absorbing legacy shared and exposing typed subpaths for client surfaces.",
    },
    {
      step: 4,
      title: "CAR Ingress Surfaces",
      detail:
        "packages/mcp-server and packages/web consume @ahkms/core directly, ensuring unified validation, authorization, and audit logging across all touchpoints.",
    },
    {
      step: 5,
      title: "Database Migration Deployment",
      detail:
        "Database DDL follows the strict single write path: migrations commit to dev and deploy to production via PR and supabase db push.",
    },
  ],
};
