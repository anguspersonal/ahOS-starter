# ADR-114: Five-Layer Clean State Contract

- **Status:** Accepted
- **Date:** 2026-04-20
- **Accepted-on-dev:** 2026-10-26
- **Issue:** #1997
- **Related:** [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md) (capture primitive and cross-store lineage), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) (unified capture surface), [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md) (graph as projection source), [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) (three-step Link · Act · Synthesize), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (synthesis marker vocabulary), [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) (domain routing and two-level consumption), [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md) (two domains), [ADR-084](./ADR084_Entity_Domain_Is_Derived_By_Rule_Residue_Stored_As_An_Override.md) (entity domain derivation), [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) (Centralised Action Registry), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) (Core rulebook and engine), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) (action ledger), [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md) (one action registry in Core), [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) (three ritual verbs and task-anchored reconciliation)

---

## Context

Every knowledge-bearing workflow in ahOS (`capture -> process_artifact -> sync -> dogfood`) aims to leave the store in a **Clean State**: the artifact is whole and embedded, its entities and structural relationships are linked in the graph, its commitments have task lineage, its capture day has been synthesized into the Daily Log and State Doc, and the session left no silent tool failures in `action_ledger`.

Until now, this five-layer definition lived only as prose checklists scattered across skill instructions. Operators and agents verifying an artifact after ingestion or during dogfooding had to issue five separate queries across `artifacts`, `artifact_external_links`, `artifact_entity_links`, `entity_relationships`, and `action_ledger` and assemble the verdict by hand. When any step failed silently — an artifact missing its embedding, `derivation_status` stuck in `pending`, a meeting transcript with unlinked attendees or unspawned tasks, an unsynthesized capture day, or an errored tool call in `action_ledger` — no single read-only action could diagnose which layer broke and what remediation command to run next.

---

## Decision

### 1. The Five-Layer Clean State Contract

An artifact (or a domain window of recent artifacts) is in **Clean State** when all five layers pass:

| Layer | Key | Backing Tables | Invariant | Verdict Semantics |
| :--- | :--- | :--- | :--- | :--- |
| **Layer 1 — Artifact Integrity** | `layer1_artifact_integrity` | `artifacts`, `artifact_external_links` | Captured once with confirmed, non-stub text; `source_url` and `source_drive_file_id` populated when originating from Drive; canonical external pointer row in `artifact_external_links` (`google_drive`, `gmail`, `notion_*`) when originating from an external system; vector embedding generated (`embedding IS NOT NULL`). | `"ok"` when all applicable checks hold; `"fail"` when text is empty/stub, external pointer is missing, or embedding is null. |
| **Layer 2 — Graph Hygiene** | `layer2_graph_hygiene` | `entities`, `people`, `artifact_entity_links`, `entity_relationships` | `derivation_status = 'completed'` on the artifact; mentioned people, organisations, and projects linked via `artifact_entity_links` (`attended`, `about`, `mentions`, `promise_to`); linked entities participate in at least one structural relationship in `entity_relationships` where applicable. | `"ok"` when derivation is completed, entity links exist, and structural edges are present; `"warn"` when linked entities lack structural relationships; `"fail"` when derivation is incomplete or zero entity links exist. |
| **Layer 3 — Task Parity** | `layer3_task_parity` | `artifact_external_links` | Action-bearing artifacts (meeting notes, transcripts, triaged threads, or artifacts with `promise_to` links) record spawned task lineage via `artifact_external_links` (`kind = 'task'`) or carry an explicit zero-commitments marker in `processing_metadata`. | `"ok"` when `kind = 'task'` link(s) exist, zero commitments are explicitly recorded, or the artifact is non-action-bearing; `"warn"` when an action-bearing artifact has neither task links nor an explicit zero-commitments marker. |
| **Layer 4 — Synthesis Alignment** | `layer4_synthesis_alignment` | `artifact_external_links` | A synthesis lineage marker (`kind = 'synthesized'` or `kind = 'synthesized_unattended'`) exists in `artifact_external_links` once the artifact has been folded into the Daily Log / State Doc for its capture date and domain. | `"ok"` when a synthesis marker exists; `"fail"` when missing. |
| **Layer 5 — Ledger Health** | `layer5_ledger_health` | `action_ledger` | Zero unresolved tool failures (`status = 'error'`) recorded in `action_ledger` for the target `session_id` or evaluation window. | `"ok"` when error count is zero; `"fail"` when one or more error rows exist in the target scope. |

### 2. Overall Verdict and `clean` Flag

For a single artifact or across a domain window:

- **`verdict: "fail"` (`clean: false`)** if any evaluated artifact (or Layer 5 ledger health) has at least one `"fail"` layer.
- **`verdict: "warn"` (`clean: false`)** if no layer is `"fail"` but at least one layer is `"warn"`.
- **`verdict: "ok"` (`clean: true`)** if and only if all five layers across all evaluated artifacts are `"ok"`.

Every non-`"ok"` layer appends an actionable remediation string to that artifact's `missing` array naming the exact tool or action to run (for example, `artifact_embed_backfill`, `entity_derive_next`, `artifact_sync_entities`, `task_create` + `external_link_create`, `daily_log_create` via the `dos` ritual, or `ledger_query`).

### 3. `CleanStatePort` and the `clean_state_check` Core Action

Per [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) and [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md):

1. **`CleanStatePort` (`packages/core/src/ports/cleanState.ts`)** defines the isomorphic port interface and data structures (`CleanStateLayerStatus`, `CleanStateLayers`, `CleanStateArtifactSnapshot`, `CleanStateLedgerSummary`, `CleanStatePort`).
2. **Supabase Adapter (`packages/core/src/adapters/supabase/cleanState.ts`)** implements `CleanStatePort` against `artifacts`, `artifact_external_links`, `artifact_entity_links`, `entity_relationships`, and `action_ledger`, deriving artifact domain via `@ahkms/core` domain rules ([ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md), [ADR-084](./ADR084_Entity_Domain_Is_Derived_By_Rule_Residue_Stored_As_An_Override.md)).
3. **`clean_state_check` (`packages/core/src/actions/artifacts/cleanStateCheck.ts`)** is registered in `buildRegistry` via `defineAction` with `annotations: { readOnlyHint: true }`, accepting `{ artifact_id?: string, domain?: "angus" | "work", window_days?: number, session_id?: string }` (requiring at least `artifact_id` or `domain`) and returning `{ clean, verdict, artifacts, text }`.

---

## Consequences

- **What becomes easier:** Any session (`capture`, `process-artifact`, `sync`, `dogfood`) or UI surface can verify end-to-end Clean State in a single read-only `clean_state_check` call and receive copy-pasteable remediation steps for every gap.
- **What becomes harder:** Adding a new mandatory post-capture pipeline stage requires updating both `ADR-114` and `cleanStateCheck.ts` so the contract and its programmatic evaluator never drift.
- **What we'll revisit:** Whether unattended background cadences in `@ahkms/core/engine` should automatically enqueue remediation jobs when `clean_state_check` reports Layer 1 or Layer 2 failures over a recent domain window.
