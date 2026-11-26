# ADR-057: `vision.md` reconciled against ADRs 044–055 — one refresh, one ADR, and what was deliberately left open

- **Status:** Accepted
- **Created:** 2026-08-23
- **Accepted-on-dev:** 2026-08-24
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, governance
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change requires a minted ADR — this is that ADR),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (four mechanisms; the citation guard)
- **Resolves:** #842, #844, #845, #846 · flips ADR-056's guard to `fail`

---

> **Same-PR sync note (ADR-039 §2).** This ADR exists *because* of the doc change, which
> is ADR-043's direction of the rule. It changes no components, boundaries, flows or
> runtime topology of its own, so it updates no `architecture.md` — stated explicitly
> rather than skipped.

## Context and problem

[ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) requires a minted ADR recording
*why* whenever `vision.md` changes substantively. This is that record for the 2026-08-23
refresh.

The audit behind it is #841: `vision.md` was last touched 2026-07-23; ADRs 044 through 055
landed 2026-08-05 to 2026-08-11 with amendments running to 2026-08-22; and **no ADR
authored since 043 cited or edited the vision.** Five substantive drift points were found
(#842–#846), plus nine citations of superseded ADRs.

The vision is the document new contributors and agents read first. A month of accepted
decisions absent from it is not cosmetic: it is the "confident wrong answers" failure the
document's own opening was written to correct, recurring within a month of that being
written.

## Decision drivers

- **The doc must match the decision record**, which is the whole claim ADR-043 makes.
- **A refresh must not smuggle in decisions.** Correcting what an accepted ADR already
  settled is bookkeeping; deciding an open question under cover of a doc edit is not, and
  is harder to notice in a large diff than in a small one.
- **The record should be readable later.** How many ADRs a refresh mints determines
  whether a future reader finds one explanation or five partial ones.
- **Integers are permanent** (ADR-039). Minting is not free and not reversible.

## Considered options

### Option A — one ADR per drift point (five ADRs)

- **Pros:** each correction carries its own rationale; a reader tracing one section finds
  a dedicated record.
- **Cons:** five ADRs for one pass over one document, all sharing a single cause (nobody
  reconciled the doc for a month) and a single date. It burns five permanent integers on
  what is one event, and it fragments the explanation: no single ADR would then answer
  "why did the vision change on 2026-08-23".

### Option B — one ADR covering the refresh (chosen)

- **Pros:** the cause is one event and is recorded once; one integer; the drift points
  are enumerated inside it, so nothing is lost. Matches how the corpus already treats a
  batch of related corrections — ADR-051 and ADR-052 carry multiple amendments in one
  record rather than spawning one ADR each.
- **Cons:** a reader looking for a per-section rationale has to read one section of one
  ADR rather than landing on a dedicated file. Accepted: the issues (#842–#846) carry the
  per-point detail and are linked from here.

### Option C — no ADR, treat it as a metadata fix

Rejected outright. ADR-043's carve-out is for typo, link and index fixes. Replacing the
Projections section's architecture is not that, and taking the carve-out here would be
the first crack in the rule this refresh exists to honour.

## Decision

**One ADR for the refresh.** The five corrections below are bookkeeping against already
accepted decisions; none of them decides anything new.

### 1. Projections: three sibling consumers → one `dos`, two domains (#842)

The section described ADR-023's three siblings and a plan to generalise "to N domains".
ADR-051 superseded ADR-023 outright and ADR-054 §7 retires all four `dos-*` names. The
section now records: one ritual, two axes (`domain` routes, `audience` shapes), two
domains wired from day one rather than N, and ADR-051 §10's two-level consumption, which
is what bounds catch-up to logs rather than atoms.

The Working-today bullet is corrected with it, and gains the fact ADR-054 §6 records: the
**personal State Doc exists and has never had a writer**. Listing "synthesis consumers for
three domains" as working claimed a capability one of the three never had.

### 2. Four decision areas added to the cut line (#844)

ADR-046's source-role ladder, ADR-052's derived-metrics rule *and* its §11 no-outbound-
channel gap, and ADR-048's inbound webhook surface. Each changes how the system behaves,
not only what it plans, and none appeared anywhere in the document. ADR-052 §11 is called
out specifically because the *Two consumers* section names the human-facing side as the
system's weakest part, and "ahOS cannot reach its owner at all" is weaker.

### 3. Multi-user is understated, not absent (#845)

"Nothing is being built for it yet" reads as permission to ignore multi-tenancy in new
code. ADR-045 holds three seams open by decision and expects live work not to close them.
The paragraph now names them and the `credential_ref` → vault path.

### 4. The bottleneck's four items are no longer one kind of problem (#846)

#173 and #310 lack design. #170 has ADR-049 with its design half shipped in #548, leaving
a production-data backfill deliberately held as an operator go/no-go. #137 has ADR-047.
The diagnosis (derivation quality is the bottleneck) is unchanged; what changed is that
half of it now needs execution rather than thought.

### 5. Every superseded citation is acknowledged, and the guard flips to `fail`

Nine citations of superseded ADRs are resolved in the prose, per ADR-056's rule. Two
**new** ones were introduced by this very refresh and caught by the guard before commit
(ADR-051 is itself superseded in part by ADR-054), which is the mechanism working on its
author. `ADR_CITATION_GUARD_MODE` is now `fail`: from here, a superseding ADR cannot land
while an apex doc still cites its predecessor in silence.

### 6. What this refresh deliberately does NOT decide

Recorded explicitly, because a large doc diff is exactly where a quiet decision hides.

*(The `domain` collision, #843, was in this list until the owner resolved it on
2026-08-24. It is now a decision — see §7.)*

- **The cut line's structure (#851) is untouched.** The argument that its rotting sections
  are aggregates which ADR-052 §1 says should be derived, and that Working-today is
  as-built content outside its docs lane, is real and is left standing for a grill. This
  refresh updates the contents of those sections rather than questioning that they belong
  there.
- **No watermark is added.** #850's `Reviewed-against` line is a separate mechanism with
  its own open questions; adding it here would ship an unreviewed threshold.

### 7. `domain` is single-valued — one home per entity, and it routes (#843)

Resolved by the owner on 2026-08-24, in the grill this refresh's §6 said was required.
It is a **reversal**, so it is recorded as a decision rather than folded in as bookkeeping.

**The rule.** An entity has exactly one `domain`. That single value is its home, and the
same value decides where the `dos` ritual writes it. There is no second domain and no
precedence between domains, because there is never more than one.

**Why the old position does not survive.** The vision argued for multi-membership from two
examples — a partner in `personal` and `wedding`, a colleague who becomes a friend in
`work` and `personal` — and concluded that "storing domain as a single field would force
duplication." Both examples depend on the *list* being fine-grained (`personal, work,
side-hustle, kids, wedding, …`). Against ADR-051 §1's two-value list neither generates a
second domain. **The multiplicity was downstream of the granularity, not a principle**, and
the granularity is gone.

**Where multiplicity actually went.** ADR-054 §2 already relocated it: the fine-grained
`domains` list became **`topics`**, nested per domain and multi-valued. Nothing expressive
is lost — a thing in the `angus` domain can carry the `wedding` topic. The axis survives
under a different name, one level down, which is why this is a rename of a concept rather
than the retirement of one.

**Naming — `primary_domain` was considered and rejected.** `primary_` implies a secondary
and so re-opens the door this decision closes. It is also already spoken for: ADR-049 uses
primary/secondary for PARA containment edges in the sense of *the one that wins among
several*, which is precisely the reading that must not attach here. The field is `domain`.

**Not decided here**, and left on open question 3: how an entity's domain is *assigned*
(the PARA-inheritance candidate stands), and whether it is stored as an edge to a
`entity_type='domain'` node or as a field on the entity. The old argument for the node —
that a single field would force duplication — was the multi-membership argument, so it
lapses with it, and the storage question is now genuinely open rather than settled by
premise.

**Two factual corrections to the record**, both found while checking #843 rather than by
review, and both load-bearing enough that leaving them would mislead the next reader:

- **#843's body states the routing domain is "stored as a single field per item." It is
  not.** No `domain` column exists on `artifacts` or `entities`; the only such column in
  the schema is on the unrelated legacy `training_examples` table. The routing axis lives
  in `user_preferences.dos_config` as `by_domain`, plus the `DOMAINS` constant — it is a
  parameter to the ritual, never a stored per-item field. This matters because it means
  **no shipped code ever violated the vision's principle**. The conflict was nomenclature,
  not architecture, which is why this resolves as a rewrite and not a migration.
- **#708 is not "the same collision one layer down."** Both #843 and this refresh's first
  draft cited it that way. #708 is `DOMAINS = ["work", "angus"]` declared twice, in
  `domains.ts` and `dosHlConfig.ts` — two copies of the *routing* axis, a DRY duplication
  with no bearing on the graph concept. Citing it as evidence made the collision look
  entrenched in code when it was not present there at all. #708 stands on its own merits.

The clearest evidence that the two really were separate axes is that they had already
drifted apart on vocabulary: migration 075 seeded the graph rows as `work` and
`personal`, while the routing axis is `work` and `angus`.

## Consequences

- **Good:** the apex doc matches the decision record for the first time since 2026-07-23.
  ADR-043's rule has been honoured once in practice, which is a precedent rather than an
  aspiration. The citation guard is enforcing, not just reporting.
- **Cost / bad:** one ADR means per-section rationale lives in issues rather than in the
  decision record, so a reader tracing one paragraph has one more hop. The refresh is a
  large diff to a document whose value depends on being read carefully, and its size is
  itself a review risk — mitigated by §6 stating what was deliberately not decided. The
  cut line is dated 2026-08-23 and will rot again. #851 is now decided (ADR-058) and
  removes the duplicated as-built section, but deliberately stops short of making the
  rest self-maintaining, so #850 remains what would report it.
- **Follow-up:** #851 (`needs-grill`; #843 was resolved here — see §7) · #850 (watermark) · #848
  (declaration block) · #847 and #620 (ADR-043 itself is still stamped `Proposed` on
  `dev`, so the rule this ADR honours is not yet formally Accepted — which is its own
  small absurdity and is tracked there).

## Links

- Builds on: [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md)
- Reconciles against: [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md),
  [ADR-047](./ADR047_Graph_Search_Entities_People_FTS_Embeddings.md),
  [ADR-048](./ADR048_Notion_Automations_Capability_And_Inbound_Webhook_Surface.md),
  [ADR-049](./ADR049_PARA_Containment_Primary_And_Secondary_Edges.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md),
  [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md),
  [ADR-055](./ADR055_Brevo_Connector_Via_Provider_Hosted_MCP_Upstream.md)
- Issues: #841 (the audit), #842, #843, #844, #845, #846 (resolved here), #851
  (deliberately not resolved — see §6), #849, #850, #848, #847, #708 (mis-cited by #843;
  see §7)
