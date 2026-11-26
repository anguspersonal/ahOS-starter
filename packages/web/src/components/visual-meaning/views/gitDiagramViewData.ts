import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `flowchart TD
  %% STYLING
  classDef client fill:#f8fafc,stroke:#475569,stroke-width:2px,color:#0f172a;
  classDef action fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a;
  classDef cadence fill:#faf5ff,stroke:#9333ea,stroke-width:2px,color:#581c87;
  classDef ritual fill:#fffbeb,stroke:#d97706,stroke-width:2px,color:#78350f;
  classDef store fill:#f0fdf4,stroke:#16a34a,stroke-width:2px,color:#14532d;
  classDef external fill:#fef2f2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d;

  %% PATHWAY 1: DIRECT CAPTURE & EMBEDDING
  subgraph P1["Pathway 1: Direct Capture & Vectorization (ADR-018 / ADR-050 / ADR-088)"]
    direction LR
    OP_CAPTURE["Operator / Assistant<br/>(Claude Code, Web UI, Mobile)"]:::client
    ACT_CAPTURE["capture Action (@ahkms/core)<br/>Valid Time: originated_at<br/>Transaction Time: captured_at"]:::action
    VEC_EMBED["pgvector / Embedding<br/>1536-dim Vector + FTS tsvector"]:::action
    OP_CAPTURE -->|1a. Dumb Capture| ACT_CAPTURE
    ACT_CAPTURE -->|1b. Synchronous Embed| VEC_EMBED
  end

  %% PATHWAY 2: SCHEDULED DISCOVERY & ENRICHMENT
  subgraph P2["Pathway 2: Scheduled Discover & Budgeted Enrich (ADR-016 / ADR-081)"]
    direction LR
    SCHED["Scheduled Cadence<br/>(scheduler_locks / scheduler_runs)"]:::cadence
    ACT_DISCOVER["ingest_discover<br/>Polls Modified Timestamps<br/>Registers Discovered Pointers"]:::cadence
    ACT_ENRICH["ingest_enrich_next<br/>Budgeted Batch Fetch<br/>Extracts Full Text Payload"]:::cadence
    SCHED -->|2a. Incremental Scan| ACT_DISCOVER
    ACT_DISCOVER -.->|2b. Queued Pointers| ACT_ENRICH
  end

  %% STORAGE & KNOWLEDGE SUBSTRATE
  subgraph DATA_CORE["Knowledge Substrate & Relational Core (PostgreSQL 15+)"]
    direction TB
    TBL_ARTIFACTS[("artifacts Table<br/>Atoms · Content · Vectors · Surfaces")]:::store
    TBL_EXT_LINKS[("artifact_external_links<br/>Lineage · Lineage Keys · Synthesis Markers")]:::store
    TBL_ENTITIES[("entities & relationships<br/>Graph Nodes · sameAs · PARA Domain")]:::store
  end

  %% PATHWAY 3: END-OF-DAY SYNTHESIS (DOS RITUAL)
  subgraph P3["Pathway 3: End-of-Day Synthesis Ritual (ADR-050 / ADR-053 / ADR-054)"]
    direction LR
    DOS_QUEUE["dos_synthesis_coverage<br/>Unconsumed Atoms Window"]:::ritual
    DOS_CONFIRM["Human-in-the-Loop Review<br/>(Claude Interactive Session)"]:::ritual
    ACT_DAILY["daily_log_create<br/>Writes Daily Log Twin<br/>Stamps synthesized Marker"]:::ritual
    ACT_STATE["state_doc_update<br/>Projects Confirmed Changes<br/>into Notion State Doc"]:::ritual
    DOS_QUEUE -->|3a. Unconsumed Atoms| DOS_CONFIRM
    DOS_CONFIRM -->|3b. Confirmed Log| ACT_DAILY
    ACT_DAILY -->|3c. Sectional Projection| ACT_STATE
  end

  %% PATHWAY 4: HYBRID RETRIEVAL & CONTEXT PROJECTION
  subgraph P4["Pathway 4: Unified Hybrid Search & Context (ADR-047 / ADR-100)"]
    direction LR
    SEARCH_REQ["knowledge_search<br/>Natural Language Query"]:::action
    FUSED_RERANK["Hybrid Fusion (FTS + Vector)<br/>Reciprocal Rank Fusion<br/>Representation Guard"]:::action
    CTX_ASSEMBLE["Context Window Assembly<br/>Hydrated Atoms + Linked Graph"]:::action
    SEARCH_REQ -->|4a. Fan-out Query| FUSED_RERANK
    FUSED_RERANK -->|4b. Top-K Blended| CTX_ASSEMBLE
  end

  %% CROSS-PATHWAY DATA FLOWS
  ACT_CAPTURE ==>|Writes Atom| TBL_ARTIFACTS
  VEC_EMBED ==>|Writes Vector| TBL_ARTIFACTS
  ACT_ENRICH ==>|Hydrates Atom| TBL_ARTIFACTS
  ACT_ENRICH -.->|Registers External ID| TBL_EXT_LINKS

  TBL_ARTIFACTS ==>|Reads Unconsumed| DOS_QUEUE
  ACT_DAILY ==>|Persists Twin & Marker| TBL_EXT_LINKS
  ACT_DAILY ==>|Extracts/Links Nodes| TBL_ENTITIES

  TBL_ARTIFACTS <==>|Parallel Vector/FTS Scan| FUSED_RERANK
  TBL_ENTITIES <==>|Graph Neighbourhood Recall| FUSED_RERANK
  CTX_ASSEMBLE ==>|Grounded Prompt Context| OP_CAPTURE`;

export const gitDiagramViewData: ViewDefinition = {
  id: "gitdiagram",
  title: "View 4: Execution & Data Lifecycle Flow",
  subtitle:
    "The 4 real operational pathways: Direct Capture, Scheduled Discover/Enrich, End-of-Day 'dos' Ritual, and Hybrid Search",
  badge: {
    text: "Operational Lifecycles",
    color: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
  },
  summary:
    "Canonical operational data lifecycle mapping how knowledge enters via direct capture, scheduled cadences poll external SaaS, the end-of-day dos ritual synthesizes unconsumed atoms into Notion State Docs, and hybrid search fuses vector + full-text retrieval.",
  viewBox: "0 0 1180 660",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp_p1",
      title: "Pathway 1: Direct Capture & Vectorization",
      icon: "⚡",
      x: 20,
      y: 25,
      width: 360,
      height: 270,
      color: "#2563eb",
      bg: "#eff6ff",
      badge: "Real-Time Ingress",
    },
    {
      id: "grp_p2",
      title: "Pathway 2: Scheduled Discover & Enrich",
      icon: "⏰",
      x: 400,
      y: 25,
      width: 360,
      height: 270,
      color: "#9333ea",
      bg: "#faf5ff",
      badge: "Cadence Ingest",
    },
    {
      id: "grp_p3",
      title: "Pathway 3: End-of-Day Synthesis Ritual",
      icon: "📜",
      x: 780,
      y: 25,
      width: 380,
      height: 270,
      color: "#d97706",
      bg: "#fffbeb",
      badge: "dos Ritual",
    },
    {
      id: "grp_substrate",
      title: "Knowledge Substrate & Relational Core (PostgreSQL 15+)",
      icon: "🗄️",
      x: 20,
      y: 320,
      width: 740,
      height: 315,
      color: "#16a34a",
      bg: "#f0fdf4",
      badge: "Supabase Platform",
    },
    {
      id: "grp_p4",
      title: "Pathway 4: Hybrid Search & Context",
      icon: "🔍",
      x: 780,
      y: 320,
      width: 380,
      height: 315,
      color: "#0f766e",
      bg: "#f0fdfa",
      badge: "Retrieval",
    },
  ],
  nodes: [
    // Pathway 1 Nodes
    {
      id: "node_op_capture",
      title: "Operator / Assistant",
      subtitle: "Claude Code / Web / Mobile",
      icon: "👤",
      iconBg: "#2563eb",
      x: 35,
      y: 65,
      width: 155,
      height: 95,
      variant: "primary",
      stepBadge: 1,
      description: ["Captures notes & chats", "Immediate intake trigger"],
      details: {
        role: "Operator & AI Intake Surface",
        filesOrPath: "packages/mcp-server/src/tools/capture.ts",
        adrOrIssue: "ADR-018",
        notes: "Captures notes without blocking for multi-step LLM extraction.",
      },
    },
    {
      id: "node_act_capture",
      title: "capture Action",
      subtitle: "@ahkms/core Kernel",
      icon: "📥",
      iconBg: "#1d4ed8",
      x: 210,
      y: 65,
      width: 155,
      height: 95,
      variant: "primary",
      stepBadge: 1,
      description: ["Valid: originated_at", "Trans: captured_at"],
      details: {
        role: "Centralised Action Registry Ingress",
        adrOrIssue: "ADR-088",
        notes: "Separates valid time from transaction time per ADR-088.",
      },
    },
    {
      id: "node_vec_embed",
      title: "pgvector & tsvector",
      subtitle: "1536-dim Embedding + FTS",
      icon: "🧠",
      iconBg: "#0284c7",
      x: 120,
      y: 185,
      width: 170,
      height: 90,
      variant: "primary",
      description: ["OpenAI text-embedding-3-small", "GIN tsvector index tokens"],
      details: {
        role: "Synchronous Vector & Lexical Indexer",
        filesOrPath: "packages/mcp-server/src/embeddings.ts",
        adrOrIssue: "ADR-047",
      },
    },

    // Pathway 2 Nodes
    {
      id: "node_sched",
      title: "Scheduled Cadence",
      subtitle: "Single-flighted Locks",
      icon: "⏱️",
      iconBg: "#7e22ce",
      x: 415,
      y: 65,
      width: 155,
      height: 95,
      variant: "purple",
      stepBadge: 2,
      description: ["scheduler_locks mutex", "scheduler_runs log"],
      details: {
        role: "Background Cadence Orchestrator",
        adrOrIssue: "ADR-093",
      },
    },
    {
      id: "node_discover",
      title: "ingest_discover",
      subtitle: "Pointer Registration",
      icon: "🔎",
      iconBg: "#9333ea",
      x: 590,
      y: 65,
      width: 155,
      height: 95,
      variant: "purple",
      stepBadge: 2,
      description: ["Polls Google Drive/Gmail", "Zero heavy bytes fetch"],
      details: {
        role: "Phase 1 Ingestion: Pointer Discovery",
        adrOrIssue: "ADR-016",
        notes: "Cheaply stamps discovered status without consuming egress quotas.",
      },
    },
    {
      id: "node_enrich",
      title: "ingest_enrich_next",
      subtitle: "Budgeted Batch Ingest",
      icon: "📦",
      iconBg: "#6b21a8",
      x: 500,
      y: 185,
      width: 170,
      height: 90,
      variant: "purple",
      stepBadge: 2,
      description: ["Rate-limited payload fetch", "Hydrates content into atoms"],
      details: {
        role: "Phase 2 Ingestion: Content Enrichment",
        adrOrIssue: "ADR-016, ADR-081",
      },
    },

    // Pathway 3 Nodes (dos Ritual)
    {
      id: "node_dos_queue",
      title: "dos_synthesis_coverage",
      subtitle: "Unconsumed Atoms Queue",
      icon: "📋",
      iconBg: "#b45309",
      x: 795,
      y: 65,
      width: 165,
      height: 95,
      variant: "warning",
      stepBadge: 3,
      description: ["Inspects 24h day window", "Filters consumed_by_state"],
      details: {
        role: "Synthesis Coverage Inspection",
        adrOrIssue: "ADR-050, ADR-088",
      },
    },
    {
      id: "node_dos_confirm",
      title: "Operator Review",
      subtitle: "Claude Interactive Session",
      icon: "🤝",
      iconBg: "#d97706",
      x: 980,
      y: 65,
      width: 165,
      height: 95,
      variant: "warning",
      stepBadge: 4,
      description: ["Reviews candidate synthesis", "Confirms actions & logs"],
      details: {
        role: "Human-in-the-Loop Confirmation Gate",
        adrOrIssue: "AGENTS.md Rule 3",
      },
    },
    {
      id: "node_daily_twin",
      title: "daily_log_create",
      subtitle: "Daily Log Twin (Supabase)",
      icon: "📑",
      iconBg: "#b45309",
      x: 795,
      y: 185,
      width: 165,
      height: 90,
      variant: "warning",
      stepBadge: 5,
      description: ["Creates durable twin log", "Stamps synthesized marker"],
      details: {
        role: "Journal Twin Generator",
        adrOrIssue: "ADR-050, ADR-051",
      },
    },
    {
      id: "node_state_update",
      title: "state_doc_update",
      subtitle: "Notion State Doc Projection",
      icon: "🎯",
      iconBg: "#d97706",
      x: 980,
      y: 185,
      width: 165,
      height: 90,
      variant: "warning",
      stepBadge: 5,
      description: ["Replaces sections by heading", "Updates living source of record"],
      details: {
        role: "Living State Doc Projector",
        adrOrIssue: "ADR-053",
      },
    },

    // Knowledge Substrate (Storage Core)
    {
      id: "node_artifacts",
      title: "artifacts Table",
      subtitle: "Core Knowledge Atoms",
      icon: "📄",
      iconBg: "#15803d",
      x: 40,
      y: 360,
      width: 220,
      height: 110,
      variant: "success",
      description: [
        "- Raw & extracted text",
        "- Valid: effective_at",
        "- pgvector 1536-dim vectors",
      ],
      details: {
        role: "Primary Knowledge Substrate Table",
        notes: "Stores original captures, external drive files, and speech transcripts.",
      },
    },
    {
      id: "node_ext_links",
      title: "artifact_external_links",
      subtitle: "Lineage & Markers",
      icon: "🔗",
      iconBg: "#166534",
      x: 280,
      y: 360,
      width: 210,
      height: 110,
      variant: "success",
      description: [
        "- Upstream remote IDs",
        "- Unique dedup_key indices",
        "- synthesized marker flags",
      ],
      details: {
        role: "Durable Lineage & Dedup Registry",
        adrOrIssue: "ADR-050",
      },
    },
    {
      id: "node_entities",
      title: "entities & relationships",
      subtitle: "Semantic Graph Core",
      icon: "🕸️",
      iconBg: "#14532d",
      x: 510,
      y: 360,
      width: 230,
      height: 110,
      variant: "success",
      description: [
        "- PARAMPS node classes",
        "- Typed directional predicates",
        "- Hot fast-recall handshake tier",
      ],
      details: {
        role: "Canonical Knowledge Graph Nodes & Edges",
        adrOrIssue: "ADR-085, ADR-092",
      },
    },
    {
      id: "node_storage_details",
      title: "PostgreSQL 15+ Physical Storage",
      subtitle: "Supabase Hosted Substrate",
      icon: "🗄️",
      iconBg: "#059669",
      x: 40,
      y: 495,
      width: 700,
      height: 120,
      variant: "default",
      description: [
        "Foreign Keys: artifacts ↔ derived_artifacts, entities ↔ entity_relationships",
        "Indexes: HNSW vector index (cosine), GIN search_vector (english), B-tree timestamps",
        "Integrations: user_integrations, user_preferences, bindings, user_edits ledger",
      ],
      details: {
        role: "Physical Database Storage Substrate",
        notes: "View 6 in docs/architecture/architecture.md models the complete 35-table DDL schema.",
      },
    },

    // Pathway 4 Nodes (Hybrid Search)
    {
      id: "node_search",
      title: "knowledge_search",
      subtitle: "Natural Language Ingress",
      icon: "🔍",
      iconBg: "#0f766e",
      x: 800,
      y: 360,
      width: 165,
      height: 110,
      variant: "primary",
      stepBadge: 6,
      description: ["Parallel fan-out", "Semantic + lexical query"],
      details: {
        role: "Unified Knowledge Retrieval Entrypoint",
        adrOrIssue: "ADR-047",
      },
    },
    {
      id: "node_fused_rerank",
      title: "Reciprocal Rank Fusion",
      subtitle: "Hybrid Blending & Guard",
      icon: "⚖️",
      iconBg: "#115e59",
      x: 980,
      y: 360,
      width: 165,
      height: 110,
      variant: "primary",
      stepBadge: 6,
      description: ["Blends FTS & Vector scores", "Representation guard"],
      details: {
        role: "Hybrid Scoring Engine",
        adrOrIssue: "ADR-047, ADR-100",
        notes: "Guarantees exact entity matches are never buried under incidental text mentions.",
      },
    },
    {
      id: "node_ctx_assemble",
      title: "Context Assembly",
      subtitle: "LLM Prompt Grounding",
      icon: "💡",
      iconBg: "#134e4a",
      x: 890,
      y: 495,
      width: 175,
      height: 115,
      variant: "primary",
      description: ["Hydrates top-K atoms", "Traverses entity graph", "Returns grounded prompt"],
      details: {
        role: "Context Window Hydration",
        notes: "Feeds verified facts directly into Claude or the Web Co-Editing canvas.",
      },
    },
  ],
  lines: [
    // Pathway 1 lines
    {
      id: "line_op_to_capture",
      path: "M 190 110 L 210 110",
      color: "#2563eb",
      markerEnd: "url(#arch-arrow)",
      label: "1a. Dumb Capture",
    },
    {
      id: "line_capture_to_embed",
      path: "M 285 160 L 285 175 L 205 175 L 205 185",
      color: "#2563eb",
      markerEnd: "url(#arch-arrow)",
      label: "1b. Vectorize",
    },
    {
      id: "line_capture_to_artifacts",
      path: "M 285 160 L 285 310 L 150 310 L 150 360",
      color: "#2563eb",
      markerEnd: "url(#arch-arrow)",
      label: "writes atom",
    },

    // Pathway 2 lines
    {
      id: "line_sched_to_discover",
      path: "M 570 110 L 590 110",
      color: "#9333ea",
      markerEnd: "url(#arch-arrow)",
      label: "2a. Scan",
    },
    {
      id: "line_discover_to_enrich",
      path: "M 665 160 L 665 175 L 585 175 L 585 185",
      color: "#9333ea",
      dashed: true,
      markerEnd: "url(#arch-arrow)",
      label: "2b. Queued",
    },
    {
      id: "line_enrich_to_artifacts",
      path: "M 585 275 L 585 310 L 220 310 L 220 360",
      color: "#9333ea",
      markerEnd: "url(#arch-arrow)",
      label: "hydrates atom",
    },

    // Pathway 3 lines
    {
      id: "line_artifacts_to_dos_queue",
      path: "M 150 360 L 150 305 L 875 305 L 875 160",
      color: "#d97706",
      markerEnd: "url(#arch-arrow)",
      label: "3a. Unconsumed",
    },
    {
      id: "line_dos_queue_to_confirm",
      path: "M 960 110 L 980 110",
      color: "#d97706",
      markerEnd: "url(#arch-arrow)",
      label: "presents draft",
    },
    {
      id: "line_confirm_to_daily",
      path: "M 1060 160 L 1060 175 L 875 175 L 875 185",
      color: "#d97706",
      markerEnd: "url(#arch-arrow)",
      label: "3b. Confirmed",
    },
    {
      id: "line_daily_to_state",
      path: "M 960 230 L 980 230",
      color: "#d97706",
      markerEnd: "url(#arch-arrow)",
      label: "3c. Project",
    },
    {
      id: "line_daily_to_ext_links",
      path: "M 875 275 L 875 315 L 385 315 L 385 360",
      color: "#d97706",
      markerEnd: "url(#arch-arrow)",
      label: "synthesized marker",
    },

    // Pathway 4 lines
    {
      id: "line_search_to_fused",
      path: "M 965 415 L 980 415",
      color: "#0f766e",
      markerEnd: "url(#arch-arrow)",
      label: "4a. Fan-out",
    },
    {
      id: "line_fused_to_ctx",
      path: "M 1060 470 L 1060 485 L 980 485 L 980 495",
      color: "#0f766e",
      markerEnd: "url(#arch-arrow)",
      label: "4b. Blended Top-K",
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Direct Capture & Immediate Vectorization",
      detail:
        "The operator or AI assistant captures raw notes, voice memos, or snippets via the capture action. The atom is stored immediately in Supabase with valid/transaction timestamps, and 1536-dim vectors + tsvector tokens are generated synchronously (ADR-018, ADR-088).",
      sourceNode: "node_op_capture",
      targetNode: "node_artifacts",
    },
    {
      step: 2,
      title: "Scheduled Discovery & Budgeted Ingest",
      detail:
        "Scheduled cadences run under single-flighted mutex locks (scheduler_locks). Phase 1 (ingest_discover) polls modified timestamps in Google Drive and Gmail to cheaply register pointers. Phase 2 (ingest_enrich_next) fetches full file content under a metered rate-limit budget (ADR-016, ADR-081).",
      sourceNode: "node_sched",
      targetNode: "node_enrich",
    },
    {
      step: 3,
      title: "Unconsumed Atoms Coverage Inspection",
      detail:
        "The end-of-day dos ritual inspects unconsumed atoms via dos_synthesis_coverage. It queries the 24-hour day window by valid time (effective_at) and filters out atoms already marked by consumed_by_state (ADR-050, ADR-088).",
      sourceNode: "node_artifacts",
      targetNode: "node_dos_queue",
    },
    {
      step: 4,
      title: "Human-in-the-Loop Confirmation Gate",
      detail:
        "Operating strictly under repository rule #3 (Only the ritual writes Daily Log entries), Claude presents candidate syntheses and action decisions to Angus for review, confirmation, or manual correction.",
      sourceNode: "node_dos_queue",
      targetNode: "node_dos_confirm",
    },
    {
      step: 5,
      title: "Daily Log Twin & Notion State Doc Update",
      detail:
        "The ritual executes daily_log_create to store a durable journal twin in Supabase and stamps synthesized markers on artifact_external_links. It then executes state_doc_update to replace exact section headings in the Notion State Doc (ADR-051, ADR-053).",
      sourceNode: "node_daily_twin",
      targetNode: "node_state_update",
    },
    {
      step: 6,
      title: "Unified Hybrid Search & Context Assembly",
      detail:
        "When querying knowledge, knowledge_search fans out in parallel across full-text lexical indexes, HNSW cosine embeddings, and entity graph nodes. Reciprocal Rank Fusion blends the results with representation guards to ground LLM context windows (ADR-047, ADR-100).",
      sourceNode: "node_search",
      targetNode: "node_ctx_assemble",
    },
  ],
};
