# ADR-084: An entity's domain is derived by rule; the residue is stored as an override

- **Status:** Accepted
- **Created:** 2026-09-12
- **Accepted-on-dev:** 2026-09-12
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, graph, entities, domain, para, synthesis
- **Builds on:** [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  (capture dumb, interpret at read), [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md)
  (trust derived at read with a stored `trust_override` escape hatch — the precedent
  this ADR follows), [ADR-049](./ADR049_PARA_Containment_Primary_And_Secondary_Edges.md)
  (the primary `belongs_to` containment edge), [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
  §1 (the two-value `domain` routing axis), [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md)
  §2/§5 (`topics` rename; `domain_signals` classifier), [ADR-057](./ADR057_Vision_Reconciled_Against_The_August_ADR_Batch.md)
  §7 (one domain per entity, and it is a field, not an edge)
- **Resolves:** #935 — settles `vision.md` §*What this document does not decide*, fence 3

---

> **Same-PR sync note (ADR-039 §2).** This ADR adds one nullable, additive column
> (`entities.domain_override`) and decides a read-time derivation order that is not
> yet built — no resolver, no MCP tool-surface change, no skill update ships here.
> Nothing in `docs/architecture/architecture.md` describes an entity-domain
> mechanism today, so there is nothing there to update; the follow-up execution
> (below) updates it when it lands. `docs/vision.md` **is** updated in this PR, per
> ADR-043, because the fence this ADR closes lives there.

## Context and problem

[ADR-057](./ADR057_Vision_Reconciled_Against_The_August_ADR_Batch.md) §7 settled
that an entity has exactly one `domain` — the `dos` routing home, `work` |
`angus` (ADR-051 §1) — and that the old node-vs-field storage argument was moot,
because it rested on multi-membership and multi-membership no longer exists. It
deliberately left two things open and fenced them in `vision.md`:

> Not decided here, and left on open question 3: how an entity's domain is
> *assigned* (the PARA-inheritance candidate stands), and whether it is stored as
> an edge to a `entity_type='domain'` node or as a field on the entity.

[#935](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/935) is
that fence's issue. Its grill thread reaches a decision (2026-08-30), reproduced
here because ADR-039 §1 freezes decision content and the issue itself is mutable:

Angus's opening instinct — a judgement call by the synthesis agent at `dos` read
time — was half right: derive it, don't assert-and-store it, which is this
codebase's house pattern (ADR-018's read-time interpretation; ADR-026's trust,
derived at read with only an override stored). Where it did not hold: **domain
routes**, and a fresh per-read judgement can disagree with itself night to night
with nothing in the marker ledger able to notice — there is one Daily Log per
domain (ADR-051 §11) and coverage is counted per domain, so a drifting answer
reads as a covered day on one side and an uncovered day on the other. The
resolution, chosen by Angus from three options put to him: **derive by rule
first (PARA containment, then the `domain_signals` classifier); an agent judges
only where neither reaches; that judgement is remembered rather than re-guessed
each time.**

This ADR mints that decision and names the storage shape concretely, per ADR-075's
process for a resolved `needs-grill` fence: the leading candidate moved off the
issue and into a numbered record once decided.

**Two related but distinct uses of "domain" already exist, and this ADR must not
add a third collision** — the exact failure class #701 fixed once (ADR-054 §2):

1. The **routing axis** (`work` | `angus`) versus the **topic taxonomy**
   (`wedding`, `kids`, …). ADR-054 §2 already resolved this: `topics` owns the
   old meaning, `domain` means routing only. This ADR's `domain` is that one.
2. `entities.entity_type = 'domain'` rows (migration 075, ADR-019 §4) are
   **binding-layer scope nodes** for `create_binding` resolution — seeded
   `work`/`personal`, itself a naming drift ADR-057 §7 flagged as evidence the
   two axes had already diverged. This ADR's `domain_override` is an ordinary
   property on an ordinary entity row; it is never a pointer to one of those
   nodes, and this ADR does not touch, rename, or read them.

[#681](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/681)
(the `notion_personal` → `notion_angus` provider rename) was read for this ADR
and is unrelated: it renames a `user_integrations.provider` value for the
Notion credential the `dos` ritual writes through, not an entity property. This
ADR's `domain_override` values are `work`/`angus` regardless of how that
provider rename resolves.

## Decision drivers

- **One entity, one domain, and it routes** (ADR-057 §7) — already settled; this
  ADR does not reopen it, only how the value is obtained and kept.
- **Every caller must get the same answer.** The residual risk in a fresh
  per-read judgement is not accuracy, it is *disagreement with itself* — two
  reads of the same unchanged entity producing different domains, which a
  per-domain Daily Log ledger cannot detect (ADR-051 §11).
- **Domain is derived, never captured** (`vision.md` "The two axes"; ADR-018)
  — the same rule that already governs `trust` (ADR-026) and workspace/type
  classification generally.
- **Don't re-derive what the `dos` ritual already derives.** `dos` Step 1
  already classifies atoms into `work`/`angus` using `domain_signals` from
  `user_preferences.dos_config` (ADR-054 §5). A second, independent classifier
  for graph entities would be a second place the same judgement could disagree
  with the first.
- **No new machinery beyond need** (vision.md) — `belongs_to` (ADR-049) and
  `domain_signals` (ADR-054 §5) already exist and already do this kind of work;
  this ADR sequences them, it does not invent a third mechanism.
- **Storage stays narrow.** The argument `vision.md` made against a per-entity
  domain field was multi-membership forcing duplication. That argument is gone
  (ADR-057 §7), but nothing revives it as "therefore stamp every row" — a stored
  value should exist only where derivation cannot reach, or is wrong.

## Considered options

### Option A — judge fresh at read time, every time (Angus's opening instinct)

A synthesis agent decides an entity's domain each time it is asked, no storage.

- **Pros:** maximally flexible; no schema; matches the instinct that domain is a
  judgement, not a fact to assert.
- **Cons:** two reads of an unchanged entity can disagree, and the per-domain
  Daily Log ledger (ADR-051 §11) has no way to notice — a night that routes an
  entity to `work` and a later night that routes the same entity to `angus`
  both read as correct locally while one of them is silently wrong globally.
  Every non-`dos` caller (search, `entity_neighbourhood`, `process_artifact`)
  either re-runs the same judgement and risks a different answer, or has no
  judgement to call on outside a ritual session. Rejected on the grill thread.

### Option B — deterministic rule only (containment + `domain_signals`), no storage at all

Everything is derived every time from `belongs_to` and `domain_signals`; an
entity neither rule reaches is reported as unresolved, forever, on every read.

- **Pros:** the purest form of "derive, never capture" — zero schema, zero
  drift between stored and live.
- **Cons:** solves Option A's drift for the *reachable* population but not for
  the residue. An entity with no container and no signal match (a fresh person
  entity with a name only, say) would be asked about repeatedly with no memory
  of a prior judgement — the same disagreement risk as Option A, just confined
  to a smaller set. It also gives a human no way to correct a wrong containment
  or signal read short of restructuring the graph around it.

### Option C — assert and store a domain value on every entity

Every entity carries a `domain` written at creation or first classification,
the shape `vision.md`'s "does not decide" fence opened by ruling against.

- **Pros:** simplest possible read (one column, always populated); no
  derivation logic needed at read time.
- **Cons:** this is exactly the write-time assertion ADR-018/ADR-026's pattern
  forbids, and it duplicates what containment and signals already compute for
  free for the large majority of entities. It also silently reintroduces the
  cost the multi-membership retirement was supposed to remove: an asserted
  value drifts from a changed containment tree with nothing to notice, whereas
  a purely derived value never can.

### Option D — rule first; the unreachable residue is judged once and memoised as a stored override (chosen)

Combine B's low storage with C's stability, but only where B genuinely cannot
answer. Precedent: ADR-026 already does this for `trust` — derived at read from
a `surface → trust` map, with `trust_override` as the sole stored exception.

- **Pros:** matches the shipped precedent exactly; needs no new derivation
  primitive, only a defined order over two mechanisms that already exist
  (`belongs_to`, `domain_signals`); the same override slot serves both "the
  agent had to decide because nothing else could" and "a human is correcting a
  wrong rule answer" — one write path, not two.
- **Cons:** still a schema addition; a caller that skips the defined order (or
  applies it in a different sequence) can get a different answer than one that
  follows it, so "every caller agrees" depends on the order being followed
  everywhere, not merely existing.

## Decision

**We choose Option D.** An entity's domain is resolved in this order, and every
caller must apply it in this order to get the same answer:

### 1. `domain_override`, if set — the terminal case

Read verbatim; nothing below is consulted. Set only when neither of the next
two steps reaches, or to correct a wrong answer either of them gave. This is
the **only** place a domain is ever asserted rather than derived, and it is
deliberately the smallest population: most entities should never carry a value
here.

### 2. PARA containment — a thing inherits its container's domain

Walk the entity's primary `belongs_to` edge (ADR-049; secondary
`associated_with` edges are never followed — they carry no roll-up semantics).
If the parent resolves to a domain by this same order (recursively — an
override on the parent, or the parent's own container, or the parent's own
signal match), the child inherits it. A task inherits its project's domain; a
project inherits its area's. This is `vision.md`'s and #935's own leading
candidate, unchanged: "a task inherits its project's domain."

No primary edge, an archived one, or a chain that terminates without resolving
falls through to step 3.

### 3. `domain_signals` — the same classifier `dos` already uses

Match the entity's own title/description/tags/properties text against each
domain's `domain_signals` list in `user_preferences.dos_config`
(`by_domain.<domain>.domain_signals`, ADR-054 §5) — the identical list and the
identical matching the `dos` ritual's Step 1 already applies to atoms
(`.claude/skills/dos/SKILL.md` — "Route to exactly one `domain`... if the atom
references any of the `work` routing signals; otherwise `angus`"). Reusing
the live classifier means a graph entity and the atom that produced it resolve
against the same evidence, so they cannot disagree by construction on this
step. No match on either list falls through to step 4.

### 4. Residue — surfaced, not guessed, then memoised

Neither reaches. Per R3 ("surface, don't guess" — ADR-079's `review` band is the
same instinct applied here), this is **not** a silent default to either domain:
it is reported as unresolved until an agent (or the owner) makes a one-time
judgement. That judgement is written to `domain_override`, which means the next
read hits step 1 and never reaches this step again for that entity. The
judgement is made once; it is remembered, not re-derived.

### 5. Storage: `entities.domain_override`, nullable, narrow — mirrors `trust_override`

A new nullable `text` column on `entities`, `CHECK`-constrained to the two live
`DOMAINS` values (`packages/mcp-server/src/domains.ts`: `work`, `angus`),
added additively (migration 101). This is deliberately **not** a `domain`
column populated for every row — the shape `vision.md`'s fence opened by
arguing against. It is the exception hook, exactly as `trust_override` is for
`trust` (ADR-026): the *concept* is `domain`, resolved by the order above; the
*column* is `domain_override`, populated only for the residue or a correction.
Migration 101 lands the column only — see §7 below for what is deliberately not
built alongside it.

### 6. Node-vs-field is settled here, not by ADR-057 §7

**Correction to how this ADR's own precedent is read.** ADR-057 §7 settled
that domain is single-valued, but on storage it says the opposite of
"closed": *"Not decided here, and left on open question 3: how an entity's
domain is assigned... and whether it is stored as an edge to a
`entity_type='domain'` node or as a field on the entity... the storage
question is now genuinely open rather than settled by premise."* That
open question is #935 — the one this ADR resolves. What ADR-057 §7 did
settle is narrower and does carry through: the old argument *for* the node
shape was multi-membership, and multi-membership does not exist once an
entity has exactly one domain, so that argument no longer stands in the
way of a field. But "no longer stands in the way" is not "already decided
field over node" — this ADR is what makes that call, on #935's resolution
above (a narrow override column, not a general-purpose domain node), not a
call ADR-057 §7 already made.

### 7. What this ADR deliberately does not decide or build

- **Re-derivation on containment change**, named explicitly on #935's own
  closing comment as "a re-derivation question rather than an assignment
  question... it does not block the decision." If a task is re-filed under a
  project in the other domain, the *derived* answer (steps 2-3) changes on the
  next read for any entity relying on them, but a stored `domain_override`
  (residue-judged or human-set) does **not** recompute — it is a memo, not a
  cache, and stands until someone changes it. Whether a re-file should ever
  invalidate a downstream override is left open rather than silently assumed
  either way.
- **The resolver itself.** This ADR fixes the order and the storage shape; it
  does not ship a `resolveEntityDomain` function, the recursive-containment
  query, or wiring into `entities_get` / `entities_query` /
  `entity_neighbourhood` / `search_knowledge` / the `process_artifact` or `dos`
  skills. That is execution, tracked on
  [#1038](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/1038).
- **Whether `dos` Step 1's atom-level routing should switch to consulting an
  atom's linked entities' domain** rather than running `domain_signals`
  against the atom's own text directly. Both now read the same signals list
  and would agree by construction on step 3, so today's Step 1 is not wrong,
  only possibly redundant with what this ADR gives entities generally; folding
  them together is a separate, non-blocking simplification, not required by
  this decision.
- **Whether `entities_query`/`entities_update` should expose `domain_override`
  as a filter/patch field.** The column exists; wiring it into the MCP tool
  surface is part of the same follow-up as the resolver, since a field nobody
  can write is not yet useful, and writing it correctly means writing it
  through the order above rather than as a bare column patch.

## Consequences

- **Good:** graph entities get the same routing-stability guarantee `dos`
  already has for atoms, from the same evidence (`domain_signals`) and the same
  containment primitive (`belongs_to`) already shipped for other reasons — no
  new mechanism, only a defined order over two. Storage stays narrow: the
  multi-membership retirement (ADR-057 §7) is not quietly reversed into a
  column stamped on every row. `vision.md` fence 3 closes. The residue/override
  split gives a human a correction path for a wrong containment or signal read,
  which pure derivation (Option B) could not offer.
- **Cost / bad:** a schema addition for a concept `vision.md` explicitly worried
  would force duplication back in — mitigated by nullability and the narrow
  population, but the mitigation is a norm ("most entities should never set
  this"), not a constraint the schema enforces. Containment recursion is not
  free at read time for a deep PARA tree; no caching or depth bound is decided
  here. The re-derivation-on-move question is left open and could surprise a
  future reader who assumes `domain_override` always tracks live containment —
  it does not, by design, once set. "Every caller agrees" depends on every
  caller applying the four-step order identically; nothing in this ADR enforces
  that beyond naming it.
- **Follow-up:** [#1038](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/1038)
  (build the resolver and wire it into entity reads, `entities_query`/`entities_update`,
  and the `process_artifact`/`entity`/`dos` skills); the re-derivation-on-containment-change
  question (§7); whether `dos` Step 1 should consult entity-level domain rather than
  re-running `domain_signals` on atom text directly (§7, non-blocking).

## Links

- Builds on: [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md),
  [ADR-049](./ADR049_PARA_Containment_Primary_And_Secondary_Edges.md),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md),
  [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md),
  [ADR-057](./ADR057_Vision_Reconciled_Against_The_August_ADR_Batch.md),
  [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (the
  needs-grill-fence-to-ADR process this ADR follows)
- Related issues: #935 (this decision's grill thread and owner decision, dated
  2026-08-30); #701 (the `domain`/`topics` collision this ADR is careful not to
  repeat); #681 (the `notion_personal` → `notion_angus` provider rename — read,
  unrelated); #1038 (follow-up: build the resolver)
- Migration: `supabase/migrations/20260912120000_101_entities_domain_override.sql`
- Code (unwired by this ADR, named for the follow-up): `packages/mcp-server/src/domains.ts`
  (`DOMAINS`), `packages/mcp-server/src/dosConfig.ts` (`domain_signals`),
  `packages/mcp-server/src/tools/relateEntities.ts` (`belongs_to`/`associated_with`),
  `.claude/skills/dos/SKILL.md` Step 1
