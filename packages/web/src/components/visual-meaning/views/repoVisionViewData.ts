import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `flowchart TD
  %% STYLING
  classDef kernel fill:#dcfce7,stroke:#16a34a,stroke-width:3px,color:#14532d;
  classDef adapter fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a;
  classDef connector fill:#faf5ff,stroke:#9333ea,stroke-width:2px,color:#581c87;
  classDef client fill:#fffbeb,stroke:#d97706,stroke-width:2px,color:#78350f;
  classDef testgate fill:#f1f5f9,stroke:#475569,stroke-width:2px,color:#0f172a;

  %% 1. CORE DOMAIN KERNEL (HEXAGON)
  subgraph S_CORE["1. Core Domain Kernel: @ahkms/core (Hexagon SSOT)"]
    direction TB
    CORE_KERNEL["@ahkms/core (Kernel)<br/>Central Action Registry (CAR) · Universal Dispatcher<br/>Action Implementations · Audit Ledger · Domain Rules"]:::kernel
    CORE_SCHEMAS["@ahkms/core/schemas & /client<br/>Isomorphic Zod Schemas · Action Contracts · Typed ActionClient"]:::kernel
    CORE_KERNEL --- CORE_SCHEMAS
  end

  %% 2. INGRESS ADAPTERS (DRIVING PORTS)
  subgraph S_ADAPTERS["2. Driving Ingress Adapters & Gateways"]
    direction LR
    ADP_HTTP["@ahkms/gateway-http<br/>POST /api/actions/:id · SSE Streams<br/>(Action Adapter for UI Clients)"]:::adapter
    ADP_MCP["packages/mcp-server<br/>Stateless Streamable HTTP / stdio<br/>(Pure MCP Protocol Adapter)"]:::adapter
  end

  %% 3. MODULAR PLUGGABLE CONNECTORS
  subgraph S_CONNECTORS["3. Pluggable Outbound Connectors & Engines"]
    direction LR
    CONN_GOOGLE["@ahkms/connector-google<br/>Drive · Gmail · Calendar<br/>Multi-Account Token Lifecycle"]:::connector
    CONN_CRM["@ahkms/connector-crm<br/>Dex CRM · Notion · Brevo"]:::connector
    CONN_GRAPH["@ahkms/kms-graph<br/>sameAs Dedup (#310) · RDF 1.2 Export"]:::connector
    CONN_SYNTH["@ahkms/kms-synthesis<br/>dos Ritual Engine · State Doc Projections"]:::connector
  end

  %% 4. CO-EDITING CLIENT SURFACES
  subgraph S_CLIENTS["4. Co-Editing Client Surfaces"]
    direction LR
    CLI_WEB["@ahkms/web (NOW)<br/>Agent-Native Co-Editing SPA<br/>Knowledge Graph Canvas"]:::client
    CLI_MOBILE["@ahkms/mobile (NEXT)<br/>Offline-First SQLite Cache<br/>Quick Capture & Transcripts"]:::client
    CLI_DESKTOP["@ahkms/desktop (FUTURE)<br/>Local-First Vault Node<br/>On-Device Ollama Execution"]:::client
  end

  %% 5. VERIFICATION & CI TEST HARNESS
  subgraph S_GATES["5. Verification & Test Harness"]
    direction LR
    GATE_DB["Real-DB Test Harness (#397)<br/>Containerized PostgreSQL in CI<br/>Non-mocked RPC Assertions"]:::testgate
    GATE_RDF["Ontology Seed Shredder (#1141)<br/>PyOxigraph RDF 1.2 Annotation Parser"]:::testgate
  end

  %% RELATIONSHIPS
  CLI_WEB ==>|Typed Action Invocations| ADP_HTTP
  CLI_MOBILE ==>|Queued Action Sync| ADP_HTTP
  CLI_DESKTOP ==>|Direct Domain Core| CORE_KERNEL

  ADP_HTTP ==>|Dispatches Actions| CORE_KERNEL
  ADP_MCP ==>|Executes Tools| CORE_KERNEL

  CORE_KERNEL ==>|Delegates External Calls| S_CONNECTORS
  CORE_SCHEMAS -.->|Type Safety & Validation| S_CLIENTS

  GATE_DB -.->|Validates Stored Procedures| CORE_KERNEL
  GATE_RDF -.->|Validates Graph Ontology| CONN_GRAPH`;

export const repoVisionViewData: ViewDefinition = {
  id: "repo-vision",
  title: "View 3: Modular Toolpacks & Target Evolution Roadmap",
  subtitle:
    "Pluggable connectors (@ahkms/connector-*), multi-surface clients (Web, Mobile, Desktop), and @ahkms/core domain kernel.",
  badge: {
    text: "Target Evolution Roadmap",
    color: "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30",
  },
  summary:
    "Deconstructs the monolithic MCP server into pluggable connector packages, unifies domain execution under @ahkms/core, retires legacy packages/worker, and introduces a real-DB test harness in CI.",
  viewBox: "0 0 1180 640",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp-core-kernel",
      title: "Core Domain Kernel (@ahkms/core)",
      icon: "TS",
      x: 25,
      y: 30,
      width: 250,
      height: 580,
      color: "#16a34a",
      bg: "#f0fdf4",
    },
    {
      id: "grp-ingress-adapters",
      title: "Ingress Adapters & Gateways",
      icon: "⚡",
      x: 295,
      y: 30,
      width: 260,
      height: 580,
      color: "#2563eb",
      bg: "#eff6ff",
    },
    {
      id: "grp-modular-connectors",
      title: "Modular Pluggable Connectors",
      icon: "🔌",
      x: 575,
      y: 30,
      width: 290,
      height: 580,
      color: "#9333ea",
      bg: "#faf5ff",
    },
    {
      id: "grp-clients-roadmap",
      title: "Co-Editing Clients & Verification Gates",
      icon: "📱",
      x: 885,
      y: 30,
      width: 270,
      height: 580,
      color: "#d97706",
      bg: "#fffbeb",
    },
  ],
  nodes: [
    {
      id: "node-core-engine",
      title: "@ahkms/core (Engine)",
      subtitle: "Universal Domain Kernel",
      description: [
        "- Central Action Registry (CAR)",
        "- In-memory execution dispatcher",
        "- Audit logging & correction ledger",
        "- Domain rules & PARA validation",
      ],
      icon: "TS",
      iconBg: "#16a34a",
      x: 40,
      y: 85,
      width: 220,
      height: 180,
      variant: "success",
      details: {
        role: "Universal Domain Kernel",
        filesOrPath: "packages/core/src/engine.ts",
        adrOrIssue: "ADR-100",
        notes: "Absorbs legacy shared and unifies action execution.",
      },
    },
    {
      id: "node-core-schemas",
      title: "@ahkms/core/schemas",
      subtitle: "Isomorphic Action Contracts",
      description: [
        "- Zod runtime validation",
        "- TypeScript infer types",
        "- Zero server dependency leakage",
        "- Typed ActionClient wrapper",
      ],
      icon: "📜",
      iconBg: "#15803d",
      x: 40,
      y: 295,
      width: 220,
      height: 180,
      variant: "success",
      details: {
        role: "Client-safe Schema Subpath",
        filesOrPath: "packages/core/src/schemas/index.ts",
      },
    },
    {
      id: "node-gateway-http",
      title: "@ahkms/gateway-http",
      subtitle: "REST / SSE Action Gateway",
      description: [
        "- POST /api/actions/:id",
        "- SSE streamable events",
        "- Supabase JWT AuthGate",
        "- Direct browser co-editing",
      ],
      icon: "🌐",
      iconBg: "#2563eb",
      x: 310,
      y: 85,
      width: 230,
      height: 180,
      variant: "primary",
      details: {
        role: "Action Gateway for Web and Mobile clients",
      },
    },
    {
      id: "node-mcp-adapter",
      title: "packages/mcp-server",
      subtitle: "Pure MCP Protocol Adapter",
      description: [
        "- Translates MCP tools to CAR actions",
        "- Streamable HTTP + stdio",
        "- Dynamic capability loader",
        "- Decoupled from direct SQL writes",
      ],
      icon: "MCP",
      iconBg: "#1d4ed8",
      x: 310,
      y: 295,
      width: 230,
      height: 180,
      variant: "primary",
      details: {
        role: "Stateless MCP protocol adapter",
      },
    },
    {
      id: "node-conn-google",
      title: "@ahkms/connector-google",
      subtitle: "Workspace Integrations",
      description: [
        "- Drive incremental discovery & enrich",
        "- Gmail threads & reconciliation",
        "- Calendar events sync",
        "- Multi-account token lifecycle",
      ],
      icon: "G",
      iconBg: "#9333ea",
      x: 590,
      y: 85,
      width: 260,
      height: 110,
      variant: "purple",
      details: {
        role: "Google Workspace connector toolpack",
        adrOrIssue: "ADR-081",
      },
    },
    {
      id: "node-conn-crm",
      title: "@ahkms/connector-crm",
      subtitle: "External Systems of Record",
      description: [
        "- Dex CRM contact sync & proxy",
        "- Notion State Docs & canonical Tasks DB",
        "- Brevo marketing & email logs",
      ],
      icon: "💼",
      iconBg: "#7e22ce",
      x: 590,
      y: 215,
      width: 260,
      height: 110,
      variant: "purple",
      details: {
        role: "CRM and Notion connector toolpack",
      },
    },
    {
      id: "node-conn-graph",
      title: "@ahkms/kms-graph",
      subtitle: "Semantic Graph Engine",
      description: [
        "- Entity extraction & sameAs dedup (#310)",
        "- RDF 1.2 Turtle export (#1141)",
        "- Hot fast-recall tier management",
      ],
      icon: "🕸️",
      iconBg: "#6b21a8",
      x: 590,
      y: 345,
      width: 260,
      height: 110,
      variant: "purple",
      details: {
        role: "Graph derivation and ontology toolpack",
        adrOrIssue: "ADR-085, ADR-092",
      },
    },
    {
      id: "node-conn-synth",
      title: "@ahkms/kms-synthesis",
      subtitle: "dos Ritual Engine",
      description: [
        "- Unconsumed atoms detection",
        "- Candidate summary generation",
        "- Sectional heading replace in Notion",
      ],
      icon: "📜",
      iconBg: "#581c87",
      x: 590,
      y: 475,
      width: 260,
      height: 110,
      variant: "purple",
      details: {
        role: "End-of-day synthesis engine",
        adrOrIssue: "ADR-050, ADR-053",
      },
    },
    {
      id: "node-cli-web",
      title: "@ahkms/web (NOW)",
      subtitle: "Agent-Native Co-Editing SPA",
      description: [
        "- Vite + React 19 + Tailwind CSS",
        "- Interactive Knowledge Graph Canvas",
        "- Live action execution and verification",
      ],
      icon: "🌐",
      iconBg: "#d97706",
      x: 900,
      y: 85,
      width: 240,
      height: 110,
      variant: "warning",
      details: {
        role: "Current active web workspace",
        adrOrIssue: "ADR-100",
      },
    },
    {
      id: "node-cli-mobile",
      title: "@ahkms/mobile (NEXT)",
      subtitle: "Offline-First Mobile Companion",
      description: [
        "- Expo React Native baseline",
        "- Local SQLite cache for quick capture",
        "- Background sync when connectivity returns",
      ],
      icon: "📱",
      iconBg: "#b45309",
      x: 900,
      y: 215,
      width: 240,
      height: 110,
      variant: "warning",
      details: {
        role: "Next-generation mobile companion",
        adrOrIssue: "ADR-010",
      },
    },
    {
      id: "node-gate-db",
      title: "Real-DB Test Harness (#397)",
      subtitle: "CI Stored Procedure Verification",
      description: [
        "- Containerized PostgreSQL in CI",
        "- Non-mocked RPC test coverage",
        "- Prevents DROP+CREATE overload regressions",
      ],
      icon: "🛡️",
      iconBg: "#475569",
      x: 900,
      y: 345,
      width: 240,
      height: 110,
      variant: "default",
      details: {
        role: "Non-mocked database testing gate",
        adrOrIssue: "#397",
      },
    },
    {
      id: "node-gate-rdf",
      title: "Ontology Seed Shredder (#1141)",
      subtitle: "RDF 1.2 Annotation Parser",
      description: [
        "- PyOxigraph RDF parser in Python",
        "- Validates {| ... |} edge annotations",
        "- Prevents ontology drift on ingestion",
      ],
      icon: "🧪",
      iconBg: "#334155",
      x: 900,
      y: 475,
      width: 240,
      height: 110,
      variant: "default",
      details: {
        role: "Ontology seed validator",
        adrOrIssue: "#1141",
      },
    },
  ],
  lines: [
    {
      id: "l-web-to-gateway",
      path: "M 900 140 L 540 140",
      color: "#d97706",
      width: 2,
    },
    {
      id: "l-mobile-to-gateway",
      path: "M 900 270 L 540 170",
      color: "#d97706",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-gateway-to-core",
      path: "M 310 140 L 260 140",
      color: "#2563eb",
      width: 2.5,
    },
    {
      id: "l-mcp-to-core",
      path: "M 310 350 L 260 350",
      color: "#2563eb",
      width: 2.5,
    },
    {
      id: "l-core-to-google",
      path: "M 260 180 L 590 140",
      color: "#16a34a",
      width: 2,
    },
    {
      id: "l-core-to-crm",
      path: "M 260 200 L 590 270",
      color: "#16a34a",
      width: 2,
    },
    {
      id: "l-core-to-graph",
      path: "M 260 220 L 590 400",
      color: "#16a34a",
      width: 2,
    },
    {
      id: "l-core-to-synth",
      path: "M 260 240 L 590 530",
      color: "#16a34a",
      width: 2,
    },
    {
      id: "l-dbgate-to-core",
      path: "M 900 400 L 260 230",
      color: "#475569",
      width: 1.5,
      dashed: true,
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Universal Domain Kernel (@ahkms/core)",
      detail:
        "Business logic, Zod contracts, and action executions are centralized in @ahkms/core, eliminating code duplication and ensuring identical validation across all surfaces.",
    },
    {
      step: 2,
      title: "Decoupled Ingress Adapters",
      detail:
        "The MCP server becomes a lightweight protocol adapter, while @ahkms/gateway-http provides REST and SSE endpoints for browser and mobile co-editing clients.",
    },
    {
      step: 3,
      title: "Pluggable Outbound Connectors",
      detail:
        "Integrations for Google Workspace, CRMs, graph algorithms, and the dos synthesis ritual are split into isolated packages to compartmentalize dependencies and token lifecycles.",
    },
    {
      step: 4,
      title: "Multi-Surface Co-Editing",
      detail:
        "The web application (active today) is joined by an offline-first mobile companion and eventual local desktop vault node, all sharing isomorphic action contracts.",
    },
    {
      step: 5,
      title: "Hermetic Verification Gates",
      detail:
        "CI gains non-mocked database testing against containerized PostgreSQL to guarantee stored procedure signatures never collide, paired with PyOxigraph RDF 1.2 ontology validation.",
    },
  ],
};
