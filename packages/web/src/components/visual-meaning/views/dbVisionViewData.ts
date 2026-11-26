import type { ViewDefinition } from "../types.js";

const RAW_MERMAID = `erDiagram
  %% MULTI-TENANCY & USERS
  USERS ||--o{ WORKFLOWS : "user_id"
  TEAMS ||--o{ WORKFLOWS : "team_id"
  TEAMS ||--o{ TEAM_MEMBERS : "team_id"
  USERS ||--o{ TEAM_MEMBERS : "user_id"
  USERS ||--o{ USER_PREFERENCES : "user_id"
  TEAMS ||--o{ USER_PREFERENCES : "team_id"
  USERS ||--o{ USER_INTEGRATIONS : "user_id"
  TEAMS ||--o{ USER_INTEGRATIONS : "team_id"
  USERS ||--o{ BINDINGS : "user_id"
  TEAMS ||--o{ BINDINGS : "team_id"

  %% WORKFLOWS & STEPS
  WORKFLOWS ||--o{ WORKFLOW_STEPS : "workflow_id"
  WORKFLOWS ||--o{ ARTIFACTS : "workflow_run_id"
  WORKFLOWS ||--o{ TRAINING_EXAMPLES : "source_workflow_run_id"
  WORKFLOW_STEPS ||--o{ TRAINING_EXAMPLES : "source_task_id"
  WORKFLOW_STEPS ||--o{ SYSTEM_DECISIONS : "workflow_step_id"
  TRAINING_EXAMPLES ||--o{ TRAINING_EXAMPLES : "superseded_by"

  %% ARTIFACTS & LINEAGE
  ARTIFACTS ||--o{ ARTIFACTS : "previous_version_id"
  ARTIFACTS ||--o{ DERIVED_ARTIFACTS : "source_artifact_id"
  ARTIFACTS ||--o{ ARTIFACT_EXTERNAL_LINKS : "artifact_id"
  ARTIFACTS ||--o{ ARTIFACT_ENTITY_LINKS : "artifact_id"
  ARTIFACTS ||--o{ ARTIFACT_EDIT_LOG : "artifact_id"
  ARTIFACTS ||--o{ USER_TASKS : "source_artifact_id"
  ARTIFACTS ||--o{ EVENTS : "source_artifact_id"
  ARTIFACTS ||--o{ USER_EDITS : "artifact_id"

  %% KNOWLEDGE GRAPH
  ENTITIES ||--o{ ARTIFACT_ENTITY_LINKS : "entity_id"
  ENTITIES ||--o{ ENTITY_RELATIONSHIPS : "from_entity_id"
  ENTITIES ||--o{ ENTITY_RELATIONSHIPS : "to_entity_id"
  ENTITIES ||--o{ USER_TASKS : "entity_id"
  ENTITIES ||--o{ EVENTS : "entity_id"
  ENTITIES ||--o{ USER_EDITS : "entity_id"
  ENTITIES ||--o{ USER_PREFERENCES : "self_entity_id"
  ENTITIES ||--o{ USER_INTEGRATIONS : "domain_entity_id"
  ENTITIES ||--o{ BINDINGS : "domain_entity_id"

  %% CADENCES & RUNS
  SCHEDULER_LOCKS ||--o{ SCHEDULER_RUNS : "lock_name"

  %% PHYSICAL SCHEMAS
  WORKFLOWS {
    uuid id PK
    text workflow_type
    text status
    uuid user_id FK
    uuid team_id FK
    uuid source_artifact_id FK
    jsonb metadata
    timestamptz started_at
    timestamptz completed_at
  }

  WORKFLOW_STEPS {
    bigint id PK
    uuid workflow_id FK
    text step_name
    text step_type
    text status
    jsonb input
    jsonb output
  }

  ARTIFACTS {
    uuid id PK
    uuid user_id FK
    uuid team_id FK
    uuid workflow_run_id FK
    uuid previous_version_id FK
    text filename
    text surface
    text plain_text
    timestamptz originated_at
    timestamptz effective_at
    timestamptz captured_at
    vector embedding "1536-dim HNSW"
    tsvector search_vector "Full-text index"
  }

  DERIVED_ARTIFACTS {
    uuid id PK
    uuid source_artifact_id FK
    uuid user_id FK
    uuid team_id FK
    text artifact_type
    integer sequence_order
    integer page_number
  }

  ENTITIES {
    uuid id PK
    uuid user_id FK
    uuid team_id FK
    text entity_type
    text title
    text domain_override
    boolean hot
    vector embedding "1536-dim vector"
    jsonb properties
  }

  ENTITY_RELATIONSHIPS {
    uuid id PK
    uuid from_entity_id FK
    uuid to_entity_id FK
    text relationship_type
    numeric confidence_score
    timestamptz valid_from
    timestamptz valid_to
  }

  ARTIFACT_ENTITY_LINKS {
    uuid id PK
    uuid artifact_id FK
    uuid entity_id FK
    text link_type
    numeric confidence_score
  }

  ARTIFACT_EXTERNAL_LINKS {
    uuid id PK
    uuid artifact_id FK
    text provider
    text kind
    text external_id
    text dedup_key
  }

  SCHEDULER_RUNS {
    uuid id PK
    text job_name
    text status
    timestamptz started_at
    timestamptz completed_at
    jsonb result
  }

  SCHEDULER_LOCKS {
    text lock_name PK
    timestamptz locked_at
    timestamptz expires_at
    text locked_by
  }`;

export const dbVisionViewData: ViewDefinition = {
  id: "db-vision",
  title: "View 6: Database Schema ERD (Actual PostgreSQL Storage Substrate)",
  subtitle:
    "Physical 35-table PostgreSQL schema: Knowledge Atoms, Graph Core, Workflows, Multi-Tenancy & Integrations.",
  badge: {
    text: "Physical PostgreSQL Schema",
    color: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  },
  summary:
    "Complete structural mapping of the live 35-table production database schema. Shows real table relationships, foreign key constraints, transitional workflow pipelines, multi-tenancy models, and scheduler mutex locks.",
  viewBox: "0 0 1180 640",
  rawMermaid: RAW_MERMAID,
  groups: [
    {
      id: "grp-knowledge-core",
      title: "1. Knowledge Substrate & Lineage",
      icon: "📄",
      x: 20,
      y: 30,
      width: 275,
      height: 580,
      color: "#2563eb",
      bg: "#eff6ff",
    },
    {
      id: "grp-graph-core",
      title: "2. Knowledge Graph & Bindings",
      icon: "🕸️",
      x: 310,
      y: 30,
      width: 275,
      height: 580,
      color: "#7c3aed",
      bg: "#faf5ff",
    },
    {
      id: "grp-workflows",
      title: "3. Workflows, Steps & Learning",
      icon: "⚙️",
      x: 600,
      y: 30,
      width: 275,
      height: 580,
      color: "#d97706",
      bg: "#fffbeb",
    },
    {
      id: "grp-platform",
      title: "4. Multi-Tenancy, Config & Schedulers",
      icon: "🏢",
      x: 890,
      y: 30,
      width: 275,
      height: 580,
      color: "#059669",
      bg: "#f0fdf4",
    },
  ],
  nodes: [
    {
      id: "node-tbl-artifacts",
      title: "artifacts (35 cols)",
      subtitle: "Universal Knowledge Ingress",
      description: [
        "PK: id (uuid)",
        "FK: user_id, team_id, workflow_run_id",
        "surface, plain_text, content_html",
        "embedding: vector(1536)",
        "search_vector: tsvector",
      ],
      icon: "📄",
      iconBg: "#2563eb",
      x: 35,
      y: 80,
      width: 245,
      height: 125,
      variant: "primary",
      details: {
        role: "Primary raw data substrate with HNSW vector index and full-text search",
        notes: "Wide table storing original files, transcripts, emails, and external webhooks.",
      },
    },
    {
      id: "node-tbl-derived",
      title: "derived_artifacts",
      subtitle: "Extracted Sub-Artifacts",
      description: [
        "PK: id (uuid)",
        "FK: source_artifact_id -> artifacts",
        "artifact_type, sequence_order",
        "storage_bucket, storage_path",
      ],
      icon: "📑",
      iconBg: "#1d4ed8",
      x: 35,
      y: 230,
      width: 245,
      height: 105,
      variant: "default",
      details: {
        role: "Stores split PDF pages, OCR text, and segmented transcripts.",
      },
    },
    {
      id: "node-tbl-ext-links",
      title: "artifact_external_links",
      subtitle: "Lineage Pointers & Dedup",
      description: [
        "PK: id (uuid)",
        "FK: artifact_id -> artifacts",
        "provider, kind, external_id",
        "unique index: dedup_key",
      ],
      icon: "🔗",
      iconBg: "#0284c7",
      x: 35,
      y: 360,
      width: 245,
      height: 105,
      variant: "default",
      details: {
        role: "Preserves remote IDs and carries synthesized marker stamps from the ritual.",
      },
    },
    {
      id: "node-tbl-art-edit-log",
      title: "artifact_edit_log",
      subtitle: "Append-Only Mutation Log",
      description: [
        "PK: id (uuid)",
        "FK: artifact_id -> artifacts",
        "changed_by, change_type",
        "old_data, new_data",
      ],
      icon: "📝",
      iconBg: "#0369a1",
      x: 35,
      y: 490,
      width: 245,
      height: 100,
      variant: "default",
      details: {
        role: "Audit log for artifact modifications.",
      },
    },
    {
      id: "node-tbl-entities",
      title: "entities",
      subtitle: "Canonical Graph Nodes",
      description: [
        "PK: id (uuid)",
        "FK: user_id, team_id",
        "entity_type, title, domain_override",
        "hot (MCP fast-recall flag)",
        "embedding: vector(1536)",
      ],
      icon: "🕸️",
      iconBg: "#7c3aed",
      x: 325,
      y: 80,
      width: 245,
      height: 125,
      variant: "purple",
      details: {
        role: "Knowledge graph nodes across PARAMPS taxonomy.",
      },
    },
    {
      id: "node-tbl-entity-rel",
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
      x: 325,
      y: 230,
      width: 245,
      height: 105,
      variant: "purple",
      details: {
        role: "Graph edges between entities.",
      },
    },
    {
      id: "node-tbl-art-ent-links",
      title: "artifact_entity_links",
      subtitle: "Fused Search Junction",
      description: [
        "PK: id (uuid)",
        "FK: artifact_id -> artifacts",
        "FK: entity_id -> entities",
        "link_type, confidence_score",
      ],
      icon: "🔀",
      iconBg: "#8b5cf6",
      x: 325,
      y: 360,
      width: 245,
      height: 105,
      variant: "purple",
      details: {
        role: "Junction table linking knowledge atoms to semantic graph nodes.",
      },
    },
    {
      id: "node-tbl-bindings",
      title: "bindings",
      subtitle: "Dynamic Identity Bindings",
      description: [
        "PK: id (uuid)",
        "FK: domain_entity_id -> entities",
        "name, target_kind, target_ref",
      ],
      icon: "🏷️",
      iconBg: "#a855f7",
      x: 325,
      y: 490,
      width: 245,
      height: 100,
      variant: "purple",
      details: {
        role: "Runtime named references scoped by identity.",
      },
    },
    {
      id: "node-tbl-workflows",
      title: "workflows",
      subtitle: "Pipeline Run Master",
      description: [
        "PK: id (uuid)",
        "FK: user_id, team_id, source_artifact_id",
        "workflow_type, status, execution_mode",
        "started_at, completed_at",
      ],
      icon: "⚙️",
      iconBg: "#d97706",
      x: 615,
      y: 80,
      width: 245,
      height: 125,
      variant: "warning",
      details: {
        role: "Transitional workflow orchestrator runs.",
      },
    },
    {
      id: "node-tbl-steps",
      title: "workflow_steps",
      subtitle: "Step Tasks & Storage",
      description: [
        "PK: id (bigint)",
        "FK: workflow_id -> workflows",
        "step_name, step_type, status",
        "input, output, duration_ms",
      ],
      icon: "👣",
      iconBg: "#b45309",
      x: 615,
      y: 230,
      width: 245,
      height: 105,
      variant: "warning",
      details: {
        role: "Granular step execution records.",
      },
    },
    {
      id: "node-tbl-training",
      title: "training_examples",
      subtitle: "Few-Shot Learning Pairs",
      description: [
        "PK: id (uuid)",
        "FK: source_workflow_run_id, source_task_id",
        "example_type, input, output",
        "quality_tier, is_validated",
      ],
      icon: "🎓",
      iconBg: "#92400e",
      x: 615,
      y: 360,
      width: 245,
      height: 105,
      variant: "warning",
      details: {
        role: "Stores curated inputs and outputs for prompt tuning.",
      },
    },
    {
      id: "node-tbl-decisions",
      title: "system_decisions",
      subtitle: "Routing & Decision Log",
      description: [
        "PK: id (uuid)",
        "FK: workflow_step_id -> workflow_steps",
        "decision_type, decision, confidence",
      ],
      icon: "⚖️",
      iconBg: "#78350f",
      x: 615,
      y: 490,
      width: 245,
      height: 100,
      variant: "warning",
      details: {
        role: "Records autonomous agent routing decisions.",
      },
    },
    {
      id: "node-tbl-teams-users",
      title: "teams & auth.users",
      subtitle: "Multi-Tenancy Foundation",
      description: [
        "PK: teams.id, auth.users.id",
        "team_members: role, permissions",
        "invitations, waitlist_entries",
      ],
      icon: "🏢",
      iconBg: "#059669",
      x: 905,
      y: 80,
      width: 245,
      height: 125,
      variant: "success",
      details: {
        role: "Multi-tenant workspace and user ownership model.",
      },
    },
    {
      id: "node-tbl-preferences",
      title: "user_preferences",
      subtitle: "Operator Rules & Rituals",
      description: [
        "PK: id (uuid)",
        "FK: user_id, team_id, self_entity_id",
        "dos_config, confidence_thresholds",
      ],
      icon: "⚙️",
      iconBg: "#047857",
      x: 905,
      y: 230,
      width: 245,
      height: 105,
      variant: "success",
      details: {
        role: "User configuration, synthesis thresholds, and ritual preferences.",
      },
    },
    {
      id: "node-tbl-integrations",
      title: "user_integrations",
      subtitle: "Connected SaaS & OAuth",
      description: [
        "PK: id (uuid)",
        "FK: user_id, team_id, domain_entity_id",
        "provider, status, credential_ref",
      ],
      icon: "🔌",
      iconBg: "#065f46",
      x: 905,
      y: 360,
      width: 245,
      height: 105,
      variant: "success",
      details: {
        role: "Third-party SaaS connections and credentials.",
      },
    },
    {
      id: "node-tbl-schedulers",
      title: "scheduler_runs & locks",
      subtitle: "Single-Flight Ingest Cadences",
      description: [
        "PK: lock_name / run id",
        "locked_by, expires_at",
        "job_name, status, result",
      ],
      icon: "⏱️",
      iconBg: "#064e3b",
      x: 905,
      y: 490,
      width: 245,
      height: 100,
      variant: "success",
      details: {
        role: "Distributed mutex locking for background ingestion cadences.",
      },
    },
  ],
  lines: [
    {
      id: "l-art-to-der",
      path: "M 157 205 L 157 230",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-art-to-ext",
      path: "M 157 335 L 157 360",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-art-to-edit",
      path: "M 157 465 L 157 490",
      color: "#2563eb",
      width: 2,
    },
    {
      id: "l-ent-to-rel",
      path: "M 447 205 L 447 230",
      color: "#7c3aed",
      width: 2,
    },
    {
      id: "l-ent-to-junc",
      path: "M 447 335 L 447 360",
      color: "#7c3aed",
      width: 2,
    },
    {
      id: "l-art-to-junc",
      path: "M 280 140 L 325 380",
      color: "#8b5cf6",
      width: 1.5,
      dashed: true,
    },
    {
      id: "l-wf-to-steps",
      path: "M 737 205 L 737 230",
      color: "#d97706",
      width: 2,
    },
    {
      id: "l-steps-to-train",
      path: "M 737 335 L 737 360",
      color: "#d97706",
      width: 2,
    },
    {
      id: "l-steps-to-dec",
      path: "M 737 465 L 737 490",
      color: "#d97706",
      width: 2,
    },
    {
      id: "l-teams-to-pref",
      path: "M 1027 205 L 1027 230",
      color: "#059669",
      width: 2,
    },
    {
      id: "l-teams-to-int",
      path: "M 1027 335 L 1027 360",
      color: "#059669",
      width: 2,
    },
  ],
  stepBreakdown: [
    {
      step: 1,
      title: "Physical Knowledge Substrate",
      detail:
        "The artifacts table acts as the wide storage table for notes, files, and emails, linking directly to derived_artifacts for chunked pages and artifact_external_links for cross-system dedup.",
    },
    {
      step: 2,
      title: "Knowledge Graph Entities & Junctions",
      detail:
        "entities stores graph nodes with domain_override flags, linked together via entity_relationships and mapped back to atoms via artifact_entity_links.",
    },
    {
      step: 3,
      title: "Transitional Workflow & Learning Pipeline",
      detail:
        "workflows and workflow_steps track orchestration runs, feeding into training_examples and system_decisions for supervised model improvement.",
    },
    {
      step: 4,
      title: "Multi-Tenant Platform & Cadence Mutexes",
      detail:
        "teams, users, and user_preferences configure tenant boundaries, while scheduler_locks enforces single-flight execution for background ingestion.",
    },
  ],
};
