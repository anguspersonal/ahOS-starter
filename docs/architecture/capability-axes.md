# Capability Axes — Personal Knowledge / Operating System

**Status:** ✏️ **Draft — working document.** Locks into **ADR-015** once the axes are agreed.
**Date:** 2026-06-06
**Owner:** Angus (solo maintainer)
**Related:** `docs/architecture/historical/ADR-draft-reconciling-repo-and-skills.md`, `docs/design/skills-portability-and-private-data.md`

> **Purpose.** Define the **capabilities** (axes) of the whole personal knowledge/operating
> system, independent of *implementation*. This taxonomy is the spine for the repo-vs-skills
> reconciliation (ADR-014): once the axes are yours, we run a per-axis dominance pass (which
> implementation wins each) and decide port / drop / keep-with-a-boundary per axis. **Get the
> axes right first; don't argue implementations here.**

## How to read this

- **Provenance:** `[yours]` = you named it; `[proposed]` = added because both systems clearly
  do it. Cut, rename, merge, split freely — this is meant to become *your* taxonomy.
- **Sub-dimensions:** the axes *within* an axis (e.g. Capture varies by type, domain, speed).
- **Boundary:** what separates this axis from its neighbours (prevents overlap).
- **Status:** `settled` / `needs-definition` / `maybe-merge`.
- This doc deliberately holds **no** "repo vs skills" judgement yet — that's the next step.

> **NOTE — this is a capability SET, not a workflow.** The order and numbering are
> reference-only. Capabilities compose in any order, repeatedly; they are not pipeline stages.
> (Pending v2 restructure — see "Round 1 stress-test outcome" below.)

---

## Locked decisions (feed ADR-015)

Agreed during refinement; no longer open:

- **Routing/Classification splits into two stages — 2a and 2b** (object/medium vs
  content/meaning). They classify different objects and route to different things; expect the
  repo to win 2a and the skills 2b. (2026-06-06)
- **Extraction (OCR / transcription / URL-fetch / parse) belongs to Ingestion (2a)**, not
  Enrichment. Enrichment is *semantic augmentation* of already-extracted content. (2026-06-06)
- **A composite capture is ONE artifact.** If a single capture contains multiple media —
  e.g. *"here's my meeting-notes audio file and here are my typed notes"* — that is **one
  artifact with multiple parts**, not several linked artifacts. Extraction (2a) runs per
  part; the parts compose into the single artifact's content. (2026-06-06)

---

## Intake

### 1. Capture `[yours]` — `settled`
Getting things *in* with minimal friction.
- **Sub-dimensions:** knowledge **type** (task / note / reference / quote / person / meeting / file); **domain** (Work / personal, + sub-domains); **speed/urgency** (throw / default / file); **modality** (text / file / URL / audio / image).
- **Boundary:** capture is *acceptance + echo*; deciding *where it lands* is Routing (next axis).

### 2a. Ingestion & Object Classification `[proposed]` — `settled`
Recognise *what shape was received* and turn it into clean content.
- **Sub-dimensions:** medium detection (note / file / URL / audio / image / **composite**); composite decomposition into parts (**one artifact, many parts** — see Locked decisions); extraction routing (which strategy per part); **extraction itself** (OCR / transcribe / fetch / parse → clean content).
- **Boundary:** classifies the **container** and produces content; does *not* decide meaning or destination (that's 2b). One capture object, synchronous. Expect the **repo** to win this.

### 2b. Content Classification & Routing `[proposed]` — `settled`
Decide *what the extracted information means* and *where it belongs*.
- **Sub-dimensions:** content-type detection (task / note / reference / quote / person / meeting…); domain inference (work / personal); urgency; per-object decomposition into constituent typed items (e.g. meeting note → note + 3 tasks); destination selection; conflict/ambiguity handling.
- **Boundary:** operates on extracted content from a *single* capture, synchronously. Cross-item, cadenced processing is Synthesis (axis 6); writing/keeping is Storage (axis 3). Expect the **skills** to win this.

---

## Knowledge core

### 3. Storage / Persistence `[proposed]` — `settled`
Where knowledge lives and how durably.
- **Sub-dimensions:** centralised vs dispersed; source-of-truth ownership; durability; schema/data model.
- **Boundary:** the *substrate*, not the act of getting in (Capture) or out (Retrieval).

### 4. Enrichment `[proposed]` — `settled`
Semantically augment **already-extracted** content (does **not** include extraction — that's 2a).
- **Sub-dimensions:** entity resolution + back-links; metadata derivation (e.g. URL→title/author); external research (web/LinkedIn); CRM coverage (Dex).
- **Boundary:** enrichment *adds meaning/links to an existing item's content*; getting raw content out of a file is Ingestion (2a); cross-item rollups are Analytics.

### 5. Retrieval `[yours]` — `settled`
Getting knowledge *out* by query — "ask."
- **Sub-dimensions:** keyword/FTS; semantic/vector; cross-store/federated; answer-synthesis vs hit-list.
- **Boundary:** point/lookup answers. Trend/aggregate answers are Analytics.

---

## Process & output

### 6. Synthesis / Workflow `[proposed]` — `settled`
Turning raw captures into structured knowledge on a cadence — the *operating rhythm*.
- **Sub-dimensions:** daily synthesis (EOD: inbox→Daily Log, State Doc update); weekly review (reflect: patterns/drift); state management (Unconsumed→Consumed, live source-of-truth); challenge/pushback.
- **Boundary:** this is the **operating-rhythm** workflow (human-in-loop rituals) — distinct from the *per-artifact enrichment* pipeline (which is Enrichment). Both are "workflow"; keep them separate.

### 7. Planning / Action `[proposed]` — `settled`
Forward-facing: prepare for, and execute, action.
- **Sub-dimensions:** prospective prep (day plans, meeting briefs); task/event creation; action execution (e.g. WhatsApp backlog → tasks/calendar/email/Dex).
- **Boundary:** Synthesis looks *backward* (what happened); Planning looks *forward* (what next).

### 8. Analytics `[yours]` — ❓ `needs-definition`
**Provisional read:** metrics/aggregates over activity & knowledge — priority allocation, cadence tracking, pattern/drift detection (today: partly in `dos-reflect`).
- **Open:** is this (a) operating metrics (where my time/priorities went), (b) knowledge-base analytics (what's in the store, gaps, coverage), or (c) both? **Your one-liner needed.**
- **Boundary vs Retrieval:** Retrieval answers "find X"; Analytics answers "what's the trend / distribution / pattern across many."

### 9. Evaluation `[yours]` — ❓ `needs-definition`
**Ambiguous — your call.** Candidate meanings:
- (a) **Decision quality** — judging choices/options (decision support).
- (b) **Information reliability** — scoring source/trustworthiness of captured knowledge.
- (c) **System-output review** — qa-review/address-review-style judging of produced artifacts.
- (d) **Self-evaluation** — the reflective "what am I avoiding / what went less well" judgement.
- **Open:** which of these (possibly several)? **Your one-liner needed.**

### 10. Visualisation `[yours]` — `settled` (scope TBD)
Representing knowledge/state for human consumption.
- **Sub-dimensions:** dashboards/views; generated artifacts (day plans, briefs, stakeholder updates); the (deferred) bespoke UI.
- **Boundary:** presentation of what other axes produce; not new computation.

---

## Cross-cutting (apply to every axis above)

### 11. Identity / Auth / Privacy `[proposed]` — `settled`
Private-but-portable access: who can reach the data, and how secrets stay out of shareable logic. See `docs/design/skills-portability-and-private-data.md`.

### 12. Portability across environments `[proposed]` — `settled`
Same capability usable across Chat / Cowork / Claude Code / Cursor / mobile; the open-source-reusable-skill question. (`route` skill is the current manual version.)

---

## Open questions (resolve to lock)

1. **Define Analytics** (axis 8) — one line.
2. **Define Evaluation** (axis 9) — one line; pick which meaning(s). *(Owner ruling: KEEP as a
   first-class capability — core to the app, just not built yet. Do not defer.)*
3. **Is the list complete?** Anything missing (e.g. *Notification/Triggers*, *Automation/Scheduling*, *Collaboration/Sharing*)?
4. **Granularity** — any axis to split (2a/2b — done) or merge (e.g. Analytics + Visualisation into Retrieve & Report)?
5. **Cross-cutting vs first-class** — are Auth/Privacy and Portability axes, or constraints applied to other axes? (Affects the dominance pass.)

---

## Round 1 stress-test outcome (2026-06-06) — v1 did NOT survive

A 3-adversary falsification pass (completeness / coverage / feasibility) found **blockers**.
Headline findings to fold into **v2**:

- **The "now vs later" discriminator is broken** — falsified by `whatsapp-blast` (many items,
  now, still routing) and composite meeting-notes (one item, fans out). Replace with
  **Trigger** (event vs cadence) × **Output** (per-item destination / internal artifact /
  external side-effect).
- **This is a capability set, not a workflow** (owner) — name capabilities as **verbs**; drop
  phase-implying groupings; numbering is reference-only.
- **Collapse Analytics (8) + Visualisation (10) into "Retrieve & Report" (5)** (owner ✓).
- **Keep Evaluation (9)** as first-class but mark `core · unbuilt · needs-definition` (owner ✓).
- **Demote Identity/Privacy (11) + Portability (12) to constraints; add Pipeline-Security**
  constraint (owner ✓).
- **Add (proposed, pending ruling):** `Monitor & Trigger` (proactivity: watch state → act on a
  condition) and `Maintain & Retire` (stewardship: retention/retire + correction/undo +
  provenance/audit). The whole *maintain/retire* + *proactive* half is currently absent.
- **6 vs 7 re-boundary:** Synthesise → internal knowledge artifact; Plan & Act → external
  side-effect.

### Provisional v2 shape (verbs; not yet ratified)

```
1.  Capture
2a. Ingest & Extract           (literal content)
2b. Classify & Route           (meaning + destination + defaults)
3.  Store
4.  Enrich                     (NEW external data only)
5.  Retrieve & Report          (absorbs Analytics + Visualisation)
6.  Synthesise                 → internal knowledge artifact
7.  Plan & Act                 → external side-effect
8.  Evaluate                   (core · unbuilt · needs-definition)
9.  Monitor & Trigger          (proposed — proactivity)
10. Maintain & Retire          (proposed — stewardship)
CONSTRAINTS: Identity/Privacy · Portability · Pipeline-Security
```

### First-cut capability → best tool (dominance pass, 2026-06-06)

| Capability | Best handler today | Target owner |
|---|---|---|
| Capture | cowork `capture`/`quick-capture`/`whatsapp-blast` | **Skills** |
| Ingest & Extract | repo `artifact_extract_text` + worker extraction | **Repo** |
| Classify & Route | cowork `capture`/`route` + `*-notion` tables | **Skills** |
| Store | Supabase (repo) | **Repo** |
| Enrich | Dex/web (skills) · `organizeEntities` (repo) | **Split** |
| Retrieve & Report | repo `knowledge_search` (FTS; rest unbuilt) | **Repo** ⚠️ |
| Synthesise | `dos` (repo skill, served cross-surface) / cowork `dos-reflect` | **Skills** |
| Plan & Act | cowork `prep`/`whatsapp-blast` + Gmail/Cal/Notion/Dex | **Skills** |
| Evaluate | — (unbuilt) | **Repo + agent** ⚠️ |
| Monitor & Trigger | — (unbuilt) | **Future host over repo** ⚠️ |
| Maintain & Retire | — (unbuilt) | **Repo** ⚠️ |

**Pattern:** *Skills own the doing (capture → route → synthesise → act); the repo owns the
substrate (ingest/extract → store → retrieve → provenance + auth'd private backend). Every
unbuilt capability lands on the repo side.* → ADR-014 leaning: **division of labour**, not
port-everything or status-quo.

## Locking → ADR-015

When the axes (now **13** after the 2a/2b split — names, definitions, boundaries) are agreed:
1. Freeze this list as the canonical capability taxonomy.
2. Promote to **ADR-015** ("Capability Taxonomy for the Personal Knowledge/Operating System").
3. Then run the **per-axis dominance pass** (repo vs skills vs neither) in ADR-014, and decide
   port / drop / boundary per axis.
