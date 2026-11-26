# ADR-020: Open contradictions across ADR-013 to ADR-019 — register and resolution log

**Status:** Accepted
**Date:** 2026-06-15 (register) · 2026-06-16 (resolution log closed)
**Accepted-on-dev:** 2026-06-16
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, meta-adr, reconciliation, capture, skills, synthesis, register
**Builds on:** ADR-013, ADR-016, ADR-018, ADR-019
**Touches:** PR #13, PR #25, PR #27, PR #54, PR #55, PR #56, PR #58, PR #59; dotclaude PR #4

## Purpose of this ADR

ADRs 012–019 were written in waves over a short period as the system pivoted from a
web-UI-first product into an agent-interface-first knowledge substrate, and as several
parallel PRs explored adjacent capabilities (capture, knowledge graph, discover & index,
state-doc consumption, capability hosting). Some of those ADRs **contradict each other**,
and several open PRs ship code that encodes the older mental model alongside code that
encodes the newer one.

Rather than litigate each contradiction in a sibling ADR, this ADR collects them in one
place so the trade-offs are visible together and so future readers can see the canonical
history of *what we changed our minds about and why*.

It is structured in three parts:

1. **History — how we got here** (the "why we changed our minds" narrative).
2. **Register — open contradictions**, grouped by severity.
3. **Resolution log** — each contradiction gets a `Decision:` block once it's resolved
   (initially empty; updated in subsequent commits to this ADR).

Status flips from `Proposed` to `Accepted` once every entry in the register has a
`Decision:` block.

---

## Part 1 — History (the trail of changed minds)

> Drafts referenced below are preserved under
> [`docs/architecture/historical/`](../architecture/historical/) and are **not** part of
> the canonical ADR sequence.

**Phase 1 — Web-UI-first (pre-ADR-012).** The repo was built around a Next.js app (`packages/web`).
The implicit thesis: the *product* is the app; value comes from screens. ~37k LOC of UI before
the substrate stabilised.

**Phase 2 — MCP tool layer (ADR-012, *Accepted*).** Wrap the store as MCP tools so any agent
can drive it. The frontend stops being the only surface.

**Phase 3 — The pivot crystallises (draft "ADR-013 — Pivot from Web-UI-first", on PR #13;
never canonically merged → archived as [`ADR-draft-pivot-from-web-ui-first.md`](../architecture/historical/ADR-draft-pivot-from-web-ui-first.md)).**
Names what ADR-012 only implied: web-UI-first was the wrong pattern. The shape that wins
is **durable store + MCP tools driven by an agent**. This draft was superseded when the
slot was reused for…

**Phase 4 — Capture primitive (ADR-013, *Accepted*).** The canonical ADR-013 folds the
agent-interface-first pivot into a bigger move: split `capture` (one dumb write) from
working-memory state (working-state is a *projection*, not a second store). Introduces
§7's `artifact_external_links` substrate for cross-store lineage / consumption.

**Phase 5 — Capability comparison (draft "ADR-014 — Reconciling repo and skills", on PR #13;
never canonically merged → archived as [`ADR-draft-reconciling-repo-and-skills.md`](../architecture/historical/ADR-draft-reconciling-repo-and-skills.md)).**
Discovers, via a per-capability dominance pass, that the *emergent dotclaude skills* won
every active capability (capture, route, synthesise, plan/act, enrich) while the *repo*
won the substrate (ingest/extract, store, retrieve). Tentative conclusion: skills are the
operating layer; the repo is the substrate they call into. Numbering slot reused by…

**Phase 6 — Repo operating system (ADR-014, *Accepted*).** The canonical ADR-014 covers
docs lanes + contribution model — a different decision than the reconciliation question.
The reconciliation question itself was left open until…

**Phase 7 — Discover & Index (ADR-016, *Proposed*).** The substrate gains a registry
posture: hold pointers and lineage; don't hoard bytes. Introduces `lifecycle_stage`
(`discovered → extracted → …`) on connector-driven ingest. This sets the precedent that
*the repo records where knowledge lives, not (always) the knowledge itself.*

**Phase 8 — Unified capture surface (ADR-018, *Proposed*, this PR).** Resolves a different
duplication: `dos-inbox` (Notion-side capture) and `/capture` (ahkms-side capture) are
folded onto **one substrate (ahkms) and one command surface (`/capture`)**. Routing/inference
moves from capture-time to synthesis-time. §7 ports the `dos-hl` synthesis skill into
`.claude/skills/dos-hl/` against the ahkms substrate.

**Phase 9 — Capability hosting (ADR-019, *Proposed*).** Picks up Phase 5's open question and
gives it a concrete answer: the kms becomes the **authenticated private home** for the
skills it *owns* (no public-repo de-privatization tax), **indexes** the skills it doesn't
(Claude cowork-managed), and introduces a **bindings layer** so a single skill body can
resolve `{{notion.inbox_db}}` per-scope (personal | work). Replaces public web-fetch
distribution with authenticated serve.

**Reading the trail.** ADR-013 (web-UI pivot) and ADR-014 (reconciliation) drafts were
*right thinking, wrong slots*. The substantive calls those drafts pointed at have landed —
just under different ADR numbers, with different framing, and (for skills hosting) on a
longer fuse than the draft anticipated. The drafts are kept because they show *how* the
conclusion was reached, not just *what* it was.

---

## Part 2 — Register of open contradictions

Severity:

- **Blocking** — two PRs / ADRs cannot both ship as-is.
- **Coordination** — not strictly contradictory, but the two pieces don't reference each
  other and will drift unless aligned.
- **Housekeeping** — numbering / stale-ref / index issues.

### B1. PR #25 vs PR #59: two designs for the same synthesis surface

PR #25 (open) adds four specific tools: `list_pending_state`, `list_tasks`,
`update_state_doc`, `mark_state_consumed`. Scope is hardcoded as
`content_subtype ∈ {transcript, conversation}`. The body says "the skill itself stays in
your personal `~/.claude` (not this repo)."

PR #59 (open, this branch family) adds two generic tools: `search_knowledge` with
`captured_after` / `captured_before` / `not_consumed` filters, and `create_external_link`.
Scope is the caller's job. ADR-018 §7 ports `dos-hl` *into* `.claude/skills/dos-hl/`.

| Axis | PR #25 | PR #59 / ADR-018 |
| --- | --- | --- |
| Tool granularity | 4 specific | 2 generic |
| Scope policy | Hardcoded in the tool | Caller-set |
| Skill home | Personal `~/.claude` | In-repo `.claude/skills/` |
| Consumption marker tool | `mark_state_consumed` (specific) | `create_external_link` (`kind='consumed_by_state'`) |

These cannot both ship as-is.

**Decision:** *(2026-06-15)* **ADR-018's generic tools win — shipped in PR #85 (supersedes the closed PR #59).** Ship the two
generic tools (`search_knowledge` with `captured_after` / `captured_before` / `not_consumed`
filters, and `create_external_link`) with **scope set by the caller**, and home the skill
**in-repo** (`.claude/skills/dos-hl/`, per ADR-018 §7). PR #25's four hardcoded tools
(`list_pending_state`, `list_tasks`, `update_state_doc`, `mark_state_consumed`) and its
hardcoded `content_subtype ∈ {transcript, conversation}` scope are dropped; consumption is
marked via `create_external_link` (`kind='consumed_by_state'`), not a dedicated
`mark_state_consumed`. Rationale: generic + caller-scoped keeps capture dumb and pushes all
interpretation to synthesis time (`docs/vision.md` cut line; ADR-018 §4 "capture is dumb,
synthesis is smart"). This unblocks the build-now read loop (capture → search → synthesise).
Follow-up: close/retarget PR #25 onto the generic surface.

### B2. Three positions on where skills live

- PR #25: skill stays in personal `~/.claude`.
- ADR-018 §7: port `dos-hl` into `.claude/skills/dos-hl/`.
- ADR-019: kms hosts owned skills via authenticated serving + bindings; indexes the rest.

ADR-018 §7 is a tactical move (one skill, no serving layer). ADR-019 is the strategic
answer (registry + serve + bind). PR #25 is the older "skills live in personal config"
position. Accepting ADR-019 should make this contradiction self-resolving — but ADR-019
is still `Proposed`, and PR #25 doesn't yet acknowledge it.

**Decision:** *(2026-06-15, revised)* **Split B2 — most of it is NOT blocked on #84.** The
original "defer behind #84" conflated two separable concerns:

- **B2a — capability registry/index (build now, #84-independent).** ahOS holds the
  **canonical registry** of every skill: a pointer node per skill (where it really lives,
  `kind`/`surface`, and a `needed | redundant | deprecated` status) — the record of *what
  exists and whether I still need it*. Rides the existing substrate via the `discover` tool
  (lightweight pointers, no content pull). Follows "Map, don't store" (vision.md §1) and
  ADR-019 parts 1–2 ("index, don't absorb"). For skills ahOS **owns**, the repo copy under
  `.claude/skills/` already *is* canonical.
- **Content for quick reference = read-only mirrors, NOT canonical copies.** "What does this
  skill say?" is served by a **generated, refreshable mirror** (the existing `reference/`
  vendoring from PR #58; `dos-hl` was sourced from `reference/dotclaude/cowork-skills/`),
  each file carrying a `synced-at / source / do-not-edit` header. **The registry is canonical;
  mirrored content is not.** Private/cowork mirrors stay gitignored (local quick-reference, no
  GitHub leak) — avoiding the de-privatization tax ADR-019 set out to kill.
- **B2b — authenticated serving / execution (stays on #84).** Fetch/call/install a skill from
  any environment is ADR-019 part 3; that genuinely needs the serving surface (issue #84).

This reconciles the older positions: PR #25's "skills live in personal `~/.claude`" and
ADR-018 §7's "port into `.claude/skills/`" both fold into **index everything in ahOS now; hold
owned bytes here; mirror the rest read-only; defer only remote serving to #84.** No skill
migration forced. Source-of-truth drift is largely *avoided* (index + read-only mirror), not
merely deferred.

### B3. ADR-019 hangs off the unmerged draft ADRs

ADR-019's Links section says *"Builds on: ADR-013 (agent-interface-first) (WIP branch)"*
and *"Resolves (open items): ADR-014 Reconciling_Repo_And_Skills (WIP branch)"* —
references to documents that are now archived under
[`docs/architecture/historical/`](../architecture/historical/), not under `docs/ADRs/`.

ADR-019 already acknowledges this in its "Numbering note", but the Links section still
points at paths that don't exist on `dev`.

**Decision (2026-06-16):** Housekeeping — re-point ADR-019's Links section at
canonical ADR-013 (`ADR013_Capture_Primitive_and_Memory_Working_State_Split.md`),
canonical ADR-014 (`ADR014_Repo_Operating_System.md`), and the archived drafts
in their new `docs/architecture/historical/` home. Captured here so it doesn't
slip when ADR-019 next changes status. No ontology dependency; pure stale-ref
fix.

### C1. WIP ADR-014 framing vs ADR-019 framing — minor staleness

The draft *"Reconciling Repo and Skills"* (now in `historical/`) leans
*"skills = operating layer; repo = substrate"*. ADR-019 evolves this to
*"repo = authenticated private home + serving layer for owned skills; index the rest."*
That's an evolution, not a contradiction — but anyone reading the historical draft
without the pointer to ADR-019 would walk away with the older conclusion. The header
block we added when archiving the draft handles this; nothing further needed.

**Decision:** Resolved at archive-time by the supersession header in
[`ADR-draft-reconciling-repo-and-skills.md`](../architecture/historical/ADR-draft-reconciling-repo-and-skills.md).
No further action.

### C2. Capability-axes verb-set is unsettled; ADRs 018 / 019 use the verbs as if settled

[`docs/architecture/capability-axes.md`](../architecture/capability-axes.md) is on v2,
with several axes (Monitor & Trigger, Maintain & Retire, Synthesise vs Plan & Act) still
open. ADR-018 talks about "capture" and "synthesis" as durable categories; ADR-019 uses
Capture/Retrieve/Store the same way. If the v2 verbs shift, ADRs 018 / 019 may need
re-anchoring in their context sections.

**Decision (2026-06-16):** Deliberately deferred. The design ontology
(`docs/architecture/ahOntology.ttl` on the `experimental/ontology` branch —
speculative, firewalled from the canonical track, but normative for the
principles it encodes) does not promote the v2 capability-axes verb-set to a
canonical position; `docs/architecture/capability-axes.md` stays the WIP source
of truth. If it later promotes with shifted verbs, ADRs 018 / 019 may need
re-anchoring in their context sections. Tracked as **revisit-when-changes**,
not blocking.

### C3. ADR-018 doesn't reference the knowledge-graph tools

PR #27 ships `upsert_entity`, `relate_entities`, `link_artifact_entity`,
`get_entity_neighbourhood`. ADR-018 talks about "synthesis-time interpretation"
(workspace / type / domain inference, per atom) but doesn't say whether per-atom entity
extraction is part of `dos-hl`'s job, a separate agent step upstream of `dos-hl`, or
something the graph tools handle independently. Both interpretations work; neither is
documented.

**Decision (2026-06-16):** Entity extraction is a synthesis-time concern; the
KG tools (`upsert_entity`, `relate_entities`, `link_artifact_entity`,
`get_entity_neighbourhood`) are how synthesisers *persist* what they inferred.
Anchored on the design ontology's `ahos:SynthesisTimeInterpretation` principle
(`experimental/ontology`) — every interpretation move, including per-atom
entity extraction, happens at the read/synthesis boundary. The KG tools are
substrate that synthesisers write into, not a parallel capture path. Follow-up:
a one-paragraph note added to ADR-018 §4 or as an ADR-019 follow-up — the
principle settles the design call; the doc update is housekeeping (deferred).

### C4. Two ingest paths write to `artifacts`; only one carries `lifecycle_stage`

PR #54 / ADR-016 sets `lifecycle_stage` (`discovered → extracted`) on the connector-driven
path. ADR-018's chat-driven `/capture` doesn't discuss `lifecycle_stage` at all. Consumer
queries (`search_knowledge`, future ones) will see a mix of staged and unstaged rows.

**Decision (2026-06-16):** Chat-captured atoms default `lifecycle_stage =
extracted` (or `null` meaning "already content"). Anchored on
`ahos:CaptureIsDumb` + `ahos:TwoCadence` in the design ontology
(`experimental/ontology`): chat-capture bypasses Discover because its input is
already content (not a pointer to be unfurled), so it lands at or past
`extracted`. `null` is acceptable for atoms whose origin makes the lifecycle
distinction meaningless. Consumer queries (`search_knowledge`, …) treat both
as "ready" without needing a `lifecycle_stage != discovered` filter. Follow-up:
document in ADR-016's follow-ups or ADR-018 (single sentence — deferred).

### C5. Reconciliation with dotclaude PR #4 (six memory-store roles)

The cross-repo PR #4 in `anguspersonal/dotclaude` defines six memory-store roles
(`routing`, `map`, `log`, `state`, `structured`, `archive`) and a *capture-time* router
that decomposes a message into typed atoms and routes each to its store. ADR-018 disagrees
on *when* the fan-out happens (read-time, by synthesisers) but agrees on the role taxonomy
itself.

Reconciliation noted in the cross-repo comment at
[dotclaude#4#issuecomment-4705640297](https://github.com/anguspersonal/dotclaude/pull/4#issuecomment-4705640297):
*the fan-out happens at synthesis time, not capture time; dotclaude `/capture` becomes a
router-over-backends rather than a parallel implementation.*

**Decision:** Reconciled at the architecture level (per the cross-repo comment).
Implementation follow-up tracked in dotclaude, not here.

### H1. ADR-013 / ADR-014 numbering double-booking

PR #13 introduces draft ADRs at slots 013 and 014; `dev` has different documents at those
slots; PR #27's diff still lists both pairs of files because its base is PR #13's branch.

Resolved by this PR: the WIP drafts are archived to
[`docs/architecture/historical/`](../architecture/historical/) under non-numbered names so
the canonical ADR sequence stays clean. PR #27 will retarget to `dev` and the duplicates
will drop from its diff. PR #13 should be closed (its capability-axes work is independent
and can land separately).

**Decision:** Resolved by this PR. Follow-up: close PR #13 (capability-axes content can
land as a standalone doc PR).

### H2. PR #58 (dotclaude snapshot) and PR #13 share files

PR #58 is the strict "vendor only" subset of PR #13's diff. Easy to land — once #58
merges, the snapshot files drop from PR #13's diff cleanly.

**Decision:** Land PR #58 first. Then PR #13 reduces to docs-only and can either land or
close depending on whether the capability-axes draft still has value standalone.

### H3. `docs/Reports` → `docs/reports` rename (PR #56)

Pure rename; no architectural overlap. Land in any order; just `git grep -nE 'docs/Reports/'`
after merging the older PRs to catch any reintroduced stale paths.

**Decision:** Land PR #56 standalone; verify with `git grep` post-merge.

---

## Part 3 — Resolution log

> Each `Decision:` block above is updated in this ADR as the contradiction is resolved.
> Once every entry is decided, status flips from `Proposed` to `Accepted`. ADR-020 then
> serves as a permanent index of "what we changed our minds about during the 013–019 wave,
> and where the trail of reasoning lives."

Currently open: **none**.

Decided:
- **B1** (generic tools → PR #85, 2026-06-15)
- **B2** (split — B2a registry + read-only mirrors buildable now; B2b remote
  serving deferred to #84/ADR-019, 2026-06-15)
- **B3** (housekeeping re-point of ADR-019's Links section, 2026-06-16)
- **C2** (deferred — revisit-when-changes; capability-axes v2 verbs not yet
  canonical, 2026-06-16)
- **C3** (entity extraction is synthesis-time; KG tools are how synthesisers
  persist what they inferred, 2026-06-16)
- **C4** (chat-captured atoms default `lifecycle_stage = extracted` or `null`,
  2026-06-16)
- **C1, C5, H1, H2, H3** (resolved earlier)

**Resolution method for B3 / C2 / C3 / C4 (2026-06-16):** These four were
resolved by reading off the design ontology — a W3C Turtle / OWL artifact on
the `experimental/ontology` branch at
[`docs/architecture/ahOntology.ttl`](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/blob/experimental/ontology/docs/architecture/ahOntology.ttl).
That branch is firewalled from the canonical track (speculative, no PR
planned), but the principles it encodes — load-bearing across ADRs 013–019 —
are treated as normative for these housekeeping-tier decisions. Each Decision
block above names the specific ontology nodes that anchor the call (e.g.
`ahos:SynthesisTimeInterpretation`, `ahos:CaptureIsDumb`, `ahos:TwoCadence`).
See issue #73 for the Phase 4 read-off method.

Note on B2: the remote-serving half (B2b) is **dependent on**, not blocking
— it ships when #84 / ADR-019 ratify the authenticated serving + bindings
layer. The B2 decision itself is sealed (split, buildable, dependency-tagged);
the remaining work is in #84, not here.

Status: **Accepted** as of 2026-06-16. ADR-020 now serves as a permanent index
of "what we changed our minds about during the 013–019 wave, and where the
trail of reasoning lives." New 013–019-era contradictions, if any, would need a
new ADR rather than an edit here (per the immutable-once-Accepted rule).

## Links

- Canonical, current ADRs (`Accepted` unless noted):
  [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md),
  [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md),
  [ADR-014](./ADR014_Repo_Operating_System.md),
  [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md),
  [ADR-016](./ADR016_Discover_And_Index_Axis.md) *(Proposed)*,
  [ADR-017](./ADR017_Knowledge_Grounded_Correspondence_Edge.md),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) *(Proposed)*,
  [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) *(Proposed)*.
- Historical drafts: [`docs/architecture/historical/`](../architecture/historical/).
- Capability taxonomy (v2 WIP): [`docs/architecture/capability-axes.md`](../architecture/capability-axes.md).
- Cross-repo reconciliation comment: [dotclaude#4#issuecomment-4705640297](https://github.com/anguspersonal/dotclaude/pull/4#issuecomment-4705640297).
