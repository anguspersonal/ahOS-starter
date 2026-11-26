# ADR-052: System metrics are derived, not stored — and the monitor sits outside what it monitors

- **Status:** Accepted — §4 narrowed and §5 amended in place 2026-08-22
  (three metric tiers), §5's heading superseded in place 2026-08-22
  (two surfaces — Dashboard and System), §6 and §8 amended in place 2026-09-25
  (no_material derived at read time, #664), §8 amended in place 2026-09-26
  (streak derived live over full history, in the dos preamble, #493); see the
  Amendment section below
- **Created:** 2026-08-06
- **Accepted-on-dev:** 2026-08-07
- **Deciders:** Angus (solo maintainer)
- **Builds on:** [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
- **Amended by:** [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md) (§8 and Amendment 7: `evidence_aggregated` extends and `evidence_aggregated_unattended` pauses, the attended kind of either family deciding a mixed day); [ADR-110](./ADR110_Metrics_Ride_Artifacts_And_State_Doc_Is_The_Human_Review_Gate.md) (§1 and the 2026-08-22 tier-3 note: retained third-party and ephemeral metrics ride `public.artifacts` at `role = 'metrics'` rather than a fifth storage table)

## Context and problem

On 2026-08-04 ahOS ran degraded for roughly a month — a dead inbox pipe, a stale
State Doc, embeddings down — and **nothing said so**. The failure was not that a
check returned the wrong answer; it was that no surface existed where the answer
would have been visible. It was found during an audit, not by the system.

Three issues were filed in response, on the same day, as three separate asks:
**#493** (streaks, to keep the human in the ritual), **#495** (a self-analytics
dashboard), **#494** (habit and personal-KPI tracking). Grilled together on
2026-08-06 they turned out to be one design with one substrate question
underneath it: **where do measurements live?**

[ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) §8
already answered a narrow version — *"the measurement falls out of the ledger; no
second store is built"* — but it said that about **ritual adherence
specifically**, and then assigned the streak mechanic to #493 and the coverage
view to #495 without generalising the constraint. Every subsequent design
conversation has quietly assumed the general form. This ADR makes the extension
an explicit decision rather than an inherited assumption, because the general
claim is materially stronger than the one §8 actually made and should not be
load-bearing while un-stated.

A verification pass over the schema during the grill established the ground
truth: `artifacts` and `artifact_external_links` both carry `created_at`, so
most candidate metrics **already have complete history** and need no store at
all.

## Decision drivers

- **The 2026-08-04 shape must become detectable**, not merely less likely.
- **No second store** — the single-maintainer constraint that runs through
  ADR-050 §8 and ADR-022/ADR-040. Every materialised copy is a thing that can
  disagree with its source.
- **A health surface that cannot be trusted is worse than none**, because it
  converts "I don't know" into a confident wrong answer.
- **The measurement must not depend on the thing being measured being healthy.**
  **— narrowed; see Amendment 2 below.**
- **Cheap now beats complete later** — most of this has no data behind it yet.

## Considered options

### Storage

**A — Daily snapshot atom for every metric.** A row per day carrying the day's
numbers.

- **Pros:** history for free; trivially chartable; uniform.
- **Cons:** buys history that already exists for five of eight candidate
  metrics; is a second store by any reading; and each snapshot is an artifact the
  ritual writes, which [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
  §9 then obliges us to exclude from the ritual's own day window. It creates
  work in order to buy something we mostly have.

**B — A dedicated metrics / time-series table.** Purpose-built storage.

- **Pros:** the conventional answer; efficient reads.
- **Cons:** the most explicit possible violation of the no-second-store
  constraint, for a single user whose entire corpus is small enough to scan.

**C — Derive live from the ledger; where history is missing, stamp the event
(chosen).**

- **Pros:** no store, no drift, and history is retroactive rather than starting
  the day the dashboard ships — a stamped event makes every past date computable,
  where a snapshot only ever knows the dates it happened to run.
- **Cons:** more query work per read; a genuinely event-less metric needs an
  escape hatch (§3); performance is a bet on the corpus staying single-user.

### Surface

**D — A Notion page.** Rejected — see §4.
**E — The ritual preamble only.** Rejected as the sole surface — see §4.
**F — One tabbed page in the web app, with the preamble as a ritual-time
excerpt (chosen).** **The *one page* half is superseded — see Amendment 5
below.**

## Decision

### 1. System metrics are derived, not stored

ADR-050 §8's constraint is **extended from ritual adherence to system metrics
generally**. There is no metrics table, no snapshot atom, and no streak column.
A metric is a query over the existing ledger, evaluated at read.

This is the clause that was previously assumed rather than decided.

### 2. Where a metric lacks history, stamp the event — never snapshot the aggregate

Verified against the schema, most candidates already have full history:

| Metric | Computable for an arbitrary past date? |
|---|---|
| Streak / days since last ritual | ✅ `synthesized` links carry `created_at` |
| Consumption lag | ✅ artifact `created_at` vs its link's |
| Captured vs consumed per day | ✅ |
| Per-source freshness | ✅ |
| Meeting coverage | ✅ |
| Embedding coverage | ❌ no "when embedded" |
| Entity dedup backlog | ❌ |
| Search health | ❌ |

For the three that fail, **the fix is a missing timestamp on the underlying
event, not a stored aggregate.** Adding `embedded_at` makes embedding coverage
computable for every past date, forever, from one column. Snapshotting the
percentage instead yields a series that begins the day it was switched on and
can never be reconstructed backwards.

> **Stamp the event and the aggregate derives forever. Snapshot the aggregate and
> you have built a store that only knows the days it ran.**

### 3. The escape hatch, and its test

§2 is *prefer a timestamp*, not *never snapshot*. Some future metric will have no
event behind it. The test:

> **Is there an underlying event that produces this number?** If yes, stamp the
> event and derive the aggregate. If the number is a property of the whole corpus
> at an instant, with no event that produces it, a stored snapshot is the honest
> representation.

The test dissolves more cases than it appears to. *Search health* looks
event-less — but a health probe **is** an event, so the decision is to record
probe results, not to snapshot a dashboard. Reach for a snapshot only after the
test genuinely fails, and record why when it does.

### 4. The monitor does not live inside what it monitors

> **Narrowed 2026-08-22 — see Amendment 2 below.** This clause binds the
> **liveness/error tier and the alert path**. It does not bind domain-specific
> pipeline health (computed from the database, so it cannot sit outside it), nor
> business/operational/life metrics, to which it does not apply at all. The
> rejection of Notion below is untouched and stands. **Neither the liveness/error
> tier nor the alert path currently satisfies this clause** — the narrowing
> records the requirement, not its satisfaction.

**Notion is rejected as the dashboard surface.** The Daily Log and State Doc both
sit behind the ahKMS → Notion write path, which is one of the things this
dashboard exists to watch. If that pipe breaks, a Notion-hosted dashboard cannot
report that the pipe broke. That is not a hypothetical: it is precisely the
2026-08-04 shape, where the month of degradation was invisible because every
surface was downstream of the break.

**The ritual preamble is rejected as the *sole* surface**, for the same reason in
a different key. It is visible only while the ritual runs, so **the day the
ritual stops is the day the dashboard stops being seen** — and a ritual that has
stopped is the single most important thing this dashboard has to report. A
surface that cannot report on its own absence is not a health surface.

The preamble is kept as a **ritual-time excerpt** (it already computes freshness
per [#489](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/489),
so it is nearly free), but the standing surface is the web app — upstream of
Notion, and reachable without running anything.

### 5. One dashboard, tabbed — not one dashboard per subject

> **Superseded in part 2026-08-22 — see Amendment 5 below.** The **heading no
> longer holds**: there are **two surfaces**, **Dashboard** and **System**, split
> by kind and discriminated by *my stuff versus the machine*. The **list below
> still stands** as the ownership boundary — its tabs are now distributed across
> the two surfaces rather than gathered on one. This supersedes the *heading*
> half of the pointer immediately below; that pointer's other clauses are
> unaffected.

> **Amended 2026-08-22 — see Amendment 3 below.** The heading and the list both
> **stand**; the one change is that **a metric may appear on more than one tab**.
> The metric tiers introduced in Amendment 1 are semantic, **not a surface
> split**: tier 1 (liveness and errors) is external by definition and therefore
> not a tab at all, and the tabs below are tiers 2 and 3.

| Tab | Subject | Owner |
|---|---|---|
| Home | curated selection promoted from other tabs | #577 |
| System | is ahOS working — pipeline health, lag, freshness, search, embeddings | #495 |
| Behavioural | streaks, gamification, ritual adherence | #493 |
| Fitness | — | #574 |
| Habits | inbox-zero / triaged days | #494 |
| Productivity | RescueTime drive and productive hours | #575 |
| Goals | progress against larger goals | #576 |

The tab list **is** the ownership boundary. It replaces an abstract subject/
surface rule considered during the grill: a new metric's home is decided by
inspection rather than by applying a test, and the boundary cannot drift because
it is a list rather than a principle.

### 6. One derivation layer, many readers

> **See Amendment 4 below (2026-08-22):** this is satisfied by construction — one
> module holding the logic, reached by two callers (an MCP tool and an API route).
>
> **Amended 2026-09-25 — see Amendment 6 below:** `get_synthesis_coverage`
> derives `no_material` at read time from `artifacts.captured_at` (the same
> bucket the other three states use), reporting zero-capture days distinctly.

Every surface — each tab, the Home tab's promoted copies, the ritual preamble,
and any alert evaluator — reads the **same** computation. Seven tabs each
implementing "days since last ritual" is seven chances to disagree, and a health
dashboard that disagrees with the ritual about the system's health has destroyed
the only thing it was for.

This binds hardest on Home, which is by definition a duplicate view.

### 7. A tile with no data behind it is marked structurally, not by a caption

Most tabs will ship mocked, because the pipes do not exist yet. **A mocked tile
must be visibly inert** — a stub that renders identically to a live number makes
the dashboard *less* reliable than having none, since it invites confident wrong
conclusions about system health.

This is [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
§13's principle in a second setting: absence is marked structurally, never as a
sentence, because prose gets skimmed and structure does not.

### 8. The streak

- **A day counts when the ritual ran.** Nothing else — grounded in ADR-051 §15
  (*a day is done because the ritual ran, not because every destination received
  a write*).
- **Three states, not two:** `synthesized` extends · `synthesized_unattended`
  **pauses** · neither breaks. The pause is what makes the
  [#561](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/561)
  fallback sweep worth building — it converts a hard break into a pause — while
  never letting the machine earn the streak on the owner's behalf. It also
  removes the need for any weekend/travel/holiday exception list.
  > **Amended 2026-09-25 — see Amendment 6 below:** streak arithmetic adds a
  > fourth derived state, **`no_material`**, for calendar days on which zero atoms
  > were captured. Like `synthesized_unattended`, `no_material` **pauses** the
  > streak rather than breaking it. Only `neither` (atoms existed, nothing
  > consumed them) **breaks**. An empty Saturday therefore neither breaks nor
  > inflates the streak.
  >
  > **Amended 2026-09-26 — see Amendment 7 below:** the streak is derived live over
  > the full marker history (never the caller's window), an in-progress today does
  > not break it, and it opens the `dos` preamble as `day N 🔥 · best M` (#493).
- **Inbox-zero is rejected as a criterion.** It is a perverse target for a
  judgement ritual: if a zero queue scores, the cheapest winning move is stuffing
  marginal atoms into the log to clear it, degrading the synthesis quality the
  streak exists to protect. It remains fine as a **habit tile** (#494) — watchable
  without being scored on.
- **Current streak plus personal best.** A broken streak reads `0`, which has no
  motivational content on exactly the night it is needed; a personal best gives a
  target from a standing start. Same scan, longest run instead of most recent.
- Derived per §1. No streak column.

### 9. Gamification stays at streaks until there is a supply of behaviours

Badges and levels are **deferred, not rejected**. Today there is one repeated act
to reward, no second player to compare against, and any earnable points number
invites the same cheapest-path gaming that §8 rejects. Their precondition is a
supply of distinct trackable behaviours — i.e. the Fitness / Habits /
Productivity tabs (#574, #494, #575) actually carrying data.

### 10. Prompting and alerting are two mechanisms, not one

- **The nightly prompt is a recurring calendar event.** Zero build, in a surface
  already in the daily loop.
- **Alerts are exception-only email**, fired **on the threshold being crossed,
  never on it being held.** An evaluator that emails whenever
  `days_since_ritual >= N` sends one every day from day N onward, which converts
  an exception alert into a daily digest and reintroduces the decay that made the
  nightly-email form unattractive in the first place. This requires durable
  per-condition state and a re-arm rule; `alerts.ts`'s 10-minute in-memory dedupe
  is not sufficient.
- **Held conditions surface on Home** (§5) rather than re-notifying. Email says
  something *changed*; Home says what is *still wrong*.
- Thresholds are DB config per [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md).
- **No alert path may run a ritual.** ADR-050 §8 (rituals are not autonomously
  schedulable) and #568 (a scheduled writer that synthesised days unbidden) both
  bear directly.

### 11. Named gap: ahOS cannot reach its owner

The grill hit the same wall three times under three different questions — the
streak is seen only once you are already in the ritual; the dashboard is unseen
on the days the ritual does not run; the most valuable alert is undeliverable by
display. One cause: **there is no outbound channel at all.**
`notification_preferences.daily_summary` is a boolean nothing reads, and
`packages/worker/src/utils/alerts.ts` is a complete, tested Resend sender with
zero callers.

Recorded here as a structural property rather than three symptoms, and tracked at
[#573](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/573).

## Consequences

- **Good:** no new storage, and therefore nothing that can disagree with the
  ledger. History is retroactive — stamping an event makes every past date
  computable, which a snapshot can never do. The tab list makes ownership a
  matter of fact rather than judgement. The 2026-08-04 failure becomes visible
  from a surface that is upstream of every component it reports on
  **— narrowed; see Amendment 2 below.**
- **Cost / bad:** every read recomputes, which is a bet that the corpus stays
  single-user and small; if that changes, §1 is the clause to revisit first, and
  the honest fix then is a cache with a stated invalidation rule, not a second
  source of truth. Most tabs ship mocked, so the dashboard's usefulness lags its
  existence by some months, and §7 is the only thing standing between that and
  actively misleading output. The three un-timestamped metrics need schema
  additions (`embedded_at` and equivalents) before they read correctly. And §10's
  crossing-not-held requirement is easy to implement wrongly in a way that only
  reveals itself as inbox noise weeks later.
- **Follow-up:** #573 (outbound channel) · #574 / #575 / #576 / #577 (tabs) ·
  #494 rescoped to Habits · #563 blocks the web app's deploy and therefore the
  standing surface · #564 remains a real gap (atoms the ritual saw and did not
  use are never marked) though it no longer blocks the streak · #491's Monday
  snapshot may be the writer for the Goals tab.

## Amendment

Recorded 2026-08-22 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1, from the owner's
observation that this ADR **conflates two different kinds of metric** — visible in
its own title against its own §5.

**Unlike the errata on
[ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) and
[ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md),
this carries a decision**, so the formula those use — *no correction changes a
decision, therefore the Status line is not stamped* — does not hold here. The
Status line **is** stamped, and every affected clause above carries an inline
pointer down to this section. It is recorded in place rather than as a successor
ADR because nothing below reverses ADR-052: §4's rule has a boundary drawn around
it, not a replacement.

### Amendment 1 — three kinds of metric, separated by who owns the answer

The title says *system metrics*. §5's tab list is Home, System, Behavioural,
Fitness, Habits, Productivity, Goals — **six of the seven are not system metrics
at all.** §4's rule was derived for observability and then silently extended to
cover life and business content that shares none of its properties.

Three tiers, separated by **who owns the answer**:

| Tier | Examples | Owner | Must survive ahOS failing |
| --- | --- | --- | --- |
| **1 — Liveness and errors** | is it up, is it throwing | An **external system**, outside ahOS | **Yes** |
| **2 — Domain-specific pipeline health** | embedding coverage, dedup backlog, consumption lag, per-source freshness | Self-built, inside | No |
| **3 — Business, operational and life** | streaks, habits, goals, fitness, productivity, Work KPIs | Fully inside | No |

- **Tier 1 sits outside ahOS because its defining property is surviving ahOS
  failing** — which is exactly when it is needed. **No specific vendor is mandated
  here.** As a matter of fact, Sentry is already partly wired and currently broken
  ([#661](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/661)),
  which is evidence that this tier already has a foothold in the stack — broken,
  and unowned.

  > **Citation refresh (2026-08-22):** #661's `requestLogger.js` half closed via
  > [PR #767](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/767).
  > The claim above — Sentry has a foothold in the stack, "broken, and
  > unowned" — still holds, but on different evidence now: no `SENTRY_*`
  > env var of any kind is configured in Railway production
  > ([#770](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/770)),
  > and `workflowMonitoring.ts` still calls the same removed v7 API
  > ([#764](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/764)).
  > Not a new decision — the tiering and its rationale are unchanged; only the
  > citation was stale.
  >
  > **Citation refresh (2026-08-22, later same day):** #764's `workflowMonitoring.ts`
  > half also closed, via
  > [PR #782](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/782).
  > "Broken, and unowned" now rests entirely on
  > [#770](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/770):
  > both files call the correct v10 API, but no `SENTRY_*` variable is set in
  > Railway production, so the code path is switched off rather than broken.
  > Still not a new decision — tier 1 still does not run.
- **Tier 2 is self-built and inside because it is computed *from the ledger***, and
  no external tool can know what an embedding or a pillar is. It goes down with the
  database, and **that is acceptable, because tier 1 is what reports that the
  database went down.**
- **Tier 3 is fully inside. §4 does not apply to it at all.**

The tiering is **conceptual, not a deployment boundary** — see Amendment 3. Which
specific metrics land in which tier, beyond the examples above, is not decided
here. And **tier 1 does not presently exist in a working form** — the table above
states what it must be, not what is running; see Amendment 2.

### Amendment 2 — §4 narrows to the liveness/error tier and the alert path; it is not reversed, and **neither currently satisfies it**

*"The monitor sits outside what it monitors"* **cannot mean the computation sits
outside.** Tier 2 is computed from the database, so if the database is down you
cannot compute it wherever the code lives. What must sit outside is the
**liveness/error tier and the alert path**. That much of §4 stands unchanged.

**Neither presently does.** The alert *channel* is external — a third-party email
API — but **the thing that decides to send is not**: the evaluator
(`packages/worker/src/schedule/alertEvaluator.ts`) and the sender
(`packages/worker/src/utils/alerts.ts`, §11) both run **inside the worker**. A
worker outage therefore emits nothing, which is **the one failure the alert path
exists to report.** And tier 1's other half is dead: the worker's Sentry
performance monitoring calls a removed v7 API against `@sentry/node@10`
([#661](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/661)).

> **Citation refresh (2026-08-22):** #661 is closed for `requestLogger.js`
> ([PR #767](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/767)).
> "Tier 1's other half is dead" now cites
> [#770](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/770)
> (no `SENTRY_*` variable of any kind is set in Railway production, so tier 1
> couldn't run even with correct code) and
> [#764](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/764)
> (`workflowMonitoring.ts` still on the same removed v7 API). The conclusion
> immediately below is unchanged by this — only its evidence moved.
>
> **Citation refresh (2026-08-22, later same day):** #764 is now also closed
> ([PR #782](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/782)).
> Both Sentry call sites (`requestLogger.js`, `workflowMonitoring.ts`) now use
> the correct v10 API. Tier 1 still does not run in production: the sole
> remaining cause is [#770](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/770)
> (no `SENTRY_*` variable set), a configuration gap rather than a code defect.
> The conclusion below — tier 1 does not presently exist in a working form —
> still holds, on narrower evidence.

**Stated plainly: tier 1 does not presently exist in a working form.** This
amendment records **the requirement, not its satisfaction** — a narrowing of §4 to
the tier that can bear it, not a claim that the tier is met. **Where the evaluator
should run is not decided here**; it lands on
[#573](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/573)'s
design, already the named owner of §11's outbound-channel gap.

Bounded this way, §4 becomes **enforceable rather than aspirational**. As written
it is a rule nothing can satisfy for tier 2 and nothing needs to satisfy for tier
3; bounded to tier 1 and the alert path, it has a subject that can actually be
tested against — and today that test fails.

§4's rejection of Notion as the dashboard surface is untouched and stands. Two
restatements of the same unqualified rule elsewhere in this ADR narrow with it: the
driver *"the measurement must not depend on the thing being measured being
healthy"*, and the consequence *"a surface that is upstream of every component it
reports on"*. Both are **requirements on tier 1**; neither binds a tier-2 read, and
neither is met today.

### Amendment 3 — §5 stands; the tiers are semantic, not a surface split; a metric may appear on more than one tab

> **Superseded in part 2026-08-22 — see Amendment 5 below.** This amendment's
> **surface answer** is reversed: *"the answer is still one dashboard"* and *"no
> surface split should be inferred"* no longer hold — **there are two surfaces.**
> Amendment 5 answers on comprehension grounds where this one answered on
> architectural grounds. **Everything else here survives**, in particular
> *§5's list stands and no classification rule replaces it* and *a metric may
> appear on more than one tab*. Read this amendment as **narrowed, not
> withdrawn**; nothing below is rewritten.

**§5's list stands, and no classification rule replaces it.** A list plus *group
like with like* is the right amount of process here; a new metric's home is still
added by inspection, exactly as before. The tiers in Amendment 1 say what a tab
*is* and who owns its answers — they are **not** a test for tab assignment, and
none is introduced.

**§5's heading stands unchanged.** *"One dashboard, tabbed — not one dashboard per
subject"* weighed **one dashboard** against **one per subject** and never
considered **one per kind**. That third option is recorded here as considered —
and **the answer is still one dashboard.** The tier distinction is semantic: it
exists to say what each tab *is* and who owns the answer, which is what releases
§4 from the content tabs. **No surface split should be inferred from it.**

What follows from tier 1 is an absence rather than a split: **tier 1 is external by
definition, so it is not a tab.** It lives in whatever external system owns it.
**Tiers 2 and 3 are the tabs**, exactly as §5 already lists them — one dashboard
carrying tiers 2 and 3, with tier 1 outside it.

**The one change to §5:** a metric **may appear on more than one tab.** §6 already
anticipates this for Home ("by definition a duplicate view"); this generalises it.

### Amendment 4 — §6 is satisfied by construction, and was never the hard problem it appeared to be

One module holds the logic and two callers reach it: an **MCP tool** for the chat
surface and the ritual preamble, and an **API route** for the dashboard. **They
cannot drift, because there is one implementation.** `get_synthesis_coverage` is
the existing worked example.

The apparent difficulty came entirely from System-as-observability sharing a
surface with the content tabs and dragging §4's survive-the-outage requirement onto
its neighbours. Amendment 2 lifts that requirement off the neighbours, and §6 is
left as a property of having one module rather than a discipline to hold across
seven tabs.

### Amendment 5 — §5's heading is superseded: **two surfaces**, split by *my stuff versus the machine*

Recorded later the same day, 2026-08-22, by the same owner, under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1.

**Amendment 3's surface answer is reversed.** It recorded *"the answer is still
one dashboard"* and *"no surface split should be inferred"*. **There are two
surfaces.** §5's heading — *"One dashboard, tabbed — not one dashboard per
subject"* — no longer holds.

**This is the first structural supersession in this ADR.** Amendments 1–4
narrowed, bounded and clarified, and the Amendment preamble above records in-place
recording on the grounds that *nothing below reverses ADR-052*. **That reason does
not cover this amendment**, which reverses a decided answer rather than drawing a
boundary around one. It is recorded in place regardless, at the owner's direction
and on the precedent Amendments 1–4 set for a decision-carrying amendment: the
Status line is stamped, the index row carries the same qualifier, and both §5 and
Amendment 3 carry inline pointers down to here. No frozen text is rewritten.

#### Why the answer changed — a different question, not a different mood

The reason differs from the one that produced Amendment 3, and that is what makes
this a **refinement rather than a flip-flop**:

- **Amendment 3 answered on architectural grounds.** The tiering does not
  *require* a split, therefore do not split. That reasoning is sound and is **not
  withdrawn** — it was answering a different question.
- **Amendment 5 answers on comprehension grounds.** **A surface should tell its
  reader which question it answers.** Once §6 is satisfied by one shared module
  with two callers (**Amendment 4**), splitting the surface carries **no
  architectural cost** — the derivation layer does not fork — so the
  comprehension argument **wins uncontested** rather than having to outweigh
  anything.

#### The two surfaces, in the owner's own framing

| Surface | The question it answers | Subject |
| --- | --- | --- |
| **Dashboard** | *"this is the place you look to see how you, your pipeline is going"* | The owner's own state **and their data flow**: streaks, habits, goals, fitness, productivity, Work KPIs, **plus** consumption lag, per-source freshness, embedding coverage |
| **System** | *"how is the underlying system doing, what's the system/platform health"* | Liveness, errors, worker health, deploys, search health, dedup backlog |

- **Amendment 1's tier 2 belongs on Dashboard, not with System.** The owner put
  *"your pipeline"* on the Dashboard side explicitly: consumption lag, per-source
  freshness and embedding coverage answer *how is my data flow going*, which is
  the question Dashboard exists to answer.
- **System carries Amendment 1's tier 1, plus infrastructure health.**

**The discriminator is *my stuff versus the machine*.** It is deliberately a
**reader-facing** test, not an architectural one — it can be applied **without
knowing how the system is built**, which is the whole point of splitting. A reader
who does not know what an embedding is still knows whether the question is about
themselves or about the machine.

#### What this changes, and what it does not

- **§5's list still stands as the ownership boundary**, exactly as Amendment 3
  recorded, and **no classification principle replaces it** — none is introduced
  here. The only change is that the tabs are now **distributed across two
  surfaces** rather than gathered on one; which tab sits on which surface follows
  from the discriminator above and is **not enumerated here**.
- **A metric may still appear on more than one tab** — Amendment 3's one
  surviving change — and the split gives that clause **real work to do**.
  **Per-source freshness is *me* when a Drive folder is empty and *the machine*
  when the connector is broken.** It can legitimately appear on **both surfaces
  with different framings**, and neither framing is the wrong one.
- **Amendments 1, 2 and 4 survive intact.** The three tiers stand; §4's narrowing
  to the liveness/error tier and the alert path stands, **including that neither
  currently satisfies it**; §6-by-construction stands. **Only Amendment 3's
  surface answer is superseded** — its *§5's-list-stands* and
  *more-than-one-tab* clauses survive. Amendment 3 is **not** wholly withdrawn.
- **Naming tier 1 as part of System's subject says what that surface answers, not
  where that tier runs.** Amendment 2 is untouched: §4 still requires the
  liveness/error tier and the alert path to **sit outside ahOS**, and **neither
  does today**. Where tier 1 itself lives is **not decided here**.
- **Recorded as given, including its one rough edge:** *dedup backlog* is a
  **tier 2** example in Amendment 1 and appears in the **System** list above. The
  **discriminator, not the tier, is the test** — so *tier 2 sits on Dashboard* is
  a strong generality rather than a mapping, and Amendment 1's tier table is
  **not re-cut here**.

### Amendment 6 — zero-capture days derive no_material at read time (2026-09-25)

Recorded 2026-09-25 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1, resolving
[#664](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/664).

Under ADR-051 §15 ("a day is done because the ritual ran. Not because every
destination received a write. A domain with no material that day produces no
summary, and that is not an incomplete day") and §11 ("Nothing captured, no
log"), a day with zero captures has no daily log and nothing to stamp. Because
`artifact_external_links` requires `artifact_id` and `external_id` (both NOT
NULL), no synthesis marker could exist, causing empty weekend days to read as
`neither` and break the streak.

**Decision: derive `no_material` at read time from `artifacts.captured_at`.**
No new schema, no write.

- `get_synthesis_coverage` reports a fourth per-day state, `no_material`, when
  zero atoms were captured on that date (excluding Daily Log twins). It is
  derived from `artifacts.captured_at`, the same bucket the other three states
  use.
- **Streak arithmetic (§8):** `synthesized` extends, `synthesized_unattended`
  and `no_material` **pause**, and `neither` (atoms existed, nothing consumed
  them) **breaks**. An empty Saturday therefore neither breaks nor inflates the
  streak.
- **Coverage view (§5, #495):** renders `no_material` as a distinct neutral
  mark, not as uncovered.
- **Adherence limit:** adherence per ADR-051 §15 is not claimed for a
  `no_material` day, because the ledger cannot tell "ran and found nothing"
  from "did not run". Documented as a known limit; revisit only if a cheap
  run-record appears.

### Amendment 7 — the streak is derived live over full history and opens the dos preamble (2026-09-26)

Recorded 2026-09-26 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1, resolving
[#493](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/493).
Builds on Amendment 6: it consumes the `no_material` / `captured_atoms` fields
that amendment defines and adds no second derivation of them.

- **Derived live, never stored (§1).** `current` and `best` are recomputed on
  every read from the synthesis markers and `artifacts.captured_at`, scanning the
  **full** marker history for the domain — not the `[from, to]` window a
  coverage call happens to list. A caller asking for a six-day sweep window must
  not see the streak capped at six.
- **Streak arithmetic (§8, with Amendment 6's states):**
  - `synthesized` extends the streak (`current++`, `best = max(best, current)`).
  - `synthesized_unattended` and `no_material` **pause** it (`current` unchanged).
  - `neither` (atoms existed, nothing consumed them) **breaks** it (`current = 0`).
  - **An in-progress day (today) that has not yet been synthesized does not
    break the streak** — the ritual for today may simply not have run yet.
- **Preamble presentation:** the `dos` ritual's Step 0 source-health report opens
  with the streak line, `day N 🔥 · best M`, derived live via
  `dos_synthesis_coverage`, which also carries it as the `streak:` line of its
  output.

### Bears on, not settled here

Named so the next reader inherits these rather than rediscovering them.

- **§5's System-tab gloss straddles two tiers** — *"is ahOS working"* is tier 1;
  *"pipeline health, lag, freshness, search, embeddings"* is tier 2.
- **§2's search-health probe runs inside what it measures** — §3 resolves it as an
  event, but an in-ahOS probe goes down with ahOS.
- **§1's "system metrics generally" is now ambiguous about tier 3** — fitness,
  RescueTime and Work KPIs largely arrive as ingested third-party data, and are
  therefore stored by definition.

## Links

- Builds on: [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
- Related: [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md),
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md),
  [ADR-049](./ADR049_PARA_Containment_Primary_And_Secondary_Edges.md)
- Related issues: #493, #494, #495, #573, #574, #575, #576, #577, #489, #491,
  #561, #563, #564, #568, #310, #427, #486, #664; #661 (closed via PR #767) and #764
  (closed via PR #782) — see the 2026-08-22 Amendments' citation-refresh notes;
  tier 1's current evidence is #770 alone (a config gap, not a code defect)
- **Current-state sync:** none required. No component described here exists yet —
  there is no dashboard, no metrics layer, and no alert evaluator. Per the ADR
  README's same-PR rule, this is stated explicitly rather than skipped;
  `docs/architecture/architecture.md` is updated when the dashboard ships.
