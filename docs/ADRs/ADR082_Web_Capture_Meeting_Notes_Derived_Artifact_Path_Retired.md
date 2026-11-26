# ADR082: Web capture's meeting-notes derived-artifact path is retired

- **Status:** Accepted
- **Created:** 2026-09-12
- **Accepted-on-dev:** 2026-09-12
- **Deciders:** Angus

## Context and problem

[ADR-061](./ADR061_Meeting_Notes_Are_A_Source_Adapter_Not_A_Capability.md) §6
found two meeting-note paths, split by surface, and deliberately left one of
them unsettled:

1. MCP `capture` never creates a `workflows` row
   (`packages/mcp-server/src/tools/capture.ts:185`), citing ADR-012's assemble
   design — orchestration is the agent's job, so the worker pipeline never
   fires.
2. The web capture route does create one
   (`packages/web/app/api/knowledge/capture/route.ts:312`). That fires
   `analyze`, which classifies an intent from a fixed list including
   `meeting_notes` (`packages/worker/src/workflows/steps/analyze.ts:44`), then
   `createDerived`, whose `createDerived.ts:1243` registered
   `createDerivedForMeetingNotes` — a processor that LLM-rewrote the note into
   a `cleaned_meeting_notes` derived artifact: restructured under headings,
   entities tagged `[[Name]]`, action items marked, filler stripped.

Path 2 does interpretation at capture time, which is the thing
[ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
§2 and §4 moved to read time: §2 makes capture atomic and dumb, §4 puts
inference in the synthesis consumer so a later consumer can apply a different
taxonomy to the same atoms with no producer-side change. So the two paths are
not two implementations of one agreed design; they are one path on each side
of a decision made after path 2 was built, and its own design docs are
already archived (`docs/archive/2025-Q4/feature-create-derived-artifact.md`).
ADR-061 §6 named three options — converge, grandfather, retire — and handed
the choice to [#874](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/874),
on one condition: no **third** path.

#874 also named the fact needed before choosing: *is the web capture route
actually in use, and does anything render `cleaned_meeting_notes`?* That was
established directly on the issue before this ADR was written.

## Decision drivers

- **The owner decided directly on #874: retire.** This is a human call, not
  one this ADR derives from the code; it is recorded here because it settles
  an ADR-061 §6 open question.
- **Nothing reads the type name.** Searching the repo for
  `cleaned_meeting_notes` outside `processors/meetingNotes.ts`,
  `createDerived.ts` and their tests returns nothing — no web component, no
  API route, no MCP tool. Option 1 (converge)'s stated cost, "whatever the web
  UI currently renders from `cleaned_meeting_notes` has to be re-sourced",
  does not apply: there is no bespoke rendering to re-source.
- **Existing rows survive as ordinary artifacts, not through the "Derived
  Pages" panel.** `createDerivedArtifactRecord` writes a `cleaned_meeting_notes`
  row into the `artifacts` table itself (its own id, `content_type: 'text'`,
  tagged `['derived', 'cleaned_meeting_notes']`) — deliberately not into the
  separate `derived_artifacts` table, per this function's own doc comment
  ("to ensure it has full artifact capabilities including editability").
  `linkDerivedArtifact` never sets the source's `has_derived_artifacts` flag;
  that flag is flipped only by a DB trigger on `derived_artifacts` INSERT
  (`supabase/migrations/20251226182232_remote_schema.sql`), which this path
  never touches. So the artifact detail page's "Derived Pages" panel —
  `packages/web/app/artifact/[id]/page.tsx`, gated on `has_derived_artifacts`
  and sourced from `fetchDerivedArtifacts`'s query of the `derived_artifacts`
  table, filtered to `artifact_type ∈ {thumbnail, split_page}`
  (`selectPdfPreviewDerivedArtifact`) — never has and never will show a
  `cleaned_meeting_notes` row; it is wired for PDF-preview images only.
  Existing rows stay reachable because they are ordinary, independent
  `artifacts` rows: `fetchArtifacts` (the list/search view) applies no filter
  that would exclude them, and `fetchArtifact(id)` renders any artifact's own
  `plain_text` on its own detail page. Retiring the processor stops new rows
  from being created; it neither deletes existing ones nor changes how they
  are reached. Deleting them is a separate data decision under
  [ADR-034](./ADR034_Lifecycle_Semantics.md), out of scope here.
- **The wider `createDerived` fan-out is load-bearing elsewhere.** The
  `document` intent processor (`processors/document.ts`) still produces
  `summarized_document` derived artifacts through the exact same
  `createDerivedArtifactRecord`/`linkDerivedArtifact` machinery the retired
  meeting-notes processor used — a live text-summarization feature, not (as
  an earlier draft of this ADR claimed) a PDF-preview-image feature: no code
  in this repo inserts into the `derived_artifacts` table that the "Derived
  Pages" panel reads, on any path, meeting-notes or document. Option 3's own
  hedge ("possibly the wider fan-out, if nothing live depends on it")
  resolves: `summarized_document` generation does, so only the
  `meeting_notes` registration is removed.
- **The `create_derived_artifacts` capture preference stays meaningful.** It
  is a generic per-capture/global toggle
  (`packages/shared/src/types/knowledge.ts`,
  `packages/mcp-server/src/captureConfig.ts`), read by the web capture route
  and gating whichever processor `createDerived` would otherwise run. After
  retiring `meeting_notes` it still gates the `document` processor, so it is
  not left pointing at nothing — unlike the two phantom threshold controls
  fixed in #951.

## Considered options

### Option A — Converge

The web route stops creating a `workflows` row for text captures and goes
through the same dumb-capture contract as MCP; a derived-artifact rendering,
if still wanted, becomes a read-side step.

- **Pros:** removes the surface split entirely; one capture contract for
  every surface.
- **Cons:** the stated cost (re-sourcing whatever renders
  `cleaned_meeting_notes`) turned out not to exist, so this option was paying
  to solve a problem that was not there. It also does more than #874 asked:
  it touches the web route's `workflows`/`analyze` orchestration generally,
  not only the meeting-notes derived artifact, which is a larger and
  differently-scoped change than this issue.

### Option B — Grandfather

Keep the processor and write down why the web surface is allowed to
interpret on the way in.

- **Pros:** no code change; cheapest in the short term.
- **Cons:** buys a documented exception to a rule
  ([ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  §2/§4) the rest of the system now depends on, for a path with no reader —
  nothing renders `cleaned_meeting_notes` by name, so there is no user-facing
  need the exception would serve. Every future reader of ADR-018 has to learn
  the exception for a benefit that does not show up anywhere.

### Option C — Retire (chosen)

Unregister the `meeting_notes` intent processor; delete
`processors/meetingNotes.ts`. Leave `createDerived`'s fan-out and the
`document` processor intact.

- **Pros:** removes capture-time interpretation on the only path that still
  had it, with no rendering to re-source and no live dependency on the
  removed processor; smallest change that actually resolves the ADR-061 §6
  question.
- **Cons:** existing `cleaned_meeting_notes` rows are untouched and remain
  reachable as ordinary, independent `artifacts` rows — retiring the
  producer does not retroactively reclassify what it already produced. If
  that is unwanted, it is a separate, later data decision.

## Decision

We choose **Option C — retire**.

1. `packages/worker/src/workflows/steps/processors/meetingNotes.ts` is
   deleted, and `createDerived.ts` no longer imports or registers
   `createDerivedForMeetingNotes`. `analyze` still classifies `meeting_notes`
   as an intent (used for tagging/entities/actions extraction); it simply has
   no processor to hand off to now, and falls through
   `routeToIntentProcessor` exactly as any other intent with no derived-step
   registered.
2. `createDerived`'s fan-out and the `document` intent processor are
   unchanged — `summarized_document` derived-artifact generation keeps
   working.
3. The `create_derived_artifacts` capture preference is left as-is: it still
   gates the `document` processor, so it keeps a real effect. Its
   user-facing copy ("Automatically create cleaned meeting notes and document
   summaries") is corrected to drop the now-false claim.
4. Existing `cleaned_meeting_notes` rows are left alone. They remain reachable
   as ordinary `artifacts` rows in the general list/search and on their own
   detail page — not through the source artifact's "Derived Pages" panel,
   which is wired to a different table and never carried them (see Decision
   drivers). Removing them is a separate data decision under ADR-034 and is
   explicitly not part of this ADR.

This also answers ADR-061 §6's "no third path" condition: there are now zero
capture-time interpretation paths for meeting notes rather than a converged
or grandfathered one, which is a stricter case of "no third path", not a
new path.

## Consequences

- **Good:** the web capture route no longer does capture-time content
  rewriting for meeting notes; ADR-018 §2/§4 hold everywhere now rather than
  holding-with-a-documented-exception.
- **Good:** `createDerived`'s remaining surface (the `document` processor and
  its fan-out machinery) is unchanged, so `summarized_document`
  derived-artifact generation is not at risk from this change.
- **Cost:** existing `cleaned_meeting_notes` rows persist as ordinary
  `artifacts` rows, with no `cleaned_meeting_notes`-specific handling left in
  the codebase to explain what they are; anyone auditing them later has only
  this ADR and the git history of the deleted processor.
- **Follow-up:** whether to purge or migrate existing `cleaned_meeting_notes`
  rows is open and belongs to ADR-034, not this ADR. Whether `analyze`'s
  broader capture-time classification (intent, entities, actions — not only
  the meeting-notes derived artifact) belongs on the web capture route at all
  is a larger question this ADR does not raise or answer; it is out of
  scope for #874, which named only the `cleaned_meeting_notes` path.

## Links

- Related: [ADR-061](./ADR061_Meeting_Notes_Are_A_Source_Adapter_Not_A_Capability.md)
  §6 (the decision this ADR settles), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  §2/§4 (capture is dumb; interpretation is read-time), [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md)
  (the assemble design MCP `capture` cites), [ADR-034](./ADR034_Lifecycle_Semantics.md)
  (governs any future deletion of existing `cleaned_meeting_notes` rows)
- Issues: #874, #638, #873, #951
