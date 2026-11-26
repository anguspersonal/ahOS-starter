# ADR095: Canonical Claude custom instructions are hybrid-generated, single-block

- **Status:** Accepted
- **Created:** 2026-09-26
- **Accepted-on-dev:** 2026-09-26
- **Deciders:** Angus Hally

## Context and problem

The "Instructions for \<model\>" block pasted into claude.ai custom instructions
(serving chat, Cowork and mobile) was a hand-copied artifact ahOS could not see
or verify. It drifted the moment the system changed: the live block named a
tool (`get_dos_hl_config`) that had already been renamed to `get_dos_config`
by migration `20260825120000_097_rename_dos_hl_config_to_dos_config.sql`,
called the connector `ahkms-knowledge` instead of `ahkms`, described the
retired `dos-hl` ritual instead of the unified `dos` (ADR-054 §7), and listed
only capture routes with no read routes — most of what ahOS can do went
unmentioned (#1025).

Two forks needed resolving before any code could be written.

## Decision drivers

- **Structural staleness must become impossible**, not just less likely — the
  existing block's failure mode (a tool call to something that no longer
  exists) is worse than an admittedly-stale block, because nothing signals it.
- **One canonical body per paste target.** Surfaces that cannot read a repo,
  a shell, or GitHub differ from Claude Code, which already gets equivalent
  coverage through the MCP handshake instructions (`buildInstructions` in
  `server.ts`) plus `AGENTS.md`.
- **Generated prose reads worse than written prose**, and this block's whole
  job is to be read carefully by a model — hedged, over-generalized text is
  ignored.
- **Reuse the existing drift precedent** (`check_dos_config_drift`) rather than
  inventing a new staleness mechanism.

## Considered options

### Fork 1 — stored vs. generated vs. hybrid

#### Option A — Stored

The block is written by hand and kept in ahOS as a body.

- **Pros:** Simple; full authorial control over prose quality.
- **Cons:** Goes stale for exactly the reason it goes stale today — someone
  has to remember to update it every time a tool is renamed or added.

#### Option B — Fully generated

The block is derived entirely from the live registered tool set plus config.

- **Pros:** Cannot disagree with reality; staleness on the ahOS side becomes
  structurally impossible.
- **Cons:** Generated prose reads worse than hand-written prose for a
  block whose entire purpose is to be read by a model.

#### Option C — Hybrid (Chosen)

Hand-written prose, with one generated section: the tool table, derived from
the registered tool catalog at build time. The seam is the table and nothing
else.

- **Pros:** Structural staleness on the part that actually drifts (tool
  names, routes) becomes impossible, while prose quality is preserved where a
  human is best placed to write it (fallback ordering, naming rules,
  ADR-094 pointers).
- **Cons:** The seam must be drawn deliberately or the hand-written half
  silently reabsorbs content that should be generated.

### Fork 2 — one block vs. one per surface

#### Option A — Per-surface blocks

Claude Code, chat, Cowork and mobile each get instructions hedged to their
actual capabilities (a repo and a shell vs. none of those).

- **Pros:** More accurate per surface; no instruction has to hedge for a
  capability the surface doesn't have.
- **Cons:** N things to keep current instead of one; more surface area for
  the same drift problem this ADR exists to close.

#### Option B — One block, one paste target (Chosen)

Exactly one canonical block, pasted into the claude.ai custom-instructions
box. Claude Code needs no paste at all: the MCP handshake instructions
(`buildInstructions`, `server.ts`) plus `AGENTS.md` already give it equivalent
coverage, so there is exactly one pasted copy to track.

- **Pros:** One staleness check, one hash, one paste to keep current.
- **Cons:** The block still has to read sensibly on a surface with no repo or
  shell (mitigated: the block is capability-and-tool-table shaped, not
  workflow-shaped, so it does not need surface-specific hedging).

## Decision

We adopt **Fork 1: hybrid** and **Fork 2: one block, one paste target**,
implemented in `packages/mcp-server/src/canonicalInstructions.ts` (#1025,
PR #1191).

Staleness is detected, not guessed: the canonical body's sha256 is compared
against a stored `{ sha256, pasted_at }` pasted-copy receipt
(`user_preferences.dos_config.pasted_instructions`), the same receipt shape
`.claude/skill-registry.json` already uses for skill bodies. Drift is
surfaced in the `ahos_doctor` "travels" family and in `dos` Step 0, reusing
existing source-health delivery rather than adding a new notification
channel for one message a month.

The capability-fallback line ("if you do not know a command, check ahOS for
capabilities") is enforced as the first line of the rendered block, not the
fifth — it is the mechanism that made the previously-broken block survivable
at all.

## Consequences

### Good
- The tool table can never name a tool that does not exist or omit one that
  does; both are compile-time-adjacent (generated from the same registry
  `registerAllTools` builds against).
- One hash, one paste, one staleness check — no per-surface reconciliation.
- Reuses `check_dos_config_drift`'s drift shape and `.claude/skill-registry.json`'s
  receipt shape instead of inventing a third staleness mechanism.

### Cost / bad
- The hybrid seam (hand-written prose vs. generated table) requires
  discipline to keep narrow; new drift-prone content (e.g. a new read route)
  has to be pulled into the generated section rather than typed into the
  prose by hand.
- ahOS still cannot read the claude.ai settings box directly, so a paste that
  never happens is detected only as "never recorded as pasted", not caught at
  the source.

### Follow-up
- If a second paste target with genuinely different capabilities emerges
  (Fork 2 revisited), split the single block rather than hedging it further.

## Links
- Resolves: [#1025](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/1025)
- Implemented in: PR [#1191](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/1191)
- Related: [ADR-094](./ADR094_Model_Behaviour_Change_Requests_SOP.md) (model behaviour change requests SOP)
