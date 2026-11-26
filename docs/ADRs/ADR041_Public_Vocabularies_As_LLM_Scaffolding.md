# ADR041: Public vocabularies as LLM scaffolding — why we adopt them, and where inference runs

- **Status:** Accepted
- **Created:** 2026-07-20
- **Accepted-on-dev:** 2026-07-20
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, knowledge-graph, vocabulary, ontology, inference, llm
- **Builds on:** [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) (FOAF + RELATIONSHIP),
  [ADR-033](./ADR033_External_Vocabulary_Adoption.md) (adopt-direct / mint-and-map),
  [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md) (`instance_of`
  derived at read)

> **Scope note (ADR-039 §2).** This ADR states *why* we adopt public vocabularies and
> *where* inference runs. It does not change components, boundaries, flows, or runtime
> topology, so it carries no `architecture.md` update. It does update
> [`docs/vision.md`](../vision.md), which principle 5 now reflects.

## Context and problem

[ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) adopted FOAF + RELATIONSHIP;
[ADR-033](./ADR033_External_Vocabulary_Adoption.md) generalised that to five vocabularies
(Schema.org, PROV-O, FOAF, SKOS, Dublin Core) and settled the adopt-direct / mint-and-map
rule. Both are Accepted and neither is revisited here.

Two gaps have since become load-bearing.

**1. The stated drivers are incomplete for an LLM-native system.** ADR-033's drivers are:
self-documenting graph, one canonical term per relation, no reasoner, reuse open
standards, low maintenance. All true — and all of them would apply equally to a system
with no LLM in it. The single strongest reason to prefer `foaf:knows` over a minted
`ahos:relatesToPerson` is absent: **the primary consumer of this graph is a language
model that already knows the public term and does not know ours.**

**2. ADR-033 carries a driver that is now false.** It states:

> *"**No reasoner** — the runtime graph is Postgres … Vocabularies are a **naming
> standard, not an inference engine**: nothing (`foaf:knows` rollups, `prov` derivation
> chains) is inferred 'for free'."*

That was accurate on 2026-07-05. It is not accurate now:

- [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md) (accepted
  2026-07-12, six days later) is titled *"`instance_of` derived at read"*; its §2 is
  *"`instance_of` is derived, never written"*. A view projects virtual type edges so a
  traversal *sees* `angus —instance_of→ people —exactMatch→ foaf:Person`.
- `RELATIONSHIP_VOCABULARY` in `@ahkms/shared` ships `symmetric`, `inverseOf` and
  `subPropertyOf: KNOWS` today, with `inverseOfType()` computing an edge's inverse at
  render time rather than storing both directions.

Inference *is* happening, at read, in Postgres, without a reasoner. The blanket phrasing
has already been mistaken for a general rule once (in a `docs/vision.md` draft, where it
was promoted to a load-bearing principle) — which is the failure this ADR closes.

## Decision drivers

- **Free inference from model weights.** Public vocabularies are extensively represented
  in LLM training data. A standard term arrives with its semantics already understood;
  a minted term arrives as a string.
- **Context economy.** Standard vocabulary costs zero tokens to explain. Bespoke
  vocabulary must be described in context on every call, permanently, competing with
  actual content for the window.
- **Inherit the modelling work.** FOAF, Schema.org and PROV-O encode years of design by
  people who thought hard about people, organisations, events and provenance. Adopting
  them inherits distinctions we would not have known to make.
- **Future multi-user by construction.** Graphs built on shared vocabularies are
  mergeable, comparable, and federatable without a translation layer. Two users'
  `foaf:knows` edges mean the same thing; two users' bespoke terms would not.
- **Derivation must not go stale.** Anything computed and stored is a cache with no
  invalidation story.
- **Messy input is the normal case.** A personal knowledge graph ingests partial,
  contradictory, low-quality data continuously. Machinery that rejects it is machinery
  that stops the system working.

## Considered options

### Option A — keep ADR-033's drivers as they stand

- **Pros:** no churn.
- **Cons:** leaves the strongest driver unstated and a false driver in place. The false
  driver has already caused one downstream error, and drivers are read as reasoning that
  licenses future work.

### Option B — state the LLM drivers, and draw the inference line by tier (chosen)

- **Pros:** records why adoption pays off *today* rather than only at some future
  density; replaces a blanket exclusion with per-mechanism verdicts that can be evaluated.
- **Cons:** a third ADR touching vocabulary; readers must hold ADR-021, ADR-033 and this
  one together.

### Option C — supersede ADR-033 and restate everything in one document

- **Pros:** one place to read.
- **Cons:** ADR-033's decision is correct and in force; superseding a sound decision to
  fix its rationale is disproportionate, and breaks existing citations. Rejected.

## Decision

### 1. Prefer a public, well-defined schema wherever one exists

Restating ADR-033's adopt-direct rule with its full rationale. Where no public term fits,
ADR-033's mint-and-map applies unchanged. **Three drivers, recorded as first-class:**

1. **Free inference from model weights** — the LLM already knows the term.
2. **Inherited modelling** — the vocabulary encodes design work we would otherwise redo
   badly.
3. **Multi-user by construction** — shared vocabularies make future federation a
   non-event rather than a migration.

### 2. The ontology is scaffolding for LLM reasoning, not a substitute for it

Structure removes the questions that never needed judgment, so judgment is spent on the
questions that do. Declared semantics (`symmetric`, `inverseOf`, `subPropertyOf`) are
readable facts an LLM can apply directly. This is why vocabulary investment pays off
**immediately**, under a no-reasoner policy, rather than only if a reasoner is ever added.

### 3. Inference runs at three tiers, with different verdicts

| Tier | Mechanism | Verdict |
|---|---|---|
| **Structural** | SQL views, joins, recursive CTEs | **In scope, and shipped.** Transitivity, inverse, sub-property, type. ADR-036's `graph_instance_of` is the reference pattern |
| **Semantic** | LLM reading the graph | **This is the product.** Identity judgment, relevance, salience — none of it deductive |
| **Logical** | Formal reasoning machinery | **Per-mechanism, below** |

Formal machinery is not rejected as a class. Each mechanism gets its own verdict:

- **Forward-chaining materialisation — rejected.** Computed inferences stored as rows are
  a cache without invalidation. ADR-036 already decided derive-at-read; this generalises
  it.
- **Hard consistency checking (rejecting writes) — rejected.** Contradicts ADR-021's
  deliberate choice of soft, application-layer validation, and would reject the messy
  input that is this system's normal case.
- **Soft consistency checking (surfacing warnings) — in scope.** Detecting a disjointness
  violation or a duplicate identity and *surfacing it for review* is the R3 discipline
  ("ambiguity is surfaced, not guessed") applied to data quality. Relevant to #310 and
  #173.
- **OWL reasoner as a runtime component — deferred.** Its value scales with how rich and
  true the axioms are; the graph is currently too thin for it to derive much. Revisit when
  entity properties are populated enough that real contradictions exist.
- **SPARQL endpoint — deferred, and explicitly the interoperability path.** It matters
  when parties other than this system query the graph — that is, when driver 3 becomes
  real. ADR-036/037's IRI grounding keeps it cheap to add.

### 4. Erratum against ADR-033

ADR-033's driver *"Vocabularies are a naming standard, not an inference engine: nothing is
inferred 'for free'"* is corrected to: **nothing is inferred by a reasoner; structural
inference is derived at read.** Its *decision* (adopt-direct when exact, mint-and-map when
approximate) is unaffected and remains in force. Per
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 this is errata — no new
decision is required to correct it — so ADR-033 is edited in place and its Status line is
not stamped.

## Consequences

- **Good:** the strongest reason for vocabulary adoption is on the record, so the
  investment is justifiable today rather than on a promise; a blanket exclusion is
  replaced by four evaluable verdicts; soft consistency checking becomes available for
  #310/#173 without reopening ADR-021; multi-user is preserved as a cheap future option.
- **Cost / bad:** three ADRs now govern vocabulary (021, 033, this). Contributors must
  read all three. Mitigated by `docs/vision.md` principle 5 carrying the summary.
- **Neutral:** no code changes are implied. The tier-1 mechanisms described already ship;
  soft consistency checking is newly *permitted*, not newly required.
- **Watch:** driver 1 is an empirical claim about model behaviour, not a logical one. If
  a public term turns out to be poorly represented in model weights, mint-and-map remains
  available and the driver simply does not apply to that term.

## Links

- [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) — FOAF + RELATIONSHIP, soft validation
- [ADR-033](./ADR033_External_Vocabulary_Adoption.md) — adopt-direct / mint-and-map; driver
  corrected by erratum here
- [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md) §2 — `instance_of`
  derived at read, the reference pattern for tier 1
- [ADR-037](./ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md) — IRI storage, what
  keeps SPARQL cheap later
- [`docs/vision.md`](../vision.md) — principle 5 and the *External schemas* section
- #310 (duplicate entities), #173 (entities lack structured attributes) — the first
  candidates for soft consistency checking
