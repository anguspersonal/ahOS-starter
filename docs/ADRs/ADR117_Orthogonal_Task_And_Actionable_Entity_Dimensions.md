# ADR-117: Orthogonal Task and Actionable-Entity Dimensions Alongside Priority Level

- **Status:** Accepted
- **Date:** 2026-10-31
- **Accepted-on-dev:** 2026-10-31
- **Authors:** Angus Hally
- **Deciders:** Angus Hally
- **Issues:** [#2074](https://github.com/anguspersonal/ahOS/issues/2074)
- **Amends:** [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md) (aligns `priority_levels` and `PRIORITY_LEVELS` with the uniform `{ id, slug, display, meaning }` dimension contract and separates orthogonal `status`, `task_type`, `effort`, `energy_mode`, and `source` dimensions)

---

## Context and Problem Statement

[ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md) established the universal 7-point priority scale (`1: Trivial` lowest to `7: Critical` highest, with `5: High` as the default focus cut-line). During the design review for [#1986](https://github.com/anguspersonal/ahOS/issues/1986), two orthogonal questions surfaced:

1. **Lifecycle commitment vs priority:** An unconfirmed agent suggestion (`proposed`) or a parked idea (`someday`) can still have high potential impact (`priority_level: 5`), while a confirmed commitment (`todo` or `in_progress`) can be low stakes (`priority_level: 2`). Previously, `public.user_tasks.status` only permitted four values (`todo`, `in_progress`, `done`, `cancelled`), leaving no distinct states for unconfirmed proposals (`proposed`), parked ideas (`someday`), or externally blocked commitments (`blocked`).
2. **Cadence, effort, energy mode, and provenance vs priority:** Whether an item is a single deliverable (`one_off`) or a repeating routine (`recurring` or `habit`), how long it takes (`quick`, `small`, `medium`, `large`), what kind of attention it demands (`deep_work`, `admin`, `waiting_on`, `quick_win`), and how it entered the system (`owner`, `agent_proposed`, `email_triage`, `meeting_sweep`, `ritual`) are independent of how urgent or important the item is.
3. **Uniform vocabulary structure:** Every dimension vocabulary across `ahOS` (`priority`, `status`, `task_type`, `effort`, `energy_mode`, `source`) benefits from a single self-documenting record shape (`{ id, slug, display, meaning }`) so agent prompts, UI badges, and database schemas share identical semantics.

---

## Decision Drivers

1. **Strict orthogonality:** `priority_level` (`1..7`) measures strictly importance and urgency. Lifecycle state, cadence, execution cost, cognitive mode, and provenance each live on their own dimension.
2. **Uniform `{ id, slug, display, meaning }` vocabulary contract:** Every term in every dimension carries an integer `id`, a snake_case `slug`, a human-readable `display` label, and a one-sentence operational `meaning`.
3. **Practical at-rest storage:** `priority_level` is stored at rest as integer `1..7` for numeric threshold queries (`priority_level >= 5`), while categorical dimensions (`status`, `task_type`, `effort`, `energy_mode`, `source`) are stored at rest as text `slug` values (`'proposed'`, `'one_off'`, `'quick'`, `'deep_work'`, `'agent_proposed'`).
4. **Shared vocabulary across tasks and actionable entities:** `public.user_tasks` enforces the dimensions via physical columns and `CHECK` constraints, while actionable Knowledge Graph entities (`project`, `arrangement`, `decision`, `event`) validate the same vocabulary inside `entities.properties` JSONB without adding task-only columns to `public.entities` ([ADR-085](./ADR085_People_Organization_Place_And_Event_Anchor_To_Public_Classes.md)).

---

## Decision Outcome

### 1. Uniform `DimensionTerm<TSlug>` Vocabulary Shape

Every vocabulary term across `priority` (`1..7`), `status` (`1..7`), `task_type` (`1..4`), `effort` (`1..4`), `energy_mode` (`1..4`), and `source` (`1..5`) conforms to `DimensionTerm<TSlug>`:

```ts
export interface DimensionTerm<TSlug extends string = string> {
  id: number;
  slug: TSlug;
  display: string;
  meaning: string;
}
```

In `packages/core/src/domain/priorityScale.ts` and `public.priority_levels` (migration `148`), each priority level exposes `id` (`1..7`), `slug` (`'trivial' | 'minor' | 'low' | 'normal' | 'high' | 'urgent' | 'critical'`), `display` (`'Trivial' .. 'Critical'`), and `meaning` alongside the existing `level`, `tier` (`'P1'..'P7'`), `title`, `description`, and `isDefaultCutLine` fields.

### 2. Canonical Orthogonal Dimensions

#### 2.1 Lifecycle `status` (`1..7`, default `'todo'`)

| `id` | `slug` | `display` | `meaning` |
| :---: | :--- | :--- | :--- |
| **1** | `proposed` | **Proposed** | Not confirmed it will or should be done yet; needs owner decision before promoting to To Do. |
| **2** | `someday` | **Someday** | Worth keeping on the radar, but intentionally parked with no active commitment or timeline. |
| **3** | `todo` | **To Do** | Confirmed commitment queued for execution, not yet started. |
| **4** | `in_progress` | **In Progress** | Actively being worked on right now. |
| **5** | `blocked` | **Blocked** | Committed work that cannot advance until an external dependency, reply, or prerequisite resolves. |
| **6** | `done` | **Done** | Completed and verified; no further action required. |
| **7** | `cancelled` | **Cancelled** | Explicitly dropped or superseded; kept for lineage so agents do not re-propose it. |

#### 2.2 Cadence / `task_type` (`1..4`, default `'one_off'`, plus optional `recurrence_rule`)

| `id` | `slug` | `display` | `meaning` |
| :---: | :--- | :--- | :--- |
| **1** | `one_off` | **One-Off** | Single deliverable that completes once and does not repeat. |
| **2** | `recurring` | **Recurring** | Routine operational commitment that repeats on a defined schedule or recurrence rule. |
| **3** | `habit` | **Habit** | Ongoing behavioural practice or cadence tracked for consistency. |
| **4** | `milestone` | **Milestone** | Key checkpoint or target marker anchoring a broader project or arrangement. |

When `task_type` is `'recurring'` or `'habit'`, an optional `recurrence_rule` (`text`, such as `'weekly'`, `'monthly'`, or an RFC 5545 `RRULE`) records the schedule.

#### 2.3 Effort / Size (`effort`, `1..4`, nullable)

| `id` | `slug` | `display` | `meaning` |
| :---: | :--- | :--- | :--- |
| **1** | `quick` | **Quick (<15m)** | Under 15 minutes of effort; trivial execution cost regardless of priority level. |
| **2** | `small` | **Small** | Focused work block of roughly 15 to 60 minutes. |
| **3** | `medium` | **Medium** | Half-day or multi-hour effort requiring a dedicated session. |
| **4** | `large` | **Large** | Multi-day effort that should usually be broken down into smaller tasks. |

#### 2.4 Execution Mode (`energy_mode`, `1..4`, nullable)

| `id` | `slug` | `display` | `meaning` |
| :---: | :--- | :--- | :--- |
| **1** | `deep_work` | **Deep Work** | High-focus cognitive work requiring uninterrupted concentration. |
| **2** | `admin` | **Admin** | Low-friction operational, logistical, or coordination work. |
| **3** | `waiting_on` | **Waiting On** | Delegated or external action being tracked for follow-up. |
| **4** | `quick_win` | **Quick Win** | Fast momentum builder suitable for low-energy or between-meeting slots. |

#### 2.5 Provenance (`source`, `1..5`, nullable)

| `id` | `slug` | `display` | `meaning` |
| :---: | :--- | :--- | :--- |
| **1** | `owner` | **Owner** | Created or requested directly by Angus. |
| **2** | `agent_proposed` | **Agent Proposed** | Suggested autonomously by an agent and awaiting owner commitment. |
| **3** | `email_triage` | **Email Triage** | Extracted from inbound or outbound email triage. |
| **4** | `meeting_sweep` | **Meeting Sweep** | Extracted from meeting notes, transcripts, or call summaries. |
| **5** | `ritual` | **Ritual** | Surfaced during a prep, sync, or reflect ritual pass. |

### 3. At-Rest Storage and Entity Property Validation

1. **`public.user_tasks` (migration `148`):**
   - `priority_level integer CHECK (priority_level >= 1 AND priority_level <= 7)` (from migration `147`).
   - `status text NOT NULL DEFAULT 'todo' CHECK (status IN ('proposed', 'someday', 'todo', 'in_progress', 'blocked', 'done', 'cancelled'))`.
   - `task_type text NOT NULL DEFAULT 'one_off' CHECK (task_type IN ('one_off', 'recurring', 'habit', 'milestone'))`.
   - `recurrence_rule text`.
   - `effort text CHECK (effort IS NULL OR effort IN ('quick', 'small', 'medium', 'large'))`.
   - `energy_mode text CHECK (energy_mode IS NULL OR energy_mode IN ('deep_work', 'admin', 'waiting_on', 'quick_win'))`.
   - `source text CHECK (source IS NULL OR source IN ('owner', 'agent_proposed', 'email_triage', 'meeting_sweep', 'ritual'))`.
2. **`public.entities` (`entities.properties` JSONB):**
   - Physical columns on `public.entities` remain unchanged.
   - Actionable entity types (`ACTIONABLE_ENTITY_TYPES = ['project', 'arrangement', 'decision', 'event']`) may store `priority_level` (`1..7`), `status`, `task_type`, `recurrence_rule`, `effort`, `energy_mode`, and `source` in `entities.properties`, validated via `validateActionableEntityProperties` (`packages/core/src/domain/taskDimensions.ts`) and `actionableEntityPropertiesSchema` (`packages/core/src/actions/domain/entities.ts`).

### 4. Five-Layer Recommended Capability Anatomy ([ADR-115](./ADR115_Recommended_Capability_Anatomy.md))

1. **Layer 1 (Policy and Decision Boundary):** This ADR (`ADR-117`) ratifies the `DimensionTerm<TSlug>` contract and the five orthogonal dimensions (`status`, `task_type`, `effort`, `energy_mode`, `source`), amending [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md).
2. **Layer 2 (Canonical State, Schema and Isomorphic Contracts):**
   - Migration `20261031160000_148_user_tasks_orthogonal_dimensions.sql` enriches `public.priority_levels` with `slug`, `display`, and `meaning`, widens `public.user_tasks.status`, and adds `task_type`, `recurrence_rule`, `effort`, `energy_mode`, and `source` to `public.user_tasks`.
   - `packages/core/src/domain/taskDimensions.ts` and `packages/core/src/domain/priorityScale.ts` export browser-safe constants, types, lookup helpers, and validators re-exported from `@ahkms/core`.
3. **Layer 3 (Agent / MCP Actions and Discovery):**
   - `task_crud` (`packages/core/src/actions/domain/tasks.ts`, `packages/core/src/actions/tasks/taskCrudBody.ts`, `packages/core/src/adapters/supabase/tasks.ts`) accepts and filters by all 7 `status` slugs plus `task_type`, `recurrence_rule`, `effort`, `energy_mode`, and `source`.
   - `packages/mcp-server/src/canonicalInstructions.ts` documents the orthogonal dimensions in `CANONICAL_PROSE_PREFIX`.
4. **Layer 4 (Sync and Projection Mechanism):** `packages/core/action-manifest.json` is regenerated via `npm run gen:action-manifest -w @ahkms/core`.
5. **Layer 5 (Enforcement Guards):** Unit tests in `packages/core/src/domain/taskDimensions.test.ts` and `packages/core/src/domain/priorityScale.test.ts` verify vocabulary completeness, lookup helpers, and actionable entity property validation, alongside `check-core-isomorphic.js` and `guards.js`.

---

## Consequences

- **Positive:** Agents and rituals can stage unconfirmed tasks as `status: 'proposed'` (`source: 'agent_proposed'`) with an accurate `priority_level` (`1..7`), park horizon items as `status: 'someday'`, distinguish `one_off` deliverables from `recurring` routines and `habit` cadences, and filter by `effort` or `energy_mode` (such as surfacing `quick` / `quick_win` items between meetings) without overloading `priority_level`.
- **Negative / Trade-offs:** External surfaces with simpler status schemas require boundary mapping when syncing `proposed`, `someday`, or `blocked` items outward, handled per surface under [ADR-044](./ADR044_Source_Vocabularies_Are_Read_Only_And_Locally_Authoritative.md).
