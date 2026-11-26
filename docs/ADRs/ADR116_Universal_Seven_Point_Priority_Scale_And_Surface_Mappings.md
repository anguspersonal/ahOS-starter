# ADR-116: Universal 7-Point Priority Scale and Cross-Surface Mapping Table

- **Status:** Accepted
- **Date:** 2026-10-31
- **Accepted-on-dev:** 2026-10-31
- **Authors:** Angus Hally
- **Deciders:** Angus Hally
- **Issues:** [#1986](https://github.com/anguspersonal/ahOS/issues/1986), [#2074](https://github.com/anguspersonal/ahOS/issues/2074)
- **Amends:** [ADR-080](./ADR080_Issues_Carry_One_Status_And_One_Priority.md) (maps GitHub's 3-label `priority:{low,medium,high}` family into the 7-point universal scale), [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) (§3: replaces the 5-level `P0..P4` priority scale with the 7-point integer scale `1` lowest to `7` highest)
- **Amended by:** [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md) (aligns priority level records with the uniform `{ id, slug, display, meaning }` dimension contract and separates orthogonal `status`, `task_type`, `effort`, `energy_mode`, and `source` dimensions)

---

## Context and Problem Statement

Priorities across Angus's connected tools (`ahOS`, Personal Notion, Work Notion, `work-mcp`, GitHub Issues, and Gmail priority triage) previously used incompatible scales and opposite numerical directions:

1. [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) §3 defined a 5-point `P0` to `P4` scale where lower numbers meant higher priority (`P0`/`P1` critical down to `P4` low).
2. `packages/core/src/actions/tasks/taskProperties.ts` and `packages/web/src/components/inbox/PriorityInboxCanvas.tsx` already adopted a 7-point `P1..P7` tier scale (`1` lowest to `7` highest) for task creation and the Priority Inbox canvas (`#1984`), but without canonical human-readable level titles or a database-backed cross-surface mapping table.
3. `public.user_tasks` stored only a coarse 4-value `priority` check constraint (`low`, `medium`, `high`, `urgent`), losing the 7-point granularity when persisting tasks in Supabase.
4. External surfaces each enforce their own native priority vocabulary (`High`/`Medium`/`Low` in Notion, `priority:1_critical..4_low` in `work-mcp`, `priority:{low,medium,high}` in GitHub Issues per [ADR-080](./ADR080_Issues_Carry_One_Status_And_One_Priority.md), and `P1..P7` in Gmail priority triage). Under [ADR-044](./ADR044_Source_Vocabularies_Are_Read_Only_And_Locally_Authoritative.md), `ahOS` treats foreign surface vocabularies as locally authoritative and translates at the boundary instead of rewriting external schemas.

Without a single canonical 7-point priority scale and a deterministic mapping table in `kms-db` and `@ahkms/core`, agents and rituals had to guess how `P1..P7` translated to and from each surface.

---

## Decision Drivers

1. **Intuitive numerical direction:** Higher integer means higher priority (`1` lowest to `7` highest), matching the `P1..P7` convention already used in Gmail triage, `task_create`, and the Priority Inbox canvas.
2. **Symmetric midpoint and explicit cut-line:** A 7-point scale provides a natural midpoint (`4: Normal`) and an explicit default focus cut-line (`5: High`, matching the `>= 5` cut-line in `PriorityInboxCanvas.tsx`).
3. **Foreign vocabulary sovereignty ([ADR-044](./ADR044_Source_Vocabularies_Are_Read_Only_And_Locally_Authoritative.md)):** External surfaces keep their native labels (`Notion`, `work-mcp`, `GitHub Issues`); `ahOS` translates deterministically via a canonical mapping table.
4. **Recommended Capability Anatomy ([ADR-115](./ADR115_Recommended_Capability_Anatomy.md)):** The priority scale spans policy (Layer 1), database schema and isomorphic `@ahkms/core` contracts (Layer 2), MCP/action tool exposure and handshake instructions (Layer 3), manifest projection (Layer 4), and automated schema/test guards (Layer 5).

---

## Decision Outcome

### 1. Canonical 7-Point Priority Scale (`1` Lowest to `7` Highest)

`ahOS` defines a universal 7-point integer priority scale (`1` to `7`, where `1` is lowest and `7` is highest), amending [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) §3:

| Level (`id`) | Tier Code | Slug (`slug`) | Display Title (`display`) | Default Cut-Line (`>= 5`) | Operational Meaning (`meaning`) |
| :---: | :---: | :---: | :--- | :---: | :--- |
| **7** | `P7` | `critical` | **Critical** | Above cut-line (`true`) | Drop-everything blocker, live production incident, or hard external deadline today with immediate blast radius. |
| **6** | `P6` | `urgent` | **Urgent** | Above cut-line (`true`) | Time-sensitive commitment due within 24 to 48 hours or unblocking another person or critical path. |
| **5** | `P5` | `high` | **High** | **Default cut-line (`true`)** | Important committed work for the current week; the default focus cut-line (`>= 5`) in the Priority Inbox and daily rituals. |
| **4** | `P4` | `normal` | **Normal** | Below cut-line (`false`) | Standard planned work with moderate impact and urgency at the symmetric midpoint of the scale. |
| **3** | `P3` | `low` | **Low** | Below cut-line (`false`) | Useful improvement or follow-up that can slip to the next week without consequence. |
| **2** | `P2` | `minor` | **Minor** | Below cut-line (`false`) | Nice-to-have polish, opportunistic cleanup, or low-leverage task scheduled when capacity allows. |
| **1** | `P1` | `trivial` | **Trivial** | Below cut-line (`false`) | Lowest-stakes item with negligible impact or urgency if delayed indefinitely. |

`priority_level` (`1..7`) measures strictly importance and urgency. Lifecycle status (`proposed`, `someday`, `todo`, `in_progress`, `blocked`, `done`, `cancelled`), task type/cadence (`one_off`, `recurring`, `habit`, `milestone`), effort size (`quick`, `small`, `medium`, `large`), energy mode (`deep_work`, `admin`, `waiting_on`, `quick_win`), and provenance (`owner`, `agent_proposed`, `email_triage`, `meeting_sweep`, `ritual`) are orthogonal dimensions defined in [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md).

### 2. Cross-Surface Priority Mapping Table

Every connected surface maps deterministically across all 7 levels (`35` total mappings across `5` surfaces). Because coarser surfaces (`Notion`, `work-mcp`, `GitHub Issues`) map multiple 7-point levels to the same external label, each distinct external value designates exactly one row with `is_canonical_reverse = true` so inbound normalization (`external_value -> level`) is deterministic:

| Level | Title | `notion_personal` | `notion_work` | `work_mcp` | `github_issue` ([ADR-080](./ADR080_Issues_Carry_One_Status_And_One_Priority.md)) | `gmail_triage` | `user_tasks.priority` (coarse DB) |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **7** | `Critical` | `1 High` | `High` | `priority:1_critical` (`*`) | `priority:high` | `7` (`*`) | `urgent` |
| **6** | `Urgent` | `1 High` (`*`) | `High` (`*`) | `priority:1_critical` | `priority:high` (`*`) | `6` (`*`) | `urgent` (`*`) |
| **5** | `High` | `1 High` | `High` | `priority:2_high` (`*`) | `priority:high` | `5` (`*`) | `high` (`*`) |
| **4** | `Normal` | `2 Medium` (`*`) | `Medium` (`*`) | `priority:3_medium` (`*`) | `priority:medium` (`*`) | `4` (`*`) | `medium` (`*`) |
| **3** | `Low` | `2 Medium` | `Medium` | `priority:3_medium` | `priority:medium` | `3` (`*`) | `medium` |
| **2** | `Minor` | `3 Low` (`*`) | `Low` (`*`) | `priority:4_low` (`*`) | `priority:low` (`*`) | `2` (`*`) | `low` (`*`) |
| **1** | `Trivial` | `3 Low` | `Low` | `priority:4_low` | `priority:low` | `1` (`*`) | `low` |

*(`*`) denotes `is_canonical_reverse = true`: the canonical 7-point level returned when reading an external label back into `ahOS` (`1 High` / `High -> 6`, `2 Medium` / `Medium -> 4`, `3 Low` / `Low -> 2`; `priority:1_critical -> 7`, `priority:2_high -> 5`, `priority:3_medium -> 4`, `priority:4_low -> 2`; `priority:high -> 6`, `priority:medium -> 4`, `priority:low -> 2`; `'1'..'7' -> 1..7`).*

### 3. Five-Layer Recommended Capability Anatomy ([ADR-115](./ADR115_Recommended_Capability_Anatomy.md))

1. **Layer 1 (Policy and Decision Boundary):** This ADR (`ADR-116`) ratifies the 7-point scale (`1: Trivial` to `7: Critical`), the default focus cut-line at `5: High`, and the 5-surface mapping table, amending [ADR-080](./ADR080_Issues_Carry_One_Status_And_One_Priority.md) and [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) §3.
2. **Layer 2 (Canonical State, Schema and Isomorphic Contracts):**
   - Migration `20261031150000_147_priority_scale_and_surface_mappings.sql` creates `public.priority_levels` (7 rows) and `public.priority_surface_mappings` (35 rows) with RLS enabled and read access for `authenticated` and `service_role`, plus `user_tasks.priority_level integer CHECK (priority_level >= 1 AND priority_level <= 7)` backfilled from existing coarse `user_tasks.priority` values (`low -> 2`, `medium -> 4`, `high -> 5`, `urgent -> 6`).
   - `packages/core/src/domain/priorityScale.ts` exports the browser-safe isomorphic constants, types, and pure bidirectional conversion helpers (`PRIORITY_LEVELS`, `PRIORITY_SURFACE_MAPPINGS`, `DEFAULT_PRIORITY_CUT_LINE`, `getPriorityLevelDefinition`, `formatPriorityBadge`, `mapPriorityToSurface`, `mapSurfaceToPriorityLevel`, `priorityLevelToNotionTier`, `notionTierToPriorityLevel`, `priorityLevelToTaskCrudPriority`, `taskCrudPriorityToPriorityLevel`, `toExternalPriority`, `fromExternalPriority`, `priorityTierToLevel`, `priorityLevelToTier`, `priorityLevelToTaskPriority`, `taskPriorityToLevel`, `priorityLevelToNotionSelect`, `notionSelectToPriorityLevel`), re-exported from `@ahkms/core` root.
3. **Layer 3 (Agent / MCP Actions and Discovery):**
   - `task_create` (`createTaskInput` in `@ahkms/core` and legacy MCP `create_task`) and `task_crud` (`create` and `update` in `@ahkms/core`) accept `priority_level` (`1..7`) alongside `priority_tier` (`P1..P7`) and coarse `priority`, persisting both `priority` and `priority_level` on `public.user_tasks` and mapping `1..2 -> tier 3 (3 Low / Low)`, `3..4 -> tier 2 (2 Medium / Medium)`, `5..7 -> tier 1 (1 High / High)` when writing to Notion Tasks.
   - `packages/mcp-server/src/canonicalInstructions.ts` (`CANONICAL_PROSE_PREFIX`) documents the 7-point scale (`1=Trivial` lowest to `7=Critical` highest, default focus cut-line `>= 5 High`) so every surface receiving the canonical instructions block shares the same vocabulary.
   - `packages/web/src/components/inbox/PriorityInboxCanvas.tsx` displays the canonical level titles (`P7 Critical (7/7)` down to `P1 Trivial (1/7)`).
4. **Layer 4 (Sync and Projection Mechanism):** `packages/core/action-manifest.json` is regenerated via `npm run gen:action-manifest -w @ahkms/core` so HTTP, MCP, and Web surfaces stay in lockstep.
5. **Layer 5 (Enforcement Guards):** Unit tests in `packages/core/src/domain/priorityScale.test.ts` and `packages/mcp-server/src/__tests__/createTaskPriorityTier.test.ts` assert exact parity between the TypeScript contract and the SQL seed in `supabase/migrations/20261031150000_147_priority_scale_and_surface_mappings.sql`, alongside `check-core-isomorphic.js` and `guards.js`.

---

## Consequences

- **Positive:** Every priority-bearing tool call, database row, ritual prompt, and UI badge uses one monotonic integer scale (`1` lowest to `7` highest) with unambiguous titles (`Trivial`, `Minor`, `Low`, `Normal`, `High`, `Urgent`, `Critical`) and deterministic round-trip translation across all five external surfaces.
- **Negative / Trade-offs:** Coarse 3-tier surfaces (`Notion` and `GitHub Issues`) and 4-tier surfaces (`work-mcp` and `user_tasks.priority`) compress adjacent levels on outbound writes (`5..7` map to `1 High` / `High` in Notion and `priority:high` on GitHub; `6..7` map to `priority:1_critical` in `work-mcp`), so inbound reads from those surfaces resolve to the designated canonical reverse level (`6: Urgent`, `5: High`, `4: Normal`, `2: Minor`, or `7: Critical`) unless the item also carries a fine-grained `priority_level` or `P1..P7` tag.
