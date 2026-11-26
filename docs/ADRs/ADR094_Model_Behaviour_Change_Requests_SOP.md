# ADR094: Model behaviour change requests SOP — three-question heuristic, single-home storage, handshake delivery

- **Status:** Accepted
- **Created:** 2026-09-25
- **Accepted-on-dev:** 2026-09-26
- **Deciders:** Angus Hally

## Context and problem

A recurring pattern is being logged to ahkms: the user directs the model to behave differently ("ask me differently", "stop doing X", "always Y", preferences). Previously, handling was ad hoc per-conversation: sometimes an agent attempted to write a file-based auto-memory (`.claude/memory/`), sometimes the feedback was acknowledged and lost, and when preserved, scope, durability, and storage were chosen inconsistently.

This created three distinct failure modes (#595):
1. **Intent interpretation:** Distinguishing a durable standing preference from situational feedback on a specific turn or output. Over-triggering hardens a local or provisional statement into an over-applied general rule (the classic failure mode seen in `ahos-intelligence-vs-dumb-capture`); under-triggering loses real user directives and forces repeated human corrections.
2. **Scope of intent:** Determining whether a behaviour change is workspace-scoped (this repo only), domain-specific (Work vs personal), or global across all surfaces. Inferring scope from wherever the conversation happens leads to severe fragmentation or cross-contamination.
3. **Implementation mechanism & context delivery:** Determining where a change is stored and how it reaches model context across heterogeneous clients (Claude Code CLI, Cowork scheduled tasks, web chat, and API agents). File-based memories in local `.claude/` directories are invisible to other surfaces and drift silently.

## Decision drivers

- **Prevent over-generalisation / over-fitting:** Avoid hardening local preferences or architectural stances into global behavioral constraints.
- **Multi-surface parity:** ahOS is used across multiple surfaces (Claude Code CLI, Cowork, Web, API). Instructions must reach every surface without requiring duplicate configuration per machine.
- **Single write path:** There must be exactly one canonical home for every class of instruction, with an unambiguous resolution path.
- **Reconciliation with existing substrates:** Reconcile with the owner's tone configuration ([ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md), #819, #648), the MCP handshake instructions (`ServerOptions.instructions`), and `user_preferences`.
- **Searchable audit trail:** Every behavioural change must leave a dated, searchable provenance record in ahkms.

## Considered options

### Option A — Machine-local file memories (`.claude/memory/`, `CLAUDE.md` updates)

Rely on client-native auto-memory systems (like Claude Code's memory directory) or append rules to `CLAUDE.md` / `AGENTS.md`.

- **Pros:** Zero new machinery in MCP server; works natively in Claude Code CLI.
- **Cons:** Fails multi-surface parity completely: Cowork, web chat, mobile, and API agents never read `.claude/memory/`. Files rot, collide across branches, and suffer from context fragmentation.

### Option B — Ad-hoc tool/prompt patching per surface

Provide specialized tools for each client and surface to inject prompt snippets.

- **Pros:** Maximum customization per surface.
- **Cons:** High maintenance burden; instructions diverge between surfaces; violates the principle of a unified personal knowledge backend ([ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) / [ADR-031](./ADR031_Capability_Registry.md)).

### Option C — Three-question heuristic, single-home storage, handshake delivery (Chosen)

Evaluate incoming user directives with a standardized three-question heuristic. Store rules in canonical database properties (`dos_config.tone` for voice/tone, `user_preferences` for other standing behaviour), mirror as a `memory`-tagged capture for auditability, and deliver standing guidance to all clients via the MCP `initialize` handshake instructions.

- **Pros:** Universal reach across all surfaces; single canonical store in Postgres; dated provenance in `artifacts`; unambiguous decision tree.
- **Cons:** Modest token cost in every session via the handshake (mitigated by character caps, #648).

## Decision

We adopt **Option C — three-question heuristic, single-home storage, handshake delivery**, resolving #595 per the grill resolution recorded with Angus on 2026-09-25.

### 1. The Three-Question Heuristic

Whenever a user message redirects, corrects, or instructs model behaviour, evaluate the following three questions in order:

#### Q1: Is it durable?
- **Durable (Standing Rule):** The user corrects a standing habit, voice, or process ("stop doing X", "always do Y first", "I prefer Z", "never suggest A"). These must be recorded.
- **Not Durable (One-off Turn Feedback):** The user corrects a specific immediate response ("shorter", "make that a table", "not that one", "try again without the prefix"). These apply only to the active turn/conversation and must NOT be persisted as standing rules.
- **Ambiguity Rule:** When it is genuinely ambiguous whether feedback is intended to be standing or situational, ask **once**:
  > *"Keep that as a standing rule?"*

#### Q2: What is the scope?
- **Default: Global.** Every behaviour-change instruction applies across all surfaces, workspaces, and projects by default.
- **Narrowing:** Scope narrows to a specific project, surface, or task class **only when the user explicitly names it** (e.g., "in this repo", "when writing commits", "in Claude Code").
- **Core Invariant:** *Scope is never inferred from where the conversation happens.* (A preference expressed while working in the ahOS repository applies globally unless the user explicitly scopes it to ahOS).

#### Q3: What is the implementation mechanism?
Persist the instruction into its single canonical home:
1. **Voice and Tone Rules:**
   - Stored in `user_preferences.dos_config.tone` (via `update_user_preferences`).
   - Delivered to every client during the MCP `initialize` handshake via `ServerOptions.instructions` ([ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md), #819).
2. **General Standing Preferences & Behaviour:**
   - Stored in `user_preferences` under the relevant preference key.
3. **Audit Trail & Memory Mirroring:**
   - In both cases, simultaneously call `capture` with `surface: "claude_code"` (or current surface) and `tag: "memory"`, providing a clear dated summary of the instruction. This ensures the change is searchable across sessions and preserves historical provenance.
4. **No File-Based Memories:**
   - Never write model behavior rules to local `.claude/memory/` files or local markdown scratchpads. The database is the single source of truth.

---

### 2. Worked Example: Avoiding Over-Generalisation (`ahos-intelligence-vs-dumb-capture`)

The danger of unprincipled memory recording was demonstrated in the `ahos-intelligence-vs-dumb-capture` incident:

- **Incident:** During early capture pipeline design, the design decision was established that the capture step must remain "dumb" ([ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) — faithfully capturing raw input without heavy synthesis). An agent mistakenly interpreted this as a general model behaviour constraint against performing intelligent extraction or downstream synthesis anywhere in the system. As a result, downstream synthesis rituals (`process_artifact`, `dos-eod`) were paralyzed by an over-generalized rule prohibiting LLM inference.
- **How ADR-094 Prevents This:**
  - **Q1 (Durability & Intent):** Architectural principles belong in ADRs and GitHub issues, not in user behavioral preference stores. Distinguish architectural discussion from user-to-agent behavioural preferences.
  - **Q2 (Scope):** If the user says "capture must be dumb", the statement is domain-scoped to the capture ingestion tool, never a global behavioral ban on intelligent reasoning.
  - **Clarification:** If an agent is uncertain whether a statement is an architectural constraint or a standing behavioral preference, it asks once rather than silently entrenching an over-broad memory.

---

## Consequences

### Good
- **Consistent behavior across all surfaces:** The MCP handshake guarantees that any client connected to ahKMS receives standing tone and capability instructions on boot.
- **Eliminates memory sprawl:** Replaces uncoordinated local memory files with structured Postgres columns in `user_preferences`.
- **Searchable history:** Memory-tagged captures in `artifacts` provide a complete timeline of how instructions evolved.
- **Defends against over-fitting:** The single-ask fallback and explicit non-inference of scope prevent accidental over-generalisation.

### Cost / bad
- Handshake instructions consume context tokens on every session initialize (governed by tone character caps, #648).
- Requires agent discipline to ask once when durability is ambiguous, rather than guessing.

### Follow-up
- Handshake instructions in `packages/mcp-server/src/server.ts` updated to reference this SOP.

## Links
- Resolves: [#595](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/595)
- Related: [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) (Capture stays dumb)
- Related: [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md) (Skill config in DB, tone rules)
- Related: [ADR-031](./ADR031_Capability_Registry.md) (Capability registry)
