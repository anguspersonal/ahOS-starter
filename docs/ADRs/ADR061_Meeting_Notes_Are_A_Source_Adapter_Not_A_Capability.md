# ADR061: Meeting notes are a source adapter, not a capability

- **Status:** Accepted
- **Created:** 2026-08-25
- **Accepted-on-dev:** 2026-08-25
- **Deciders:** Angus

## Context and problem

An agent with no access to this repo drafted a `meeting-note-processor` capability
spec: a two-phase pipeline (capture, then synthesis) with its own artifact status
machine, its own domain vocabulary, and its own approval boundary. Read against the
repo, most of it already exists. `meeting_notes_detect` finds notes by configured
rule (`packages/mcp-server/src/tools/meetingNotes.ts`), `event` is a first-class
entity type ([ADR-025](./ADR025_Event_Entity_Type.md)), and the human-versus-machine
provenance flag it proposes is
[ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) §6's
`synthesized` / `synthesized_unattended`.

The question the spec forced, and which
[#638](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/638) had
already asked and answered informally ("probably not"), is whether meeting notes
deserve a capability of their own at all.

Two facts make it urgent rather than academic. Notes already arrive from at least
four producers (Gemini, Plaud, Granola, Notion AI), each with its own structure. And
the repo already carries **two** meeting-note paths from different eras:

- MCP `capture` deliberately does not create a `workflows` row
  (`packages/mcp-server/src/tools/capture.ts:185`), so it never fires the worker.
- The web capture route does
  (`packages/web/app/api/knowledge/capture/route.ts:312`), which runs `analyze`
  (classifying intent `meeting_notes`) and then `createDerived`, whose
  `createDerived.ts:1243` registers an LLM processor that rewrites notes into a
  `cleaned_meeting_notes` derived artifact. Its design docs now live in
  `docs/archive/2025-Q4/feature-create-derived-artifact.md`.

The risk is not the duplicate. It is a third path.

## Decision drivers

- **Interpretation already moved to read time.**
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) §2
  makes capture atomic and dumb, and §4 puts workspace/type/domain inference in the
  synthesis consumer. A capability that classifies and rewrites a note on the way in
  re-imports exactly what that ADR moved out.
- **A per-source capability multiplies with sources.** Four producers today, and
  nothing suggests that is the ceiling.
- **Acquisition and interpretation have different natures.** Fetching a document,
  labelling an email and moving a file are mechanical and testable. Deciding what a
  note *means* is judgement, and judgement already has a home.
- **Two paths are a fact; a third would be a choice.**
- **No new state machine.**
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) §2 is
  explicit that each synthesis step checks only its own marker and that there is no
  global processed flag.

## Considered options

### Option A — a `meeting-note-processor` capability (the drafted spec)

- **Pros:** one named thing to invoke; the whole flow is legible in one document.
- **Cons:** owns a private artifact status machine that ADR-038 §2 rejects; performs
  classification and extraction at acquisition time, against ADR-018 §4; duplicates
  the synthesis ritual's half of the work; and its approval boundary depends on a
  private/public routing call that is explicitly unresolved
  ([#741](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/741),
  [#682](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/682)).

### Option B — one skill per producer (a Plaud skill, a Granola skill, and so on)

- **Pros:** each producer's quirks stay contained; no shared abstraction to get wrong.
- **Cons:** N skills for what is one artifact type; the interpretation logic is
  copied N ways and drifts; and the capability registry accumulates near-duplicates,
  which is the lineage problem ADR-050 §1 exists to prevent.

### Option C — one capture path: adapters acquire, guidance interprets (chosen)

- **Pros:** adding a producer costs an adapter, not a capability; interpretation
  stays in one place, on the read side, where ADR-018 put it; multi-source precedence
  lands somewhere principled rather than being invented per source.
- **Cons:** the read-side guidance grows a section per producer and nobody is
  enforcing that it stays coherent; and "an adapter must not interpret" is a
  convention, not a check, which is the same prose-not-enforcement shape as #682.

## Decision

We choose **Option C**.

### 1. A meeting note is an artifact. There is no meeting-notes capability

It is captured through the ordinary path and consumed by the ordinary synthesis
ritual. This answers #638's first question in the same direction that issue already
leant, and rejects the drafted spec's framing.

### 2. Adapters sit at the front and only acquire

An adapter's job begins at a producer and ends at a captured artifact linked to its
event entity. Concretely: find the note, fetch its content, capture it, link it to
the event, tidy the source surface. It performs **no** classification, **no**
summarisation and **no** rewriting.

[#873](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/873) is
the first adapter (Gmail/Gemini). Plaud, Granola and Notion AI are further adapters
and need no ADR each.

### 3. Guidance sits at the read end and only interprets

Per-format guidance lives in the processing path's prompt
(`.claude/skills/process_artifact/`), one section per producer, because a Plaud
transcript, a Granola summary and a Gemini notes doc do not share a shape. This is
#638's own proposal, adopted.

### 4. Multi-source precedence is a read-time question

Which source to trust for a contested claim is a judgement about content, so it sits
with the guidance, not with the adapters. #638's third question is thereby **placed**
rather than answered: the ranking itself is still open, but it now has a home and
will not be re-litigated per adapter.

### 5. Synthesis is `dos`, unchanged

Nothing here adds a synthesis path.
[ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
Amendment 2 established that the attended ritual is `dos` itself. That rename is
decided and not yet landed. The shipped skills are still `dos-hl`, `dos-personal`
and `dos-infra`, and the config blob is still `dos_hl_config`, which is tracked on
[#569](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/569),
[#621](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/621),
[#700](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/700),
[#701](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/701) and
[#705](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/705). New
work names `dos`.

### 6. The web worker path is out of contract and must be settled, not extended

The `analyze` → `cleaned_meeting_notes` path interprets at capture time on the web
surface. That is not merely an older duplicate; it sits on the wrong side of a
decision ADR-018 has since made. This ADR does not choose between converging it,
grandfathering it as a web-surface exception, or retiring it. That is [#874](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/874).
What it decides is that **no third path is added**, and that any new acquisition
work extends §2's adapter shape.

## Consequences

- **Good:** adding a producer is an adapter, which is mechanical, testable and needs
  no ADR. The interpretation surface stays singular, so improving how notes are read
  improves every producer at once.
- **Good:** the drafted spec's Phase A collapses to §2 and its Phase B collapses to
  the existing ritual, so the capability it proposed has nothing left to own.
- **Cost:** "adapters do not interpret" is a convention. Nothing in the code will
  stop an adapter summarising on the way in, exactly as nothing stops a State Doc
  write carrying private meeting content (#682). The containment is review.
- **Cost:** the read-side guidance accumulates producer-specific sections and will
  need its own tidying discipline.
- **Follow-up:** settle the web worker path (§6, #874); answer #638 with
  this ADR; land #873 as adapter one; the precedence ranking (§4) stays open.

## Links

- Related: [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-025](./ADR025_Event_Entity_Type.md),
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md),
  [ADR-062](./ADR062_Atom_Identity_Is_The_Entity_Not_The_Message.md)
- Issues: #638, #873, #874, #682, #741
