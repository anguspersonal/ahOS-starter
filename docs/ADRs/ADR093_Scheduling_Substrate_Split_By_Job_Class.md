# ADR093: Scheduling substrate split by job class: GitHub Actions for repo engineering, Claude Routines for personal-ops

- **Status:** Accepted
- **Created:** 2026-09-25
- **Accepted-on-dev:** 2026-09-26
- **Deciders:** Angus Hally
- **Amended-by:** [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) (names the third substrate: unattended in-process engine cadences on Railway); [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) (standardises scheduled personal-ops Routine invocations on the `[action] [scope] [attended]` grammar: `ahos/prep day unattended`, `ahos/sync day unattended`, `ahos/reflect week unattended`)

## Context and problem

Scheduled autonomous work currently runs on **claude.ai Routines** bound to the Claude Code surface (8 live routines, inventoried in #634), created ad-hoc through the UI. That substrate choice was never made deliberately, and the 2026-08-11 "disarm" attempt (#629, #634) exposed serious operational costs:
1. **Disarm asymmetry**: UI-created Routines are un-pausable by agents because ownership is on the `http_api` side rather than agent session control.
2. **Invisible to code review**: Routines live entirely inside the claude.ai platform; their prompts, cadences, and triggers are not version-controlled in git.
3. **Connector gap for agent-created Routines**: On 2026-09-05, attempting to schedule the unattended `dos` sweep via `create_trigger` revealed that agent-created Routines cannot pass through or carry MCP connectors (`mcp_connections: []`). Consequently, an agent cannot create a working routine for any job requiring ahkms or external connectors (Notion, Gmail, Calendar, Supabase).
4. **Dispersed configuration**: The repository already trusts and runs scheduled automation via GitHub Actions `schedule:` (e.g. ~~`nightly-e2e.yml`, `release-pr.yml`~~ **— see Erratum 1 below**).

A clear decision is required to place scheduled autonomous jobs onto the substrate that fits their execution model, while ensuring all scheduled work is auditable, version-controlled, and disarmable on demand (#636).

## Decision drivers

- **Disarmability**: "Disarm" must be executable by an agent or human on request without permission dead-ends or unmanaged surfaces.
- **Config-as-code**: Prompt, schedule, model, and gating must be reviewable, diffable, and revertible in git.
- **Auditability**: Every scheduled firing must be discoverable and traceable from a central inventory.
- **Connector reachability**: Jobs that need MCP connectors to Notion, Gmail, Calendar, or the ahkms knowledge graph must reliably have them available.
- **Job class fit**: Repo engineering (code generators, PR reviews, lint/dead-code sweeps) versus personal-ops briefs (unattended `dos` sweep, morning/evening briefs, email triage) have fundamentally different context and permission footprints.
- **Cost and maintenance**: Avoid unnecessary 24/7 idle server compute, redundant daemons, or multiple secret-management solutions.

## Considered options

### Option A — Claude Routines for all scheduled autonomous work (status quo)
- **Pros:** Managed session ergonomics, mobile notifications, webhooks, transcripts.
- **Cons:** Prompts live only in the platform and drift silently; UI-created routines cannot be disarmed by agents; agent-created routines cannot hold MCP connectors, making autonomous scheduling of KMS jobs impossible.

### Option B — GitHub Actions `schedule:` for all scheduled work
- **Pros:** Full config-as-code in `.github/workflows/`, reviewable via PR, disarmable via `gh workflow disable` or workflow file edits, native fit for repo code tasks.
- **Cons:** Personal-ops jobs needing multi-domain MCP connectors (Notion, Google Workspace) would require building or maintaining a headless CLI harness with broad API keys stored in repo secrets, losing the interactive Claude session UX.

### Option C — Personal cron / self-hosted daemon
- **Pros:** Full local control, config-as-code.
- **Cons:** Requires an always-on machine, separate secret management, and a custom orchestration daemon (explicitly rejected in ADR-087).

### Option D — Cowork scheduled tasks (desktop app)
- **Pros:** Access to desktop context and local connectors.
- **Cons:** Completely unauditable today (local scheduled tasks do not appear in `list_triggers`); poor fit for repository engineering.

### Option E — Deliberate split by job class (CHOSEN)
Assign scheduled work to the substrate that matches its natural environment:
1. Repo-scoped engineering jobs run on **GitHub Actions `schedule:`**.
2. Personal-ops jobs requiring MCP connectors run on **claude.ai Routines created by Angus with connectors attached, calling repo-governed capability pointers**.

## Decision

We chose **Option E: a deliberate split by job class**.

### 1. Repo-scoped engineering work → GitHub Actions `schedule:`
- **Scope:** Tasks whose inputs and outputs are within GitHub repositories (e.g., auto-task generation, automated PR reviews, dependency checks, dead-code detection, guard suites).
- **Substrate:** GitHub Actions workflow files in `.github/workflows/` using `on.schedule` (cron).
- **Governance:** Full config-as-code. Prompts, cadence, model parameters, and gating live in git, subject to PR review and version history.
- **Disarm:** Disarmable instantly via `gh workflow disable <workflow.yml>` or by commenting out the `schedule:` trigger in a PR.

### 2. Personal-ops work requiring connectors → claude.ai Routines (human-created, pointer-driven)
- **Scope:** Tasks requiring external MCP connectors and user context (e.g., unattended `dos` sweep, morning/evening briefs, calendar/email summaries).
- **Substrate:** claude.ai Routines created by Angus from a session that explicitly holds the required MCP connectors (ahkms, Notion, Google Workspace).
- **Governance via Capability Pointers:** To eliminate prompt drift and avoid baking logic into unversioned UI forms, each Routine's prompt is strictly minimized to a pointer:
  `run ahos/<capability>`
  The actual prompt and execution protocol reside in the ahkms capability registry (`kms-db` or repo-resident skills in `.claude/skills/`), governed by CI drift guards (~~`check-repo-skills.js`~~ `scripts/check-skill-bodies.js` **— see Erratum 2 below**). The platform stores a pointer, not the protocol.
- **Re-evaluation trigger:** When Claude Code / claude.ai enables agent-created triggers to natively bind MCP connectors, migrate routine creation to autonomous agent management.

### 3. Disarm protocol
A single disarm protocol is established and documented in [`docs/guides/SCHEDULING_DISARM_PROTOCOL.md`](../guides/SCHEDULING_DISARM_PROTOCOL.md):
- Maintain a complete inventory of all active scheduled jobs across both substrates.
- To disarm repo workflows: run `gh workflow disable <name>` for each active workflow. **— see Erratum 3 below.**
- To disarm Claude Routines: run `update_trigger enabled: false` (or toggle in the claude.ai Routines UI for UI-owned routines).
- All disarm actions are logged in the session narrative or AFK operations journal.

### 4. Migration of existing Routines
The 8 live Claude Routines identified in #634 will be migrated according to this split (keep, move to GitHub Actions, or decommission) as part of executing #634's verdicts.

## Consequences

- **Good:**
  - Repo automation becomes 100% version-controlled, diffable, and agent-disarmable.
  - Personal-ops routines retain full access to MCP connectors without custom headless harnesses or leaked credentials.
  - Prompt drift in claude.ai Routines is eliminated by standardizing on `run ahos/<capability>` pointers backed by git/kms-db capability bodies.
  - Provides an unambiguous disarm protocol across the entire operational footprint.
- **Cost / Trade-off:**
  - Maintains two scheduling substrates rather than one unified scheduler.
  - Personal-ops routines must initially be created and connector-enabled by the human (Angus) in the claude.ai UI due to the platform connector grant constraint.
- **Follow-up:**
  - Execute #634 routine triage against this split.
  - Unblocks #1133 (Link eager, host question).

## Errata

Recorded 2026-09-29 under [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 (#1225). No new
decision is required, so this ADR is edited in place and its Status line is not stamped.

### Erratum 1 — the example scheduled workflows were not scheduled

Context item 4 cites `nightly-e2e.yml` and `release-pr.yml` as scheduled automation. Neither was
scheduled when this ADR was written on 2026-09-25. `nightly-e2e.yml` lost its `schedule:` trigger on
2026-07-13 (#47, recorded in ADR-015's amendment), and the file itself left the tree the same day this
ADR was minted, with the web surface ([ADR-096](./ADR096_Retire_The_Web_Surface.md)). `release-pr.yml`
is event-driven: it runs on `push` to `dev` and on `workflow_dispatch`, with no `schedule:` trigger.

The workflows that did carry an `on.schedule` trigger were `apex-watermark.yml`, `migration-drift.yml`,
`stale.yml` and `vocab-diff.yml`. Their current states are in the
[disarm guide's Inventory](../guides/SCHEDULING_DISARM_PROTOCOL.md#inventory). The point item 4 makes,
that the repo already runs scheduled automation on GitHub Actions, is unaffected.

### Erratum 2 — the repo-skill drift guard is `check-skill-bodies.js`

§2 names the CI drift guard for repo-resident skills as `check-repo-skills.js`. No such script exists.
The guard is [`scripts/check-skill-bodies.js`](../../scripts/check-skill-bodies.js) (#689), which fails
the build when a registered skill's body changes without its hash in `.claude/skill-registry.json`.

### Erratum 3 — "each active workflow" means each active *scheduled* workflow

§3 says to disarm repo workflows by running `gh workflow disable` "for each active workflow". The
section is about scheduled work, and the intent is each active workflow with an `on.schedule`
trigger. Read literally it covers every enabled workflow, and the guide's "disarm all" one-liner was
written that way: on 2026-09-29 it would have disabled all 15 active workflows, including the
`ci-main` release gate, `guard-main` and the `auto-merge-dev` QA gate, when only two were scheduled.
The guide now selects on the trigger, not on the state (#1225). The §3 decision itself is unchanged.

### Amendment (2026-10-04, ADR-101) — the third scheduling substrate: continuous unattended in-process engine cadences

ADR-093 established the split between GitHub Actions `schedule:` (repo engineering) and Claude Routines (interactive personal-ops), leaving implicit the continuous in-process maintenance cadences already running in Railway (`scheduler_locks` / `scheduler_runs`: discover, enrich, dedup, alerts, notion automations). Under [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md), this third substrate is explicitly recognized and consolidated: all continuous unattended batch and maintenance cadences run exclusively on the dedicated Engine process (`@ahkms/core/engine` hosted on the worker's Railway service), ensuring long-running LLM batches and polling cadences never contend for the event loop with interactive MCP `tools/call` requests.

## Links

- Sibling / Precursor: [ADR087](./ADR087_The_Orchestrator_Runs_On_Agent_Platform_Not_A_Custom_Daemon.md) (No custom daemon)
- Amended by: [ADR101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) (Two packages, two processes: core is rulebook and engine, mcp-server is front door)
- Related: [ADR050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (One ritual per name)
- Related: [ADR052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (Monitor sits outside)
- Guide: [`docs/guides/SCHEDULING_DISARM_PROTOCOL.md`](../guides/SCHEDULING_DISARM_PROTOCOL.md)
- Guide: [`docs/guides/AGENT_ROUTINES.md`](../guides/AGENT_ROUTINES.md)
- Issues: #636, #634, #629, #1000, #1133, #1318, #1321
