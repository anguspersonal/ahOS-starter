# ADR042: Intelligent flows are first-class in ahOS — "capture is dumb" is scoped to the capture primitive, not the OS

- **Status:** Accepted
- **Created:** 2026-07-23
- **Accepted-on-dev:** 2026-07-23
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, capture, synthesis, automation, principles, vision
- **Builds on:** [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md)
  (capture primitive), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  (unified capture + synthesis-time interpretation), [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md)
  (sibling read-side consumers)

> **Scope note (ADR-039 §2).** This ADR scopes an existing principle and rewords one
> vision line. It changes no components, boundaries, flows, or runtime topology, so it
> updates no `architecture.md` — stated explicitly per ADR-039 §2. Minted under
> [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (same PR), the rule that a
> substantive vision change carries a why-record.

## Context and problem

The vision's load-bearing principle #2 read:

> **Capture is dumb; synthesis is smart.** No enrichment, classification, routing, or
> domain assignment at capture time. All interpretation happens at read time. (ADR-018 §4.)

The final clause — *"All interpretation happens at read time"* — is over-broad. It reads
as *"the only place intelligence lives is read-time synthesis,"* which turns the narrow,
correct claim about the **capture write** into a false claim about **the whole OS**.

This is not hypothetical. Reasoning over this exact wording (2026-07-23), an agent called
an autonomous email-triage engine a *"head-on collision with capture is dumb."* It is not
a collision at all — the engine is an intelligent flow that ends in dumb captures.

ahOS is a **capability + memory layer** (vision thesis; R6; the "two consumers" section).
It runs, or is intended to run, intelligent flows: synthesis (`dos-hl`), and — emerging —
email triage, weekly reports, LinkedIn post drafting. These are agentic capabilities, not
read-time interpretation of the graph. A principle that reads as "no intelligence outside
read-time synthesis" contradicts the system's own shape.

This is the repo's recurring failure mode — a narrow, locally-true statement hardened into
a general rule — the same mechanism the 2026-07-20 vision rewrite was itself written to
correct. Here the vision *summary* over-generalised the ADR it cited.

## Decision drivers

- **A principle must constrain what it was written to constrain** — the capture write —
  and no more. The primitive's dumbness (ADR-013 §1, ADR-018 §2) is genuinely load-bearing
  and is kept exactly; only the over-scoped *summary* is wrong.
- **ahOS's product surface includes intelligence.** Agents read the graph; sibling
  synthesis consumers run per domain (ADR-023); capabilities are first-class knowledge
  (R6). Bringing intelligent flows *inside* the OS is a goal — it is how the important
  information those flows touch gets captured within the OS — not a violation.
- **Guard against over-generalisation** — the exact drift the vision's *Keeping this
  document true* mechanism exists to stop.

## Considered options

### Option A — leave principle #2 as written
Rejected: it demonstrably produces confident wrong answers ("ahOS can't run an email
engine because capture is dumb").

### Option B — weaken or drop "capture is dumb"
Rejected: the primitive's dumbness is correct and load-bearing (ADR-013 §1 / ADR-018 §2).
The problem is scope, not substance.

### Option C — scope the principle to the primitive; name intelligent flows as first-class (chosen)
Keep "the capture write is dumb" intact; state explicitly that the OS is not; give the
reconciliation that dissolves the apparent tension.

## Decision

**1. Three planes; "dumb" binds only the first.**

| Plane | What | Intelligence |
|---|---|---|
| **Capture primitive** | The atomic write to `artifacts` | **None, by design** — no enrichment, classification, routing, or domain assignment. Only this is what ADR-018 §4 constrains. |
| **Synthesis** | Read-time interpretation of the graph (`dos-hl`) | Smart by design |
| **Intelligent flows / automations** | Agentic capabilities the OS runs — email triage, weekly reports, post drafting | Smart by design |

**2. The reconciliation.** An intelligent flow may **invoke the capture primitive as a
step**. The intelligence lives in the flow deciding *what/when* to capture and *what to do*;
the write it calls stays dumb. A *"smart flow ending in dumb captures"* is not *"smart
capture"* — there is no contradiction.

**3. The vision is reworded** (same PR) to scope principle #2 to the primitive and name
intelligent flows as first-class.

**4. ADR-018 is unaffected and needs no erratum.** Checked directly: ADR-018 §4's decision
constrains *capture-time* inference and moves *interpretation* to synthesis consumers, and
it explicitly anticipates automated producers (its drivers name "cron jobs,
email-to-capture") and many intelligent consumers ("weekly reflection, investor brief,
retention tracker"). The over-generalisation was introduced by the vision **summary**, not
by ADR-018. This ADR therefore clarifies the vision's *reading* of ADR-018; it does not
change ADR-018's decision, and stamps no supersession on it.

## Consequences

- **Good:** the principle stops generating false "ahOS can't do X" conclusions; intelligent
  flows inside ahOS are clearly in-bounds, which is what makes "the important information is
  captured within the OS" achievable.
- **Good:** the capture primitive's dumbness is preserved verbatim.
- **Neutral / future:** "intelligent flow" is a category `architecture.md` will describe as
  such flows actually land inside ahOS (`dos-hl` exists today; email triage is the personal
  Apps Script discussed 2026-07-23, not yet in ahOS). No current shape changes here, so no
  `architecture.md` edit (ADR-039 §2).

## Links

- [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md) §1,
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) §2/§4 — the
  primitive's dumbness this ADR preserves and scopes.
- [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) — synthesis
  consumers as first-class read-side intelligence.
- [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md) — sibling framing: the
  ontology *scaffolds* LLM reasoning rather than replacing it; here, the primitive scaffolds
  intelligent flows rather than being one.
- [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) — the governance rule under which
  this vision change is minted (same PR).
- Surfacing case: the personal Apps Script "Email Mgmt" triage engine (discussion 2026-07-23).
