# ADR112: Three ritual verbs (`prep`, `sync`, `reflect`), positional `[scope] [mode]` grammar, and task-anchored reconciliation

- **Status:** Accepted
- **Created:** 2026-10-25
- **Accepted-on-dev:** 2026-10-25
- **Deciders:** Angus Hally (owner)
- **Amends:** [ADR-031](./ADR031_Capability_Registry.md) (consolidates `prep` and `reflect` alongside `sync`/`dos` into `kms-repo` under `.claude/skills/` with registered `kms-db` bodies), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (§1: expands the ritual vocabulary to three lifecycle verbs `prep`, `sync`/`synth`/`dos`, and `reflect` under a uniform `<verb> [scope] [mode]` grammar), [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) (§6 and §10-§14: places all Tasks DB reconciliation and staleness triage in `sync` and adds `*-proposal` staging for unattended-to-attended handoff), [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md) (§7: makes `sync` the primary synthesis verb with `synth` and `dos` as permanent aliases), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md) (§2: strips `ahos/`/`ahkms/` prefixes in capability lookup and defines the 6-cadence unattended ritual schedule)
- **Builds on:** [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md), [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md), [ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md), [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md), [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md), [ADR-110](./ADR110_Metrics_Ride_Artifacts_And_State_Doc_Is_The_Human_Review_Gate.md)
- **Resolves:** [#1947](https://github.com/anguspersonal/ahOS/issues/1947)

---

## Context and problem

By October 2026, ahOS's personal-ops rituals had drifted across four dimensions:

1. **Fragmented naming and inconsistent invocation grammar.** Forward-looking preparation (`prep`, `prep-day-unattended`), backward-looking synthesis (`dos`), and reflection (`dos-reflect`) used three different naming conventions and incompatible argument shapes (`dos --unattended`, `prep-day-unattended`, `dos-reflect weekly`). Calling "sync" or "synth" had no registered entry point.
2. **Split canonical homes and hardcoded Notion UUIDs.** While `.claude/skills/dos/SKILL.md` lived in git (`storage_location = 'kms-repo'`) under the CI drift guard (`scripts/check-skill-bodies.js`) and read all workspace identifiers dynamically via `dos_config_get` and `notion_config_get`, `prep` and `dos-reflect` lived only as database rows (`storage_location = 'kms-db'`) containing hardcoded Notion page and database UUIDs and legacy pre-ADR-081 connector tool names.
3. **Prefix mismatch on `ADR-093` pointer prompts.** [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md) §2 standardized claude.ai Routine prompts on `run ahos/<capability>`. When an agent passed `"ahos/dos"` or `"ahos/prep"` directly as the `name` argument to `get_capabilities` (`capability_get`) or `resolve_capability` (`capability_resolve`), exact title matching against `entities.title` missed because the stored title has no `ahos/` prefix.
4. **Blurred boundary between operational task hygiene and strategic reflection.** Task reconciliation and 30-day staleness triage had been mixed into `dos-reflect` while daily/weekly `dos` only ran forward atom-to-task extraction without reverse task-anchored search across Gmail, Drive, Calendar, GitHub, and ahKMS (`sync <project|tag>` / `sync week`).

---

## Decision drivers

1. **One uniform ritual grammar across the operating lifecycle.** Forward preparation (`prep`), operational synthesis and task reconciliation (`sync`), and step-back reflection (`reflect`) are three distinct phases of one operating loop and share a single `<verb> [scope] [mode]` invocation grammar.
2. **Clean separation between operational reconciliation (`sync`) and reflection (`reflect`).** `sync` owns 100% of task-list hygiene (forward atom-to-task sweep, reverse task-anchored search, and the 3-rule staleness triage). `reflect` performs **zero task-list hygiene** and focuses strictly on patterns, drift, lessons, and strategic alignment.
3. **Git-governed, config-driven skill bodies (`kms-repo`).** Every ritual must live in `.claude/skills/<verb>/SKILL.md`, pass `scripts/check-skill-bodies.js` and `skillToolRefs.test.ts`, resolve all Notion IDs from `dos_config_get` and `notion_config_get`, and sync to `kms-db` via `skill-sync repo push`.
4. **Zero broken pointers across surfaces.** `ahos/<name>` and `ahkms/<name>` shorthands, plus ritual synonyms (`sync`, `synth`, `dos`, `reflect`, `dos-reflect`, `prep`, `prep-day-unattended`), must resolve deterministically in both `get_capabilities` and `resolve_capability`.
5. **Fast attended sessions via unattended proposal staging (`*-proposal`).** Unattended scheduled runs pre-stage structured proposal artifacts (`prep-proposal`, `sync-proposal`, `reflect-proposal`) via `capture` without mutating Notion Tasks or the State Doc; attended sessions load the staged proposal immediately with zero cold-start wait.

---

## Considered options

### Option A -- Keep `dos`, `prep`, and `dos-reflect` separate with ad-hoc flags and `kms-db` bodies

Leave `prep` and `dos-reflect` in `kms-db` and add task queries only to `dos`.

- **Pros:** Smaller immediate diff in `.claude/skills/`.
- **Cons:** Leaves `prep` and `dos-reflect` unguarded in git with hardcoded Notion UUIDs and stale tool references; preserves three incompatible invocation syntaxes; fails to resolve `ahos/<name>` prefix lookups or `sync`/`synth` aliases; keeps task hygiene split across `dos` and `dos-reflect`.

### Option B -- Three ritual verbs (`prep`, `sync`/`synth`/`dos`, `reflect`) with positional `[scope] [mode]` grammar, repo-governed skills, capability alias resolution, and task-anchored reconciliation in `sync` (chosen)

Unify all three lifecycle rituals under one grammar in `.claude/skills/`, wire prefix stripping and synonym resolution into the MCP capability tools, consolidate all task reconciliation and staleness triage into `sync` (keeping `reflect` purely reflectional), and stage unattended proposals for instant attended review across six scheduled cadences.

- **Pros:** Single mental model (`<verb> [scope] [mode]`); 100% git-tracked and CI-guarded ritual bodies with zero hardcoded UUIDs; seamless backward compatibility for `dos`, `synth`, `dos-reflect`, `prep-day-unattended`, and `ahos/*` pointers; clean separation of operational task hygiene (`sync`) from reflection (`reflect`).
- **Cons:** Requires maintaining `dos` as a permanent repo alias companion alongside `sync` so existing habits and pointers continue working without friction.

---

## Decision

### 1. Three ritual verbs and the `<verb> [scope] [mode]` grammar

ahOS defines three primary ritual verbs covering the full operating loop:

| Verb | Aliases | Direction | Scopes | Modes | Purpose |
|---|---|---|---|---|---|
| `prep` | `prep-day-unattended` | Forward-looking (prospective) | `meeting` (`--mvp` \| `--deep`), `day` (default), `week` | `attended` (default), `unattended` (`--unattended`) | Reads State Docs, open tasks, work and personal calendars, and CRM context; builds meeting briefs (`--mvp` or `--deep`), time-boxed Day Plans (`prep day`), and 7-day Week Plans (`prep week`); stages `prep-proposal` when unattended |
| `sync` | `synth`, `dos` | Backward-looking (operational synthesis & task reconciliation) | `day` (default), `catchup`, `week`, `<project\|tag>` | `attended` (default), `unattended` (`--unattended` / `sweep`), `hard` | Consumes unconsumed atoms, writes Daily Logs (`daily_log_create`), owns **all** Tasks DB reconciliation (forward sweep, reverse task-anchored search, and 3-rule staleness triage), promotes State Doc diffs (`state_doc_update`), and stages `sync-proposal` when unattended |
| `reflect` | `dos-reflect` | Step-back alignment & lessons (purely reflectional; **zero task-list hygiene**) | `meeting`, `day`, `week` (default), `month`, `quarter`, `year` | `attended` (default), `unattended` (`--unattended`) | Evaluates what went well, what went less well, patterns/drift, and the question being avoided across the scope window; stages a Reflection Brief (`reflect-proposal`) when unattended; walks through reflection questions 1-at-a-time when attended, writes the Reflection entry, records lessons (`review_lesson_record`), and offers stakeholder artefacts and State Doc updates |

Every ritual accepts the positional grammar:

```text
<verb> [scope] [mode]
```

- **`[mode]`**: `attended` (`attended=true`, default for interactive sessions) or `unattended` (`attended=false` / `--unattended`, for autonomous scheduled execution).
- **Unattended -> Attended fast-path (`<verb>-proposal`):**
  - When any verb runs with `unattended` / `--unattended`, it never mutates the State Doc or Notion Tasks DB and never asks interactive questions (`report, never wait`). Instead, it stages a structured proposal artifact via `capture` tagged `["<verb>-proposal", "scope:<scope>", "date:<YYYY-MM-DD>"]` (`prep-proposal`, `sync-proposal`, or `reflect-proposal`).
  - When the owner runs the corresponding `attended` ritual, Step 0 queries `knowledge_search` for a fresh `<verb>-proposal` matching `(scope, date)`. If found, it loads the pre-computed brief/reconciliation immediately with zero cold-start wait (computing only the delta since `staged_at`) and proceeds straight to interactive review.

### 2. Canonical host consolidation in `.claude/skills/`

Amending [ADR-031](./ADR031_Capability_Registry.md), all ritual skills are canonically hosted in git (`storage_location = 'kms-repo'`) under `.claude/skills/{prep,sync,reflect,dos}/SKILL.md` and enrolled with `register: true` in `.claude/skill-registry.json`:

- `.claude/skills/prep/SKILL.md`: canonical protocol for `prep`.
- `.claude/skills/sync/SKILL.md`: canonical protocol for `sync` (and `synth` / `dos`).
- `.claude/skills/reflect/SKILL.md`: canonical protocol for `reflect` (and `dos-reflect`).
- `.claude/skills/dos/SKILL.md`: retained in `.claude/skills/` and `.claude/skill-registry.json` as the permanent alias companion to `sync` so local `/dos` invocations and remote `get_capabilities({ name: "dos" })` calls resolve identically.
- No ritual skill may hardcode Notion page or database UUIDs; all targets resolve at runtime from `dos_config_get` and `notion_config_get`.

### 3. Capability prefix stripping and ritual alias resolution

In `packages/mcp-server/src/tools/capabilities.ts` and `packages/mcp-server/src/tools/resolveCapability.ts`:

1. **Prefix stripping:** A shared helper `normalizeCapabilityLookup(rawName)` strips any leading `ahos/` or `ahkms/` prefix (case-insensitive) after trimming whitespace. Calling `get_capabilities({ name: "ahos/sync" })` or `resolve_capability({ name: "AHKMS/prep" })` resolves `"sync"` or `"prep"`.
2. **Ritual alias map:** Lookup always checks the canonical ritual name first before falling back to legacy alias rows in deterministic order:
   - `sync` -> `["sync", "dos", "synth"]`
   - `synth` -> `["sync", "dos", "synth"]`
   - `dos` -> `["sync", "dos", "synth"]`
   - `reflect` -> `["reflect", "dos-reflect"]`
   - `dos-reflect` -> `["reflect", "dos-reflect"]`
   - `prep` -> `["prep", "prep-day-unattended"]`
   - `prep-day-unattended` -> `["prep", "prep-day-unattended"]`

### 4. Bidirectional task-anchored reconciliation in `sync` (and zero task hygiene in `reflect`)

Amending [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) §6 and §10-§14:

1. **All task-list hygiene lives in `sync` Step 2b (`reflect` does zero task-list hygiene):**
   `sync` reconciles the Notion Tasks DB (`tasks_source_data_source_id` for `work` and `tasks_data_source_id` for `angus`) in two directions across four scopes:
   - **`sync day`:** Forward Sweep (today's atoms, meetings, and `session_summary` captures -> candidate task closures, status/due-date updates, and deduplicated new task commitments) + Reverse Task-Anchored Sweep on active/due-soon tasks (`Due date <= today + 7d`, overdue, `In Progress`, or matching today's active threads).
   - **`sync catchup`:** Sweeps unclosed days (`dos_daily_log_queue`) + reconciles open tasks against evidence across the catchup window.
   - **`sync week`:** Full open-task backlog reconciliation across `work` and `angus` + the **3 deterministic staleness rules**:
     1. **Past due:** `Due date < today`.
     2. **Open 30+ days:** created or last edited >= 30 days ago with zero activity in the period's logs or atoms.
     3. **No context:** missing owner, project/domain, and due date.
   - **`sync <project|tag>` (e.g. `ahOS/sync wedding`, `ahOS/sync ahOS`):** Targeted task-anchored reconciliation. Filters open tasks matching `<project|tag>`, groups them into **3-8 search clusters**, and executes a reverse search across `gmail_search` (plus `gmail_read` on the newest message in each matching thread), `drive_search`, `calendar_list_events`, `github_issue_search`, and `knowledge_search` to surface unrecorded completions, status shifts, and missing commitments, paired with a targeted State Doc section RAG check.
2. **Human approval gate:**
   In `unattended` mode, `sync` stages the reconciliation batch inside a `sync-proposal` capture (`tags: ["sync-proposal", "scope:<scope>", "date:<YYYY-MM-DD>"]`) and never mutates the Tasks DB or State Doc. In `attended` mode, approved closures (`notion_page_update`), updates, and new tasks (`task_create`) execute in Step 8d after Step 7's single review gate.

### 5. Unattended schedule matrix (6 cadences in UTC)

Amending [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md) §2 and `docs/guides/SCHEDULING_DISARM_PROTOCOL.md`, the unattended personal-ops schedule comprises six UTC cadences:

| Cadence | Cron (UTC) | Pointer command | Trigger ID / disposition | What it stages |
|---|---|---|---|---|
| **Daily Morning** | `0 5 * * *` (`05:00 UTC`) | `run ahOS/prep day --unattended` | Reuse `trig_01V5oQxAPr2V61W8h2wE3REL` | Draft `Day plan - YYYY-MM-DD` + `prep-proposal` (`scope:day`) |
| **Daily EOD** | `0 17 * * *` (`17:00 UTC`) | `run ahOS/sync day --unattended` | Reuse `trig_01D1ryfphosxkUdUNg8Fsaob` (retuned from `0 16 * * *` to `0 17 * * *`) | Unattended `catchup` sweep (`[today-7, today-2]`) + `sync-proposal` (`scope:day`) |
| **Weekly Wrap** | `30 16 * * 5` (`16:30 UTC` Fridays) | `run ahOS/sync week --unattended` | Dedicated weekly routine | Full-backlog task reconciliation + 3-rule staleness batch in `sync-proposal` (`scope:week`) |
| **Weekly Retro** | `0 17 * * 5` (`17:00 UTC` Fridays) | `run ahOS/reflect week --unattended` | Dedicated weekly routine | 7-day Reflection Brief + 3-5 evidence-anchored questions in `reflect-proposal` (`scope:week`) |
| **Weekly Ahead** | `0 18 * * 0` (`18:00 UTC` Sundays) | `run ahOS/prep week --unattended` | Reuse `trig_013CxSLc4SW3RmoXDBajxBtW` (pointer `ahOS/prep week --unattended`, connector `ahkms`) | 7-day Week Plan + deep-prep meeting flags in `prep-proposal` (`scope:week`) |
| **Monthly Retro** | `30 6 1 * *` (`06:30 UTC` 1st of month) | `run ahOS/reflect month --unattended` | Dedicated monthly routine | Prior-month Reflection Brief + pillar/decision synthesis in `reflect-proposal` (`scope:month`) |

---

## Consequences

- **Good:**
  - All three rituals share one predictable grammar (`<verb> [scope] [mode]`), live in git under `.claude/skills/`, and are protected by `check-skill-bodies.js` and `skillToolRefs.test.ts`.
  - Operational task hygiene (`sync`) is cleanly separated from reflection (`reflect`), while targeted project sweeps (`sync wedding`, `sync ahOS`) actively reconcile open tasks against Gmail, Drive, Calendar, GitHub, and ahKMS.
  - Every attended ritual benefits from a pre-staged `<verb>-proposal` artifact generated by the 6-cadence unattended schedule.
- **Cost / trade-off:**
  - `.claude/skills/dos/SKILL.md` is kept alongside `.claude/skills/sync/SKILL.md` so both repo-local `/dos` and `/sync` commands work in Claude Code; changes to the synthesis protocol must update `sync/SKILL.md` (and keep `dos/SKILL.md` aligned as its alias wrapper).
