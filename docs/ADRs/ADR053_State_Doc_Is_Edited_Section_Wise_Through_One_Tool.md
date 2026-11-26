# ADR-053: The State Doc is edited section-wise, through one tool

- **Status:** Accepted
- **Created:** 2026-08-10
- **Accepted-on-dev:** 2026-08-10
- **Deciders:** Angus (solo maintainer)
- **Builds on:** [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md)
  (the State Doc is a derived artifact),
  [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md)
  (projection, not overflow sink),
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) (one writer;
  Open Actions writes through to Tasks DB),
  [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md) (graph as
  projection source — north star, reached in steps)

## Context and problem

Three ADRs already say the State Doc is a projection. ADR-040 puts it flatly:
*"A projection that also stores things is neither."* None of them says how the
page is actually written, and the answer turns out to be: not through any of the
machinery those ADRs describe.

A verification pass on 2026-08-10, prompted by [#614](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/614),
established the ground truth.

**The tool that exists is unused.** `update_state_doc`
(`packages/mcp-server/src/tools/updateStateDoc.ts`) appends a heading plus
paragraphs to the page and does nothing else. Its docstring justifies that shape
by citing ADR-013 — *"Append-only so the page is a running state journal
(ADR-013)"* — but ADR-013 contains neither the word "append-only" nor
"journal". What it says (§ "project-state", and again under the artifact-state
model) is that the State Doc is *"maintained as a derived artifact"* and *"a
projection that folds artifacts in on a cadence"*. The constraint the tool
enforces was never decided; it was asserted in a comment and inherited.

**The ritual writes some other way.** `.claude/skills/dos-hl/SKILL.md` Step 5
reads the page with `notion-fetch` and applies approved changes with
`notion-update-page` against `state_doc_page_id`. So the one tool built for this
page is bypassed, and the actual writer is Notion's general-purpose
page-content endpoint, which has no concept of a section.

**That writer is destructive.** Observed on 2026-08-10 while editing meeting
notes through the same endpoint: `update_content` re-serialises a whole block
rather than patching a line. Across separate attempts an unrelated checkbox
flipped, one action item was deleted outright, and footnote syntax was rewritten
from `[^url]` to `[\[1\]](url)` on touched lines. Batching every edit into a
single call ran clean where sequential single edits did not.

**The result is visible in the document.** As of 2026-08-10 the State Doc was
last written 2026-07-27 and still asserted as current: a product/eng freeze that
had expired, "Angus OOO: Fri 31 Jul, back Thu 6 Aug", a cover arrangement for a
period that had ended, and a GTM priority order the 10 Aug weekly contradicted
outright. Its Open Actions list held **13** items against a configured
`open_actions_cap` of **10**. The page's own instruction is *"If something here
conflicts with the most recent Daily Log entry, this State Doc wins"*, so stale
content in it is not inert — it is load-bearing, and it is read at the start of
every operating-partner session.

The shape of the problem is the gap between design and mechanism. The ritual's
*design* is already section-wise: Step 5 presents diffs section by section with
explicit REPLACE lines, and Open Actions is already specified as a projection
with a deterministic ordering rule. It is executing that design through a tool
that cannot express it. Every symptom above follows from that one mismatch.

A second, smaller gap surfaced in the same session.
`meetings_source_data_source_id` — a single optional string in
`notionConfigSchema` — is the only meetings pointer the ritual has, and it points
at the public Meetings DB. Sensitive meetings have started moving to a separate
private DB (contractor pay, an open contractual dispute, runway detail, candid
remarks about a named workspace member who holds a full Notion login). The
ritual is therefore blind to exactly the meetings that matter most, and will stay
blind, because that migration is going to keep happening.

## Decision drivers

- **The State Doc must become a view.** ADR-022 and ADR-040 already decided this.
  What is missing is a write mechanism capable of honouring it — a tool that can
  only append guarantees the caps are breached over time, which is precisely what
  the 13-against-10 Open Actions list demonstrates.
- **One writer.** ADR-040: *"Idempotency guarantees are only worth what the
  least-careful writer honours."* Today the careful tool is unused and the
  careless one is in production.
- **Failures on this page are asymmetric.** A write that does too little is a
  second call. A write that does too much destroys prose that exists nowhere else
  and is read at the start of every session. Every mechanism choice below is made
  on that asymmetry.
- **No machine identifiers in the prose.** ADR-040 rejected its Option A for
  requiring *"smuggling artifact ids into State Doc text, which pollutes the
  projection with machine identifiers and contradicts ADR-022's framing."* That
  reasoning binds anything else tempted to hide state in the page.
- **Steps, not a big bang.** ADR-027 names graph-sourced projection as the north
  star and explicitly warns against the big-bang re-architecture. This ADR takes
  one step toward it and does not pretend to arrive.
- **Structure is not fixed.** The page says so itself: *"Sections evolve in
  importance over time; structure isn't fixed."* Any mechanism that assumes a
  known, stable section list is wrong on arrival.

## Considered options

### The write unit

#### Option A — render the whole document each run

The ritual composes the entire page; the tool replaces all of it.

- **Pros:** the purest reading of "projection". No addressing problem at all —
  the questions of how to find a section and where it ends simply do not arise.
- **Cons:** requires a generator for **every** section, and several have no
  upstream source anywhere but the page itself — Brand / messaging rules
  ("permanent"), Tech stack ("reference"), The four priorities, Legal /
  Compliance. Those are durable prose, not projections of anything. Building
  generators for them is ADR-027's north star (Option B, graph-as-source), still
  **Proposed**, and explicitly not a first step. It is also unsafe as a
  mechanism: whole-page replacement is delete-then-append against Notion, not
  atomic, so a mid-way failure truncates the document every session reads.

#### Option B — replace one section at a time (chosen)

- **Pros:** the sourced sections (Open Actions, Recent Communications, This week
  focus) can become real projections now; the reference prose is left alone. Matches
  the ritual's existing Step 5 design, which already thinks in section diffs.
  Failure is bounded to one section.
- **Cons:** the page remains a *store* for the reference sections, so ADR-040's
  "a projection that also stores things is neither" stays half-true. Accepted
  knowingly: the honest position is that those sections are not projections, and
  if that is to change they should graduate to a sibling page — a later decision,
  not this one.

### How a section is identified

#### Option A — a stable machine marker in the page

- **Pros:** survives renames; unambiguous.
- **Cons:** ADR-040 already rejected exactly this trade for exactly this document.
  A hidden section id is an artifact id in a different coat, in a page a human
  reads every morning.

#### Option B — position or a fixed enum of known sections

- **Cons:** both assume a structure that cannot move, and the page asserts the
  opposite. Dead on arrival.

#### Option C — exact heading text, refusing on ambiguity (chosen)

- **Pros:** the caller has just read the page — dos-hl fetches it at Setup — so it
  knows the current heading verbatim at call time. The classic weakness of string
  addressing, drift between read and write, barely applies to a single user doing
  read-then-write in one pass. No machine identifiers enter the prose.
- **Cons:** headings on this page are not stable — `# 🎯 This week focus — Week 27
  Jul – 2 Aug 2026` carries a date range that changes weekly, so that section is
  renamed, not updated, most weeks. Handled by making rename an explicit
  operation rather than an inference.

### Where a section ends

#### Option A — next heading of the same or higher level

The conventional rule, and it destroys this document. The page has exactly **one**
`#` heading, `# 🎯 This week focus`, sitting second among fifteen, with every
heading after it at `##` and no further `#`. Replacing the single most volatile
section — the one that is stale, and the reason #614 exists — would take the
entire rest of the page with it.

#### Option B — next heading of any level (chosen)

- **Pros:** worst case is replacing less than intended, which is visible and
  costs a second call. The heading levels on this page do not carry meaning: one
  stray `#` among fifteen `##`s is formatting, not hierarchy, and level-based
  nesting would be reading semantics out of markup that does not have them.
- **Cons:** a section cannot contain a subsection. Costs nothing today — there is
  not a single `###` in the document.

## Decision

### 1. Sections are the write unit, and structure is mutable

`update_state_doc` edits the page one section at a time. It may also add, remove,
reorder and rename sections — the page's structure is data, not a fixed schema.
It never renders or replaces the whole page.

### 2. A section is addressed by exact heading text, and ambiguity is an error

The tool matches the heading string exactly. **Zero matches or more than one
match is an error, never a guess.** A silent wrong-section replacement on this
page is unrecoverable loss of prose that exists nowhere else, and it propagates
to every session that reads the page before anyone notices.

Consequently, structural changes are explicit parameters, never inferred from a
failed match: replace-and-rename in one call, insert with an explicit anchor,
delete as its own operation. Changing the structure is always something the
caller asked for.

### 3. A section is a flat span

A section runs from its heading block to the next heading block **of any level**.
Sections never nest and never swallow a following heading.

### 4. The tool owns the freshness stamp

On every successful mutation the tool rewrites the `Last updated` line in the
page's header callout — automatically, not as a caller-supplied value. It may
also record which sections it touched, which it knows.

Two constraints follow. Only the `Last updated` line may be rewritten; `Sole
writer` and `Read by` are human-authored governance, not derived. And the write
goes through the block API against that block's rich text, never the page
content-update path, whose re-serialising behaviour is documented in Context
above.

Automatic rather than caller-supplied because a freshness signal the writer can
forget does not degrade to silence — it degrades to a false claim of currency, in
a document whose own rule is that it wins over the Daily Log. A run that updates
four sections and skips the stamp is worse than one that updates nothing. The
cost is accepted knowingly: a run touching five sections rewrites the callout
five times.

### 5. `update_state_doc` is rewritten in place, and becomes the only writer

The tool keeps its name and loses its append-only contract, gaining an
operation-based surface (replace, insert, delete, rename). `op` is **required**:
an old-style call fails loudly rather than silently doing something different on
a page read at the start of every session.

`dos-hl` Step 5 moves off `notion-update-page` and onto this tool. That migration
is not optional dressing — it is the decision. A capable tool that the ritual
does not call changes nothing, and leaving both paths live reproduces exactly the
condition ADR-040's "one writer" driver forbids.

Any caller may write through the tool — the EOD ritual, a Cowork session, a chat.
The invariant is the *tool*, not the *ritual*.

### 6. Private meetings are readable, never projectable

A **second named key** is added for the private Meetings data source. The
existing `meetings_source_data_source_id` is unchanged and remains the write
destination for meeting capture.

Not an array on the existing key. That key does two jobs — it is both the read
source for the Recent Communications projection and the routing destination for
captured meetings — and a list breaks the second: a new meeting cannot be written
to two databases, and nothing would say which one wins.

Named rather than anonymous because the two sources are not interchangeable.
`dos-hl` reads both, so it stops being blind to the meetings that matter most.
But content from the private source is **never projected into the State Doc**.
Notion exposes no API for page-level sharing — a page's ACL cannot be set or even
*read* programmatically — so no write to the State Doc can be preceded by a check
of who can see it. Read-but-never-project is the rule that survives not knowing
the answer (amended 2026-09-26 by #741: see Amendment 1 below).

### 7. The page's "Sole writer" line names the tool

`Sole writer: dos-hl ritual` is replaced by a line naming `update_state_doc`,
with an explicit note that hand-editing in Notion is an emergency measure.

The old claim protects the wrong thing. It forbids a Cowork session that would be
perfectly safe through the tool, while saying nothing about the one act that
actually breaks the invariant — typing directly into Notion. That act cannot be
prevented, only detected: a hand edit leaves the stamp untouched, so the page
reports a date older than its content. The claim was also simply false when
written, its most recent entry having been made by hand.

## Consequences

- **The ritual can maintain the document it is responsible for.** Replacing a
  stale section becomes an operation rather than an append that contradicts the
  text above it.
- **The caps become enforceable.** `max_words`, `open_actions_cap` and
  `communications_cap` are meaningful only against a writer that can remove
  content. Under append-only their breach was guaranteed, and had already
  happened.
- **The blast radius of a bad write shrinks from the page to one section**, and
  the wrong-section case becomes an error rather than a silent replacement.
- **`notion-update-page` is removed from the State Doc path.** Its re-serialising
  behaviour remains a hazard anywhere else it touches Notion AI meeting-note
  blocks; batching edits into a single call is the known mitigation. That is not
  solved here, only routed around for this one page.
- **The reference sections stay stored, not projected.** This ADR does not make
  the State Doc a pure view; it makes the projected parts of it real. Whether
  Brand rules, Tech stack and similar should graduate to a sibling page is left
  open deliberately.
- **`dos-hl` gains reach into sensitive material.** Reading the private Meetings
  DB is a widening of what the ritual sees. The not-projectable rule is the
  containment, and it is a rule in a skill body and a tool, not an enforced
  permission — Notion offers no mechanism that would make it one.
- **A hand edit is now detectable.** The stamp diverging from the page's content
  is the signal. Nothing consumes that signal yet; the natural consumer is the
  exception-only alert evaluator's ritual-silence condition
  ([#573](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/573)),
  which is itself inert in production for unrelated reasons
  ([#613](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/613)).
- **ADR-013's citation in the code was wrong and is removed.** No ADR is
  superseded by this; the append-only constraint was never a decision, so there is
  nothing to overturn.

## Links

- [#614](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/614) —
  the handoff that prompted this, and the source of the `notion-update-page`
  hazard observation
- [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) — the
  State Doc is a projection, not an overflow sink
- [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) — one writer; Open
  Actions writes through to Tasks DB; the rejection of machine identifiers in the
  prose
- [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md) — whole-document
  rendering from a single source is the north star this defers to
- [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md) — why the
  meetings pointers live in DB config rather than the skill body
- `packages/mcp-server/src/tools/updateStateDoc.ts` — the tool being rewritten
- `.claude/skills/dos-hl/SKILL.md` Step 5 — the writer being retired

## Amendment 1 (2026-09-26, #422, #741) — create_communication and private meeting routing

The Daily Log body is the one permitted surface for a communication that arose
from a private meeting, in the `angus` domain only. Never the State Doc, never
the Team, Investor or Advisor projections, never the Work Meetings DB.
`create_communication` (#422) refuses a `source: private_meeting` write to any
other destination and says why. Skill-body rule, since Notion has no page-level
ACL API.
