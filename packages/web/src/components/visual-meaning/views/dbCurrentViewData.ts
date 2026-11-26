import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `erDiagram
  ARTIFACTS ||--o{ ARTIFACT_ENTITY_LINKS : "referenced in"
  ENTITIES ||--o{ ARTIFACT_ENTITY_LINKS : "linked to"

  ENTITIES ||--o{ ENTITY_RELATIONSHIPS : "from_entity"
  ENTITIES ||--o{ ENTITY_RELATIONSHIPS : "to_entity"

  ARTIFACTS ||--o{ ARTIFACT_EXTERNAL_LINKS : "lineage & markers"
  ARTIFACTS ||--o{ DERIVED_ARTIFACTS : "page/audio chunks"

  ARTIFACTS ||--o{ USER_TASKS : "generates task"
  ARTIFACTS ||--o{ EVENTS : "generates event"

  ENTITIES ||--o{ USER_PREFERENCES : "self_entity_id"
  ENTITIES ||--o{ USER_INTEGRATIONS : "domain_entity_id"
  ENTITIES ||--o{ BINDINGS : "domain_entity_id"

  ENTITIES ||--o{ USER_EDITS : "correction logged"
  ARTIFACTS ||--o{ USER_EDITS : "artifact corrected"

  ARTIFACTS {
    uuid id PK
    text surface "Capture Surface (Slack, Drive, Chat)"
    text content "Raw/Extracted Text"
    timestamptz effective_at "Valid Time (Originated/Captured)"
    vector embedding "1536-dim HNSW Semantic Vector"
    tsvector search_vector "Full-Text Index Tokens"
  }

  DERIVED_ARTIFACTS {
    uuid id PK
    uuid source_artifact_id FK
    text artifact_type "split_page | ocr | extracted_text"
    integer sequence_order
  }

  ARTIFACT_EXTERNAL_LINKS {
    uuid id PK
    uuid artifact_id FK
    text provider "notion | gdrive | slack"
    text kind "task | event | marker"
    text external_id
    text dedup_key
  }

  ENTITIES {
    uuid id PK
    text entity_type "person | org | place | concept | event"
    text title "Canonical Name"
    text domain_override "work | angus"
    boolean hot "MCP Handshake Tier (ADR-092)"
    jsonb properties "RDF / Schema Payload"
  }

  ENTITY_RELATIONSHIPS {
    uuid id PK
    uuid from_entity_id FK
    uuid to_entity_id FK
    text relationship_type "Directional Predicate"
    numeric confidence_score
    timestamptz valid_from
    timestamptz valid_to
  }

  ARTIFACT_ENTITY_LINKS {
    uuid id PK
    uuid artifact_id FK
    uuid entity_id FK
    text link_type "related | primary"
    numeric confidence_score
  }

  USER_EDITS {
    uuid id PK
    text edit_type "Correction Type"
    jsonb original_value
    jsonb corrected_value
  }

  USER_PREFERENCES {
    uuid id PK
    jsonb dos_config "Ritual Config & Tone"
    jsonb confidence_thresholds "Decision Bands"
  }`;

export const dbCurrentViewData: ViewDefinition = {
  id: "db-current",
  title: "View 5: Database Schema ERD (Simplified Conceptual Model)",
  subtitle:
    "Core domain entities: Knowledge Atoms, Semantic Graph Nodes, Action Tasks, Events, and Preferences.",
  badge: {
    text: "Conceptual Domain ERD",
    color: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
  },
  summary:
    "Distills the complex physical database down to the essential conceptual domain entities: artifacts (raw atoms), derived_artifacts (chunks), artifact_external_links (lineage), entities (graph nodes), entity_relationships (typed edges), user_tasks/events (action outputs), and user_preferences.",
  viewBox: "0 0 1180 640",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp-atoms-erd",
      title: "1. Knowledge Substrate (Atoms & Lineage)",
      icon: "📄",
      x: 25,
      y: 30,
      width: 275,
      height: 580,
      color: "#2563eb",
      bg: "#f8fafc",
    },
    {
      id: "grp-graph-erd",
      title: "2. Knowledge Graph (Entities & Edges)",
      icon: "🕸️",
      x: 320,
      y: 30,
      width: 295,
      height: 580,
      color: "#7c3aed",
      bg: "#faf5ff",
    },
    {
      id: "grp-actions-erd",
      title: "3. Actions, Tasks & Feedback Ledger",
      icon: "⚡",
      x: 635,
      y: 30,
      width: 255,
      height: 580,
      color: "#d97706",
      bg: "#fffbeb",
    },
    {
      id: "grp-config-erd",
      title: "4. Preferences, Integrations & Bindings",
      icon: "⚙️",
      x: 910,
      y: 30,
      width: 245,
      height: 580,
      color: "#059669",
      bg: "#f0fdf4",
    },
  ],
  nodes: [
    {
      id: "tbl-artifacts",
      title: "artifacts",
      subtitle: "Raw Knowledge Atoms",
      description: [
        "PK: id (uuid)",
        "surface, content, plain_text",
        "effective_at (valid time)",
        "embedding: vector(1536)",
        "search_vector: tsvector",
      ],
      icon: "📄",
      iconBg: "#2563eb",
      x: 45,
      y: 80,
      width: 235,
      height: 125,
      variant: "primary",
      stepBadge: 1,
      details: {
        role: "Universal capture substrate for notes, docs, emails, and transcripts",
        adrOrIssue: "ADR-018 / ADR-050 / ADR-088",
        notes: "Stores 1536-dim HNSW embeddings and full-text search tokens.",
      },
    },
    {
      id: "tbl-derived-artifacts",
      title: "derived_artifacts",
      subtitle: "Chunked Pages & Media",
      description: [
        "PK: id (uuid)",
        "FK: source_artifact_id",
        "artifact_type (page/ocr)",
        "sequence_order, page_number",
      ],
      icon: "📑",
      iconBg: "#1d4ed8",
      x: 45,
      y: 250,
      width: 235,
      height: 120,
      variant: "default",
      stepBadge: 2,
      details: {
        role: "Derived children: PDF pages, OCR text, speech audio segments",
      },
    },
    {
      id: "tbl-external-links",
      title: "artifact_external_links",
      subtitle: "Lineage & Synthesis Markers",
      description: [
        "PK: id (uuid)",
        "FK: artifact_id -> artifacts",
        "provider, kind, external_id",
        "unique index: dedup_key",
      ],
      icon: "🔗",
      iconBg: "#0d9488",
      x: 45,
      y: 420,
      width: 235,
      height: 120,
      variant: "default",
      stepBadge: 3,
      details: {
        role: "Maintains cross-store pointers and synthesis marker stamps",
        adrOrIssue: "ADR-050 / ADR-061",
      },
    },
    {
      id: "tbl-entities",
      title: "entities",
      subtitle: "Canonical Graph Nodes",
      description: [
        "PK: id (uuid)",
        "entity_type: PARAMPS classes",
        "domain_override (work/angus)",
        "hot (MCP fast-recall flag)",
        "embedding: vector(1536)",
      ],
      icon: "🕸️",
      iconBg: "#7c3aed",
      x: 340,
      y: 80,
      width: 255,
      height: 125,
      variant: "purple",
      stepBadge: 4,
      details: {
        role: "Canonical nodes of the knowledge graph",
        adrOrIssue: "ADR-084 / ADR-085 / ADR-092",
      },
    },
    {
      id: "tbl-entity-rel",
      title: "entity_relationships",
      subtitle: "Directional Semantic Edges",
      description: [
        "PK: id (uuid)",
        "FK: from_entity_id -> entities",
        "FK: to_entity_id -> entities",
        "relationship_type, confidence",
        "valid_from, valid_to",
      ],
      icon: "↔️",
      iconBg: "#6366f1",
      x: 340,
      y: 250,
      width: 255,
      height: 120,
      variant: "purple",
      stepBadge: 5,
      details: {
        role: "Directional predicate edges with temporal validity windows",
      },
    },
    {
      id: "tbl-art-entity-links",
      title: "artifact_entity_links",
      subtitle: "Fused Search Junction",
      description: [
        "PK: id (uuid)",
        "FK: artifact_id -> artifacts",
        "FK: entity_id -> entities",
        "link_type (primary/related)",
        "confidence_score",
      ],
      icon: "🔀",
      iconBg: "#8b5cf6",
      x: 340,
      y: 420,
      width: 255,
      height: 120,
      variant: "purple",
      stepBadge: 6,
      details: {
        role: "Many-to-many junction connecting raw atoms to graph nodes",
        adrOrIssue: "ADR-047",
      },
    },
    {
      id: "tbl-user-tasks",
      title: "user_tasks",
      subtitle: "Action Tasks",
      description: [
        "PK: id (uuid)",
        "FK: source_artifact_id",
        "FK: entity_id",
        "title, status, priority, due_date",
      ],
      icon: "✓",
      iconBg: "#d97706",
      x: 650,
      y: 80,
      width: 225,
      height: 125,
      variant: "warning",
      details: {
        role: "Extracted action items and project tasks",
      },
    },
    {
      id: "tbl-events",
      title: "events",
      subtitle: "Calendar & Deadlines",
      description: [
        "PK: id (uuid)",
        "FK: source_artifact_id",
        "FK: entity_id",
        "event_type, start_time, end_time",
      ],
      icon: "📅",
      iconBg: "#b45309",
      x: 650,
      y: 250,
      width: 225,
      height: 120,
      variant: "warning",
      details: {
        role: "Calendar meetings, deadlines, and reminders",
      },
    },
    {
      id: "tbl-user-edits",
      title: "user_edits",
      subtitle: "Correction Ledger",
      description: [
        "PK: id (uuid)",
        "FK: artifact_id, entity_id",
        "edit_type, original_value",
        "corrected_value, confidence",
      ],
      icon: "✏️",
      iconBg: "#92400e",
      x: 650,
      y: 420,
      width: 225,
      height: 120,
      variant: "warning",
      details: {
        role: "Durable audit log of human operator corrections for active learning",
      },
    },
    {
      id: "tbl-preferences",
      title: "user_preferences",
      subtitle: "Operator Configuration",
      description: [
        "PK: id (uuid)",
        "FK: self_entity_id -> entities",
        "user_mode, automation_level",
        "dos_config (ritual tone/rules)",
        "confidence_thresholds",
      ],
      icon: "⚙️",
      iconBg: "#059669",
      x: 925,
      y: 80,
      width: 215,
      height: 125,
      variant: "success",
      details: {
        role: "Stores operator preferences, daily ritual rules, and thresholds",
      },
    },
    {
      id: "tbl-integrations",
      title: "user_integrations",
      subtitle: "Connected SaaS Config",
      description: [
        "PK: id (uuid)",
        "FK: domain_entity_id -> entities",
        "provider, routing, status",
        "credential_ref (vault pointer)",
      ],
      icon: "🔌",
      iconBg: "#047857",
      x: 925,
      y: 250,
      width: 215,
      height: 120,
      variant: "success",
      details: {
        role: "Maintains active provider connections and credentials",
      },
    },
    {
      id: "tbl-bindings",
      title: "bindings",
      subtitle: "Dynamic Named References",
      description: [
        "PK: id (uuid)",
        "FK: domain_entity_id -> entities",
        "name, target_kind, target_ref",
      ],
      icon: "🏷️",
      iconBg: "#065f46",
      x: 925,
      y: 420,
      width: 215,
      height: 120,
      variant: "success",
      details: {
        role: "Named references resolved at serve time scoped by identity",
        adrOrIssue: "Issue #62",
      },
    },
  ],
  lines: [
    {
      id: "l-art-to-derived",
      path: "M 160 205 L 160 250",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-art-to-ext",
      path: "M 160 370 L 160 420",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-art-to-junction",
      path: "M 280 140 L 340 460",
      color: "#8b5cf6",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-ent-to-junction",
      path: "M 467 205 L 467 420",
      color: "#8b5cf6",
      width: 1.5,
    },
    {
      id: "l-ent-to-rel",
      path: "M 467 205 L 467 250",
      color: "#7c3aed",
      width: 2,
    },
    {
      id: "l-art-to-tasks",
      path: "M 280 140 L 650 140",
      color: "#d97706",
      width: 1.5,
    },
    {
      id: "l-art-to-events",
      path: "M 280 160 L 650 300",
      color: "#d97706",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-ent-to-pref",
      path: "M 595 140 L 925 140",
      color: "#059669",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-ent-to-int",
      path: "M 595 160 L 925 300",
      color: "#059669",
      width: 1.5,
      dashed: true,
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Knowledge Atoms & Media Ingress",
      detail:
        "Raw documents, notes, and transcripts are recorded in artifacts, generating 1536-dim embeddings. Derived child chunks (pages, OCR text) link via derived_artifacts.",
    },
    {
      step: 2,
      title: "External Surface Lineage",
      detail:
        "artifact_external_links maintains idempotency via unique dedup_key indices and holds synthesized marker stamps produced by the daily dos ritual.",
    },
    {
      step: 3,
      title: "Canonical Knowledge Graph",
      detail:
        "entities stores graph nodes categorized by PARAMPS classes with domain_override flags. Typed directional predicates link nodes via entity_relationships.",
    },
    {
      step: 4,
      title: "Action Generation & Operator Feedback",
      detail:
        "Atoms generate actionable tasks and calendar events. When the operator makes adjustments, user_edits records the correction delta.",
    },
    {
      step: 5,
      title: "Preferences, Integrations & Bindings",
      detail:
        "user_preferences stores the dos ritual rules, user_integrations manages OAuth credentials, and bindings provides runtime named references.",
    },
  ],
};
