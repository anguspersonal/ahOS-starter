# ADR-115: Recommended Capability Anatomy (RCA)

- **Status:** Accepted
- **Created:** 2026-10-29
- **Accepted-on-dev:** 2026-10-29
- **Deciders:** Angus Hally (owner)
- **Issue:** #2036
- **Related:** [ADR-031](./ADR031_Capability_Registry.md) (Capability Registry), [ADR-071](./ADR071_Guards_Run_Locally_By_Default_CI_Is_The_Backstop.md) (local guards and CI backstop), [ADR-095](./ADR095_Canonical_Claude_Instructions_Are_Hybrid_And_Single_Block.md) (canonical Claude instructions), [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) (Centralised Action Registry), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) (Core rulebook and engine), [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md) (Agent-Ready Bar and work packets), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) (action ledger), [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md) (one action registry in Core), [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) (`ahOS` base conventions and `work-mcp` company instantiations)

---

## Context

In `example-org/ops#973` (amended in `example-org/ops#988`), Work adopted a five-layer **Recommended Capability Anatomy (`RCA`)** so that every multi-surface system capability, registry, or cross-plane data contract is designed, decomposed, and reviewed against a single architectural checklist.

In `ahOS`, multi-surface system capabilities (such as the [ADR-031](./ADR031_Capability_Registry.md) Capability Registry, the [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) three-verb ritual system, [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md) machine-source ingestion, and the [ADR-114](./ADR114_Five_Layer_Clean_State_Contract.md) Clean State contract) already span the same five architectural concerns: policy and decision boundary, canonical state and ledger, MCP/Core actions and surface discovery, sync/projection mechanisms, and enforcement guards. However, `ahOS` had no single named checklist binding those five layers together across issue grooming (`.claude/skills/groom-issues/SKILL.md`) and PR review (`.github/qa-rubric.md`), and the word *capability* in `ahOS` also refers to an individual `entity_type = 'capability'` row in `kms-db` governed by the **Capability Bar** in [`docs/agents/skills.md`](../agents/skills.md) and `writing-for-agents`.

Per [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) §3, `ahOS` holds the owner's base architectural conventions while keeping shared vocabulary aligned across `ahOS` and `work-mcp`.

---

## Decision

### 1. Naming and Disambiguation (`RCA` vs `Capability Bar`)

`ahOS` adopts the shared name **Recommended Capability Anatomy (`RCA`)** with an explicit opening disambiguation wherever RCA or the Capability Bar is documented:

- **Recommended Capability Anatomy (`RCA`)** governs **5-layer system capabilities**: end-to-end features spanning policy/ADRs, Supabase schema and `action_ledger`, Core/MCP actions, sync or projection mechanisms, and CI/review guards (for example, the Capability Registry, the three-verb ritual system, machine-source ingestion, or the Clean State contract).
- **The `ahOS` Capability Bar** (in `writing-for-agents` and [`docs/agents/skills.md`](../agents/skills.md)) governs **individual skill, command, and agent rows** stored in `kms-db` (one-sentence job, composition and non-duplication, sibling naming boundary, cross-surface honesty, and the Two-Bucket placement rule).

### 2. The 5-Layer `ahOS` Recommended Capability Anatomy

Every new system capability in `ahOS` must account for all five layers below (or declare an explicit `N/A — <reason>` exemption for any non-applicable layer):

| Layer | Purpose | `ahOS` Artefacts & Invariants |
| :--- | :--- | :--- |
| **1. Policy & Decision Boundary** | Establish why the capability exists, its invariants, how it changes, and what evidence is required to modify it. | ADR in [`docs/ADRs/`](./README.md) (indexed in `docs/ADRs/README.md`) and/or canonical guide in [`docs/agents/skills.md`](../agents/skills.md) or `kms-db` (`capability_get`). Must include: (a) a **change-path line** citing the Layer 2 storage contract and approver/review gate (`review:architect` / owner), and (b) the **evidence rule**: modifying rules or guardrails on an existing capability requires an observed session failure or an explicit owner request (`example-org/ops#988` amendment 1). |
| **2. Canonical State, Schema & Ledger** | Define the single source of truth, typed schema, storage contract per surface, and audit trail. | Supabase `entities` ([ADR-031](./ADR031_Capability_Registry.md) pattern) or domain tables via `supabase/migrations/*.sql`, typed contracts in `@ahkms/core` / `@ahkms/shared` ([ADR-008](./ADR008_Type_Organization_Standardization.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)), append-only `public.action_ledger` receipts and `system_decisions` approval gates ([ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)), and an explicit per-surface storage contract (Bucket 1 repo-homed `.claude/skills/*` + `.claude/skill-registry.json` mirrored to `kms-db`, versus Bucket 2 `kms-db`-authoritative). |
| **3. Agent / MCP Actions & Discovery** | Make the capability operable and discoverable across every supported surface with explicit offline/degraded fallbacks. | Core actions (`defineAction` in `packages/core/src/actions/` per [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) and [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md)) exposed via `@ahkms/mcp-server`, `canonicalInstructions.ts` ([ADR-095](./ADR095_Canonical_Claude_Instructions_Are_Hybrid_And_Single_Block.md)), and `capability_get` / `capability_resolve` (`ahOS/<name>`). Must include a **surface-access & MCP-fallback table** covering Claude Code, Chat, Cowork, mobile, CI, and unattended routines, honouring `AGENTS.md` Rule 4 (report remote MCP outage before any local fallback) (`example-org/ops#988` amendment 2). |
| **4. Sync & Projection Mechanism** | Keep read-only projections, repo mirrors, and generated manifests deterministic and drift-free. | `skill-sync` (`push`, `pull`, `repo push`, `status`), engine sync/ingest cadences in `packages/core/src/engine/`, and generated artefacts (`ACTIONS.md`, `manifest.generated.ts`, `action-manifest.json`) carrying `DO NOT EDIT` headers and deterministic regeneration scripts (`npm run gen:action-manifest -w @ahkms/core`). |
| **5. Enforcement Guards** | Prevent regression, silent drift, or bypass locally, in CI, at issue grooming, and at PR review. | Unit and contract tests (`Vitest`), repo guard scripts in `scripts/guards.js` (`check-skill-bodies.js`, `check-adr-numbers.js`, `check-adr-links.js`, `check-docs-index.js`, `surfaceParity.test.ts`), local git hooks + `pr-guards.yml` ([ADR-071](./ADR071_Guards_Run_Locally_By_Default_CI_Is_The_Backstop.md)), issue grooming in [`.claude/skills/groom-issues/SKILL.md`](../../.claude/skills/groom-issues/SKILL.md), and PR review in [`.github/qa-rubric.md`](../../.github/qa-rubric.md). |

### 3. Scope Threshold and `N/A — <reason>` Exemption Rule

- **New system capability (RCA required)**: Introduces a new domain registry, cross-surface workflow, dual-state data surface, or governance rule in `ahOS`. Work packets and PRs must account for all 5 layers.
- **Feature inside an existing capability (inherits parent RCA)**: Adds an action, entity subtype, connector rule, or branch inside an already-governed capability. It inherits the parent capability's 5 layers and must plug into the parent's existing policy, store, actions, sync, and guards without introducing a parallel store, sync mechanism, or policy.
- **Explicit layer exemption (`N/A — <reason>`)**: When a new capability legitimately does not require one of the 5 layers (for example, Layer 4 when state lives strictly in a single plane with no cross-plane sync or generated file), the issue packet or ADR must state `N/A — <reason>` for that layer. Silent omission of any layer fails both issue grooming (`status:agent-ready`) and PR review (`qa:approved`).

### 4. Canonical Placement and Cross-Surface Reachability

- **Bucket 2 Registry-native capability (`recommended-capability-anatomy`)**: Registered in `kms-db` via `capability_register` (`storage_location: "kms-db"`, `surface: ["claude-code", "claude-synced"]`, `clients: ["chat", "cowork"]`, synced locally to `~/.claude/skills/recommended-capability-anatomy/SKILL.md`) so agents on Claude Code, Chat, Cowork, and mobile can load it on demand via `capability_get({ name: "recommended-capability-anatomy" })`, while Work agents reach the sibling company instantiation via `work-mcp/guide_get({ slug: "recommended-capability-anatomy" })`.
- **In-repo documentation and pointer**: The `ahOS` 5-layer mapping and `ADR-031` reference walkthrough are documented in [`docs/agents/skills.md`](../agents/skills.md) for repo readers and guards, and `writing-for-agents` carries a 2-line context pointer directing 5-layer system capability work to `recommended-capability-anatomy`.
- **Dual-gate enforcement**: Enforced at issue grooming in [`.claude/skills/groom-issues/SKILL.md`](../../.claude/skills/groom-issues/SKILL.md) and at PR review in [`.github/qa-rubric.md`](../../.github/qa-rubric.md).

---

## Consequences

- **Positive**: Every multi-surface capability in `ahOS` is designed and reviewed against the same 5-layer anatomy used in Work (`example-org/ops#973`, `#988`), preventing half-wired capabilities (for example, schema without ledger receipts, MCP actions without surface fallbacks, or sync mechanisms without drift guards).
- **Positive**: Explicit disambiguation between `RCA` (5-layer system capabilities) and the `Capability Bar` (individual skill/command/agent rows) eliminates terminology collisions around the word *capability*.
- **Cost**: Issues and PRs introducing a new system capability must explicitly list the 5 layers (or `N/A — <reason>`), adding a small structured check to `groom-issues` and `qa-rubric`.
- **As-built topology**: Process and governance ADR only; physical system topology in `docs/architecture/architecture.md` is unchanged, while the as-built capability governance doc ([`docs/agents/skills.md`](../agents/skills.md)) is updated in the same PR.
