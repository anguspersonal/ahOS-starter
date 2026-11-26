# ADR-080: Every issue carries exactly one status and exactly one priority

- **Status:** Accepted
- **Created:** 2026-08-30
- **Accepted-on-dev:** 2026-08-30
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, process, triage
- **Builds on:** [ADR-016](./ADR016_Discover_And_Index_Axis.md) (additive, not re-architecture),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§4: a surface that cannot report on its own absence is not a health surface),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (§7: a mechanism that does not earn its keep gets closed, and the narrowing recorded),
  [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (issues are the lane for plans and undecided questions)

## Context and problem

The triage vocabulary carried six state labels. Its own documentation already named the
working set, in its closing line:

> The three agent-facing labels, in contrast: `needs-angus` = don't touch; `needs-grill` =
> may draft, may not decide; `agent-ready` = execute autonomously.

Three more sat alongside that set without naming a next action:

- **`triaged`** — *"scope/approach clear enough to build without a grill"* — is `agent-ready`
  with the agent removed. The same claim, twice.
- **`needs-triage`** — *"needs more information **or design clarity**"* — overlaps
  `needs-grill` on its own definition, since design clarity is exactly what a grill resolves.
- **`wontfix`** is terminal, so it describes a closed issue rather than an open state.

Measured on 2026-08-30 across 130 open issues: **42, or 32%, carried a label that did not
say what happens next.**

**There was also no priority axis at all.** No priority labels, and no custom issue fields
(the repository's field list is empty). Two undefined labels, `backlog` and `one-day`, were
doing priority work informally on four issues.

## Decision drivers

- A label must answer *what happens next*, or it is decoration
- Every open issue must carry both axes, so "unprioritised" is a state that cannot hide
- Whatever is chosen has to be readable by everything that already speaks labels: the AFK
  protocol, the skills, and the triage tooling
- Nothing here should re-shape the substrate to add an axis

## Considered options

### Option A — GitHub Project with single-select Status and Priority fields

- **Pros:** genuinely single-select, enforced structurally; available on a personal account today; board and table views for free.
- **Cons:** every consumer needs rewiring, because none of the skills, workflows or tooling can read a project field. The values also live on the project rather than the issue, so an issue never added to the project silently has no state and appears in no view.

### Option B — Move the repository under an organisation

- **Pros:** unlocks org-level issue types and custom fields, the most durable form of the mechanism.
- **Cons:** large blast radius on things currently load-bearing — the GitHub App installations, the outside-collaborator arrangement, and Actions billing, which is *already* the subject of an open outage (#867). Moving billing while it is broken is not a controlled change.

### Option C — Two label families plus a check

- **Pros:** nothing needs rewiring; every existing consumer keeps working. The check lands where the repository's other invariants already live.
- **Cons:** enforced by a check rather than by structure, so a pair can be wrong between runs.

## Decision

**Option C.** Two mandatory label families, one value from each on every open issue.

### 1. Status says what happens next, and nothing else

| Label | Meaning | What an agent may do |
|---|---|---|
| `status:needs-triage` | Nobody has assessed this yet | Nothing; it is an inbox, never a resting state |
| `status:needs-grill` | A design fork is open | May append a draft grill as a comment; may not decide, may not relabel, may not build |
| `status:agent-ready` | No design ambiguity; scoped enough to execute | Execute autonomously |
| `status:needs-angus` | Requires a manual human step | Do not touch |

`triaged` and `needs-triage` are retired as bare labels. `wontfix` is retired outright: an
issue that will not be actioned is closed, not labelled.

**`status:needs-triage` is deliberately kept as the inbox**, against the first instinct to
drop it with `triaged`. Without it a newly filed issue has no status, and an issue nobody
has looked at becomes indistinguishable from one somebody forgot to label. That is ADR-052
§4's standard applied to the backlog itself: the count of unassessed issues is a number the
owner should be able to see, not an absence. It is an inbox and never a destination; an
issue resting there is a signal, not a state.

**The `needs-grill` → `agent-ready` promotion stays human-gated**, unchanged. An agent must
never self-promote, because the promotion asserts that a design fork is closed and only the
person who closed it can say so.

### 2. Priority is a separate axis, and it is mandatory

`priority:high`, `priority:medium`, `priority:low`. Exactly one, on every open issue.

Orthogonal to status by construction: a `status:needs-grill` item can be high priority (the
grill is urgent), and a `status:agent-ready` item can be low (correct, scoped, and not worth
doing yet). Collapsing them into one axis is what produced `backlog` and `one-day`, two
labels describing "not now" with no matching "now".

`backlog` and `one-day` are retired into `priority:low`.

### 3. Labels rather than fields, and the principle says so

The vision's test is explicit: *"reach for properties and tags before new machinery. Most
axes that feel like they need structure need a field."* A priority axis is the archetypal
case of an axis that feels like it needs structure.

The same section binds new capability to *"extends the substrate; it doesn't re-shape it"*,
which Option B plainly does not satisfy.

**Recording the trade honestly:** a single-select field is the stronger guarantee, and this
decision knowingly takes the weaker one. It buys compatibility with every existing consumer
and avoids moving Actions billing during an Actions outage. If the check proves insufficient
in practice, that is evidence for revisiting, and the revisit should be Option A rather than
Option B.

### 4. The check is on-demand, because the guard suite cannot see GitHub

`scripts/check-issue-labels.js` asserts exactly one `status:` and exactly one `priority:` on
every open issue.

It is **not** in the local guard manifest, and that is a deliberate limit rather than an
oversight. The guards run offline against staged files; this invariant lives on GitHub and
needs an authenticated API call, so a local pre-commit hook structurally cannot check it.

The natural home is a workflow firing on issue open and label change. That is not wired
here, because anything depending on Actions is a thing that does not run while #867 stands,
and shipping a workflow that cannot fire would assert enforcement that does not exist.

### 5. Lifecycle states join the status family (amended 2026-09-04)

§1 enumerated four statuses, all of them **triage** states: a person puts an issue in one by
assessing it. It did not account for the fact that automation also labels open issues.

`.github/scripts/issue-lifecycle.js` labels an issue when its PR merges to `dev`, and leaves
it **open**, because dev is not production. That label was `on-dev`, outside the `status:`
family. As long as the workflow's strip-list was broken (#968: it named the pre-ADR-080
labels, so its removes were no-ops) the issue kept its triage status and the omission was
invisible. Repairing the strip-list made it visible and load-bearing at the same moment:
the work status was genuinely removed, nothing replaced it, and **every merged-but-unreleased
issue would have had zero statuses** — violating §1 and failing `check-issue-labels.js`,
which reports `no status` at zero.

So this is not a free choice. Given §1's invariant and an open issue whose work has merged,
the lifecycle label must be a status.

**Two statuses are added:**

| Label | Meaning | Set by |
|---|---|---|
| `status:in-progress` | A PR is open against the issue, not yet merged to `dev` | A person, by hand |
| `status:on-dev` | Merged to `dev`, awaiting the `dev` → `main` release | `issue-lifecycle.js`, on dev merge |

A lifecycle status **replaces** the work status rather than joining it, so §1's invariant
holds unchanged at every point: one status before the merge, one after. `on-dev` is migrated
to `status:on-dev` in place by the same workflow the next time it touches an issue.

**`status:in-progress` stays manual, and that is a decision (#975, resolved 2026-09-04).**
Nothing sets it automatically when a PR opens, and nothing will.

The blocker is the PR that is closed **without** merging. Automatic assignment on PR-open
would leave such an issue asserting work is in flight when nobody is on it, and both
automatic repairs are worse than the disease: reverting to `status:needs-triage` demotes a
well-triaged issue to the inbox because a branch was abandoned, and restoring the prior
status requires recording it outside the label set, which reintroduces the
state-in-two-places problem §1 exists to avoid.

A human signal that goes stale when someone forgets is a smaller cost than automation with
a wrong-by-construction edge case. Owner's call, taken with the alternatives written down.

## Consequences

**A third of the board changes meaning.** 42 issues carried a label that is now retired.
Redistributing them is a mechanical pass and is tracked separately, not done inside this
decision.

**The unassessed count becomes visible.** Today it cannot be distinguished from an
unlabelled oversight. After this, `status:needs-triage` is a number, and a growing one is a
finding.

**Priority will start out mostly wrong, and that is expected.** Seeding 130 issues cannot be
a judgement, so it is a mechanical seed from existing signals, and the ADR says so rather
than letting a seeded value read as a considered one. The first pass over the backlog is
what makes them real.

**The check has no teeth until someone runs it.** It is a script, not a gate. That is
weaker than the guard suite and weaker than a single-select, and both are stated above
rather than left for a reader to discover.

## Refs

ADR-016 · ADR-052 §4 · ADR-059 §7 · ADR-075 · `docs/agents/triage-labels.md` ·
#536 · #968 · #975 · `.github/scripts/issue-lifecycle.js`
