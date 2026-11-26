# ADR-018: Unified Capture Surface + Synthesis-Time Interpretation

**Status:** Accepted · Superseded in part by [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (§3 — `/capture` gains a `--braindump` flag selecting scope direction only; §5 — the marker is renamed `consumed_by_state` → `synthesized`)
**Date:** 2026-06-15 (proposed) · 2026-06-16 (accepted)
**Accepted-on-dev:** 2026-06-16
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, capture, skills, synthesis, dos
**Builds on:** ADR-012 (Assemble MCP tool layer), ADR-013 (Capture primitive + memory/working-state split)

## Context

Two capture lineages had emerged in parallel:

1. **`/capture`** (live, `.claude/skills/capture/SKILL.md`) — a generic dump-and-ask into ahkms artifacts via the `capture` MCP tool. Designed to be shareable: per-user opinions (tags, routing, default channel) live in `user_preferences.capture_preferences` (migration 045), not in the skill file. The unit is one artifact per distinct item.
2. **`dos-inbox`** (vendored under `reference/dotclaude/cowork-skills/`, not promoted) — captures Work operational signals into a **Notion Inbox DB**. Has a companion family (`dos-hl`, `dos-reflect`, `dos-braindump`) that synthesises the inbox into a Notion Daily Log entry and updates a Notion State Doc. The unit is *N rows per invocation*, grouped by domain coherence; the schema is a rich enum (Type ∈ {Note, Artefact, Decision, State change, Question for Angus} × Domain multi-select × Status ∈ {Unconsumed, Consumed}).

These differ on:

- **Substrate:** Supabase artifacts vs Notion Inbox DB.
- **Schema:** flat tags vs rich typed enum.
- **Segmentation:** one-per-distinct-item vs walk-and-group-by-domain-coherence.
- **Workspace:** universal vs Work-only-with-explicit-refusal.
- **Shareability:** none of dos-inbox is shareable — Notion DB IDs, Angus's Notion user ID, the Domain taxonomy, and the workspace check are baked into `reference/dotclaude/cowork-skills/dos-inbox/references/REFERENCE.md`.

ADR-013 already did the structural work that makes this resolvable:

- **§1** made `capture` "one uniform, dumb write to the artifacts table, regardless of source." Notes, links, transcripts, conversations are all artifacts; their kind is metadata. This argues against a second substrate for "operational signals."
- **§7** stored consumption as a positive lineage link (`artifact_external_links` with `kind='consumed_by_state'`), derived the rest. A synthesis consumer that folds artifacts into a state doc has a substrate-level idiom for "I've already used this."

In short: dos-inbox is a redundant memory layer in front of a synthesis pipeline (dos-hl) that should be reading from ahkms directly. The Notion Inbox DB is duplicative of the artifacts table; the dos-inbox skill is a duplicative surface in front of `/capture`. This ADR collapses both.

## Decision drivers

- **One mental model.** A user (and any shareable skill that depends on capture) should learn one capture interface, not two.
- **Shareable skills are non-negotiable.** Skill files must not contain per-user IDs, taxonomies, or secrets. ADR-013 §6 already established this — dos-inbox violates it.
- **The substrate already supports it.** Artifacts have `tags` (text[]), `source_channel`, `captured_at`. Consumption tracking is the `artifact_external_links`/`consumed_by_state` link from ADR-013 §7. `capture_preferences` already supports `default_tags` + regex `tag_rules`.
- **Source-agnostic substrate.** The same artifact stream should accept writes from skills, browser extensions, WhatsApp inbound, cron jobs, email-to-capture, etc., and be readable by any synthesis consumer (dos-hl today; weekly reflection, investor brief, retention tracker tomorrow). Anything baked into a single skill or single consumer leaks into surfaces that don't need it.
- **Decouple "what to write" from "how to interpret."** A regex tagging rule maintained at capture time has to keep up with vocabulary churn (every new advisor, every new product surface, every new domain). An LLM inference at synthesis time scales with content, not rule discipline.

## Considered options

### Option A — Two skills, shared infrastructure

Keep `/capture` and `/dos-inbox` as distinct live skills. Move dos-inbox's hard-coded Notion IDs, Domain taxonomy, and workspace check out of the skill file into a per-user `dos_preferences` row (mirroring `capture_preferences`'s pattern). Both skills can share an MCP capture core.

- **Pros:** preserves the two mental models honestly; minimal churn to the synthesis pipeline (dos-hl keeps reading from Notion Inbox); incremental.
- **Cons:** two substrates persist (Supabase + Notion Inbox); user learns two commands; dos-inbox's grouping logic stays in the producer (couples capture to one downstream synthesiser); breaks ADR-013 §1's "one capture primitive" principle.

### Option B — One `/capture`, full auto-routing at capture time

A single command. Routing rules in `capture_preferences` match Work entities and apply `workspace:work`, `domain:apple`, `type:state-change` tags at write time. No flag needed; the rules infer destination from content.

- **Pros:** one command; cheap at synthesis time (atoms are pre-tagged); leverages routing infrastructure that already exists in `captureConfig.ts:80-104`.
- **Cons:** maintenance treadmill — every new Work entity needs a rule update; failures are *silent* (mis-routes only show up at EOD as a garbled Daily Log); regex on raw text is brittle for things like Type inference (does "Apple replied to nonce issue" pattern-match as State change? as Note?); and the per-user rule set bloats over time.

### Option C — One `/capture`, mode via explicit flag

A single command surface, two modes selected by a flag: default = knowledge-store one-per-item; `--dos` (or similar) = the dos-inbox shape (walk last N messages, group by domain coherence, workspace check, Notion write).

- **Pros:** one command to learn; explicit user intent; failure modes are loud (if you forgot the flag, atoms land in the wrong shape and you notice).
- **Cons:** still two substrates behind one command; still couples capture to one synthesiser (the flag selects dos-inbox specifically); still requires the dos-inbox grouping logic to live in the producer; still maintains the rich Type/Domain enum at capture time.

### Option D — Fully dumb capture, fully smart synthesis (chosen)

One command (`/capture`). Capture is atomic per event/thought, writes one artifact per atom, applies no workspace/type/domain inference. The skill scopes via command shape: bare invocation walks back to the nearest topic boundary in the chat (max 30 messages); inline form uses the typed content. Downstream consumers (dos-hl, weekly reflection, future synthesisers) each query ahkms and apply their own interpretive lens at read time — workspace, type, domain are inferred per atom via LLM, filtered, then bundled. Consumption is marked via the ADR-013 §7 link.

- **Pros:** one command; one substrate; rules don't have to keep up with vocabulary; multiple synthesisers can apply different taxonomies to the same atomic substrate without coupling; producers (any surface — skill, extension, cron, inbound webhook) all write the same shape; dos-inbox skill retires entirely; matches the ADR-013 §1 "one capture primitive" principle.
- **Cons:** dos-hl does ~one classification LLM call per today's atom (modest at daily cadence: typically 5–15 atoms); workspace inference is O(N over all today's atoms for the user) per consumer (mitigable later via a workspace cache); tag-based namespacing (`workspace:*`, `domain:*`) is a convention, not a schema-enforced constraint.

## Decision

We chose **Option D**.

### 1. One command surface: `/capture`

`dos-inbox` retires. The `.claude/skills/capture/SKILL.md` is the sole capture skill. The vendored `reference/dotclaude/cowork-skills/dos-inbox/` directory remains in the reference snapshot for historical context with a deprecation note pointing at `/capture`; it is not promoted to a live skill.

### 2. Capture is atomic and dumb

One artifact per distinct event/thought. No grouping pass at capture time. If the user dumps a multi-topic brain dump (whether typed inline or recovered from chat look-back), the skill segments into N atomic artifacts and writes each via the existing `capture` MCP tool (`packages/mcp-server/src/tools/capture.ts:43-86`). No workspace/type/domain inference at capture time; only user-supplied tags and any rules the user has explicitly configured in `capture_preferences` fire.

This honours ADR-013 §1 ("capture does not bake in enrichment"): the artifact lands faithfully, and any interpretive enrichment is a separate, explicit step (now performed by synthesis consumers, see §4).

### 3. Two source modes, decided by command shape

- **`/capture [content]`** — segment the typed content into N≥1 atoms, write each.
- **Bare `/capture`** — walk backwards in the current chat to the nearest topic boundary (explicit topic shift in a user message, long pause if interpolable from message metadata, or hard cap of 30 messages back). Segment that scope into N≥1 atoms, write each. If the scope contains nothing capture-worthy, respond *"Nothing capture-worthy in recent context. What should I capture?"* and wait.

Command shape unambiguously selects the source. No content-based inference is needed at capture time to disambiguate "what does the user want to save."

### 4. Synthesis-time interpretation

Workspace, Type, and Domain are not capture-time concerns. Each synthesis consumer queries ahkms and applies its own taxonomy via LLM inference at read time:

- **dos-hl** infers `workspace ∈ {work, personal, …}`, `type ∈ {Note, Artefact, Decision, State change, Question for Angus}`, `domain ∈ {Apple, Pricing, EHS, …}` per atom; filters to `workspace=work`; bundles by domain coherence (the former dos-inbox grouping rule, now applied *after* inference, on a coherent dataset); writes a Daily Log entry to Notion.
- **Future consumers** (weekly reflection, investor brief, retention tracker, etc.) can apply entirely different taxonomies to the same atoms with no producer-side change.

This is what ADR-013 §1 anticipated ("Deriving tasks/entities/summaries is a separate, explicit step"), extended from tasks/entities to *interpretive metadata* itself.

### 5. Consumption marker via the ADR-013 §7 link

When dos-hl folds an atom into a Daily Log entry, it writes a row into `artifact_external_links` with `provider='notion'`, `kind='consumed_by_state'`, `external_id=<Daily Log page id>` (substrate from `supabase/migrations/20260606140000_047_add_artifact_external_links.sql:17-43`). The query for "today's unconsumed atoms for this user" becomes a `LEFT JOIN ... WHERE consumed_link IS NULL`. No status column on `artifacts`; no `status:consumed` tag. ADR-013 §7's "store the positive fact, derive the rest" applies as-is.

### 6. `search_knowledge` extends to support the synthesis query

The only required code/schema change is to extend the existing `search_knowledge` tool (`packages/mcp-server/src/tools/search.ts:54-82`) — which today supports only free-text + user_id + not-archived — with optional structured filters: `captured_after` / `captured_before` (or a single `captured_on`), and `not_consumed` (the LEFT JOIN above). Free-text query becomes optional when structured filters are supplied.

Alternative implementation — add a sibling `list_artifacts` tool with structured-filter semantics — is acceptable. Decision deferred to build time.

### 7. dos-hl re-roots on ahkms

When promoted from `reference/dotclaude/cowork-skills/dos-hl/` to a live skill at `.claude/skills/dos-hl/`, the Notion Inbox DB read is replaced with the filtered `search_knowledge` call. The per-atom LLM inference step (§4) is added before bundling. The Daily Log write to Notion is unchanged. The "flip inbox row to Consumed" step is replaced with writing `artifact_external_links` rows (§5). Per-user Notion IDs (Daily Log DB, State Doc, Tasks DB overflow, Meetings DB, Investor CRM) move out of the skill file into `user_integrations` (already established by migration 046 / ADR-013 §6).

## Consequences

### Positive

- ✅ One capture front door. Skills, extensions, inbound webhooks, cron all write the same shape to the same substrate.
- ✅ Shareable skill files. No Notion IDs, no per-user taxonomies, no workspace gates in the skill text.
- ✅ Interpretive layers compose. dos-hl, weekly reflection, investor brief, future consumers all read the same atoms with their own lenses; no producer-side coupling.
- ✅ Vocabulary churn doesn't break things. New Work entities are picked up by the synthesis-time LLM with no rule update.
- ✅ Lineage is preserved at the atomic level. A Daily Log entry has N source-artifact links, not bundled merges; ADR-013 §5 lineage works as intended.
- ✅ ADR-013 §1's "one capture primitive" principle now applies to the dos-* family too.

### Negative

- ❌ Per-atom LLM cost at synthesis time. Each dos-hl run does ~5–15 classification calls. Modest at daily cadence; non-modest if extended to bursty synthesisers running over weeks of atoms.
- ❌ Synthesis-time workspace inference is O(N over all today's atoms for the user). Acceptable for a single user (Angus) with a single dominant workspace; needs revisiting if multi-workspace usage becomes common.
- ❌ Workspace/Type/Domain become *conventions over tags*, not schema-enforced. A typo in a synthesiser ("workspaec:work") fails silently. Mitigable by centralising the tag namespace in a shared types module.
- ❌ Notion Inbox DB sunsets. Visual review of pending-but-uncovered atoms is no longer available in Notion. Workaround if needed: future Notion-as-projection mirror (see below).

### Neutral

- The Notion Daily Log DB, State Doc, Tasks DB, Meetings DB, and Investor CRM are unchanged. Only the *Inbox* layer in front of dos-hl is removed. This ADR does not revisit ADR-013's memory-vs-working-state split — Notion remains the working-state surface.
- The dos-hl skill's downstream behaviour (Notion writes, State Doc updates, overflow to Tasks/Meetings/Investor DBs) is preserved.

## Future enhancements (not now)

- **Backdating.** Today, `captured_at` doubles as the event-date. For the 1% of cases where a user records yesterday's work today, an explicit `captured_for:YYYY-MM-DD` tag would let dos-hl scope correctly. Add when the case actually shows up.
- **Workspace cache.** After dos-hl infers a workspace for an atom, write the result back as a `workspace:*` tag on the artifact. Next-day re-inference becomes a simple tag check. Implement when synthesis cost is felt.
- **Notion Inbox as projection.** A one-way mirror from ahkms to a Notion DB for visual review of pending atoms, if visual triage proves valuable. The mirror is non-authoritative — ahkms remains the source of truth — matching the ADR-013 §3 escape-hatch pattern.
- **Other downstream consumers.** Weekly reflection, investor brief, retention tracker, customer-comms timeline. Each is a new read-side skill against the same substrate; no producer changes.
- **Multi-user / non-Angus workspaces.** Workspace inference logic generalises beyond `work`; tag namespace stays the same.

## Implementation references

- `/capture` skill (to extend with bare-invocation look-back + atomic segmentation): `.claude/skills/capture/SKILL.md`
- Capture MCP tool (no change): `packages/mcp-server/src/tools/capture.ts:43-86`
- Routing infrastructure (used as-is): `packages/mcp-server/src/captureConfig.ts:80-104`
- Search tool (to extend with filters): `packages/mcp-server/src/tools/search.ts:54-82`
- Consumption link substrate: `supabase/migrations/20260606140000_047_add_artifact_external_links.sql:17-43`
- Preferences shape: `supabase/migrations/20260606120000_045_extend_capture_preferences_maps.sql`
- Per-user integration wiring (Notion IDs for dos-hl move here): `supabase/migrations/20260606130000_046_add_user_integrations.sql`, `packages/mcp-server/src/integrations.ts`
- Vendored dos-hl source (to promote and re-root): `reference/dotclaude/cowork-skills/dos-hl/SKILL.md`, `reference/dotclaude/cowork-skills/dos-inbox/references/REFERENCE.md`

## Links

- Builds on: [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md), [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md)
- Related: [ADR-007](./ADR007_Unified_Upload_Architecture.md) (unified upload pattern)
