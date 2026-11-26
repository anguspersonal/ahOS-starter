# ADR102: Operating model: an architect writes packets, an executor builds them, the owner decides at forks

- **Status:** Accepted
- **Created:** 2026-10-04
- **Accepted-on-dev:** 2026-10-04
- **Deciders:** Angus Hally (solo maintainer)
- **Tags:** process, agents, quality, documentation
- **Issue:** #1321
- **Amends:** [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (adds the work packet as the required shape of an `agent-ready` issue)
- **Related:** [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md), [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)

## Context and problem

ahOS is built by one owner with limited time, and by agents. From October 2026 the owner has
unlimited use of a cheap coding agent with limited reasoning, alongside a stronger model
used sparingly. The 2026-10-04 architecture review (#1321) showed what happens when a
capable-but-shallow agent is handed a vision and a repo: it produced correct-looking work
that broke the production build, published an API key, bypassed the action layer it was
asked to build, swallowed errors into fake success, and rewrote the as-built architecture
document as if the target were already real. Every one of those was a failure of
*judgement*, not of typing, and every one would have been caught by a rule a machine could
check or by an acceptance test written before the work began.

The repo already has most of the machinery such a model needs: the status labels and their
permissions (`docs/agents/triage-labels.md`), the QA loop (`qa:ready` → review →
`qa:approved` → auto-merge), the AFK protocol, twenty blocking guards, the four
documentation lanes (ADR-075), and the ADR record. What it lacks is a stated division of
labour that matches the agents' abilities, a required shape for the work an executor is
handed, and guards for the specific ways a shallow agent drifts.

## Decision drivers

- **Speed with control.** Unlimited execution capacity is only useful if the rate at which
  it can do damage is lower than the rate at which it can be checked.
- **The architecture lives in machines, not memory.** An executor must not need to
  remember the mental model (ADR-101); a guard must reject anything that breaks it.
- **Judgement is scarce; spend it at forks.** The owner's time goes to decisions only a
  person can make. The architect's time goes to design, packets and design-bearing review.
  Everything else is executor work.
- **Done is observable.** An acceptance test exists before work starts, or the work is
  not ready.
- **One record.** GitHub is the only durable state (AFK protocol §0): packets are issues,
  decisions are ADRs or grill answers on issues, progress is PRs.
- **Measure outcomes, not output.** PR count is not progress; the cut line in `vision.md`
  names the bottleneck, and the model must be able to show that bottleneck moving.

## Considered options

### Option A: keep the current model (any agent picks any `agent-ready` issue and uses its judgement)

- **Pros:** No new process. Worked acceptably while the executing agents were strong
  models.
- **Cons:** Assumes judgement the cheap executor does not have. The review on 2026-10-04 is
  the evidence: the agent's work was fast, well-tested by its own account, and wrong in
  five architecturally significant ways.

### Option B: strong model does everything, cheap agent unused

- **Pros:** Highest quality per change.
- **Cons:** Throws away unlimited capacity; the backlog (about 55 open issues, several
  multi-week migrations) does not move at the pace the owner wants.

### Option C: three roles, work packets, mechanical boundaries (chosen)

- **Pros:** Uses each party for what it is good at. The executor's blast radius is bounded
  by a file allowlist, a size cap and guards; the architect's time is spent where judgement
  changes the outcome; the owner's time is spent only on forks and console steps.
- **Cons:** Packet writing is real work for the architect, and a packet that is wrong is
  executed faithfully. Guards must be maintained. The owner must accept that the executor
  will stop and ask rather than guess, which feels slower per task and is faster per week.

## Decision

We chose **Option C**.

### 1. Three roles

**Owner.** Keeps the cut line in `vision.md` honest. Answers grills, always posed as
multiple choice, batched. Reads and merges ADRs once each. Performs console-only steps
(`status:needs-human`). Clicks the weekly release to `main`. Target: thirty minutes a day,
asynchronous. The owner is never asked to decide something the architect or a guard could
have decided.

**Architect** (a strong model, used sparingly). Turns the cut line into work packets. Writes
ADRs when a packet exposes a fork. Reviews only PRs that touch design-bearing paths; the
label `review:architect` is applied by path (`packages/core/**`, `supabase/migrations/**`,
`scripts/guards.js`, `scripts/check-*.js`, `.github/workflows/**`, `docs/ADRs/**`, any
`Dockerfile`). Runs a weekly audit: docs against code, `system_decisions` ledger, drift
findings filed as packets, cut line refreshed, one grill batch handed to the owner.

**Executor** (the cheap agent, unlimited). Takes `status:agent-ready` packets in priority
order, one issue per PR, opens the PR early, addresses QA rounds until `qa:approved`, and
stops. It never decides: if a packet is ambiguous it relabels the issue `status:needs-grill`
with one question and takes the next packet. It never stacks PRs, never touches a file
outside the packet's allowlist, never widens scope, never rewrites documentation it was not
asked to touch.

### 2. The work packet

`status:agent-ready` now means a **work packet** exists on the issue, in the shape the issue
template `work-packet.md` enforces:

- **Goal**, one sentence, and the ADR it serves.
- **Files it may touch** and **files it must not touch**. The diff must stay inside the
  allowlist.
- **Acceptance test**, named before work starts: a vitest, a guard or a command that is red
  on `dev` and must be green in the PR. The PR must include it.
- **Done when**: observable conditions, never "works".
- **Out of scope**: explicit, because an executor pads.
- **Stop if**: the conditions under which to ask rather than guess.
- **Size**: about 300 changed lines. Larger is the architect's job to split.

An `agent-ready` issue without a packet is mislabelled; the executor relabels it
`status:needs-triage` and moves on.

### 3. The mental model as code

Guards added or required by this decision, each one a lesson from #1321:

- Core exports boundary and import direction (ADR-101).
- No new files under `packages/mcp-server/src/schedule/`; new cadences live in
  `core/engine`.
- No LLM client import outside `core/adapters`.
- No empty `catch {}` and no in-memory fallback on a production path.
- PR diff stays inside the linked packet's allowlist.
- The `review:architect` label applied by path, and auto-merge withheld while it is
  present and unreviewed.

The architecture document's lane rule (as-built only, targets labelled) stays a human
check in the weekly audit, with the drift guard as the tripwire.

### 4. The verification ladder

1. **CI** on every PR: guards, typecheck, lint, unit. No exceptions, no local-only gates.
2. **QA loop**: the rubric plus the packet's acceptance test; auto-merge on `qa:approved`.
3. **Architect review** on `review:architect` PRs only.
4. **Release gate**: `dev` to `main` weekly; `ahos_doctor` and a capture round trip against
   production before the release issue closes. A red doctor is the executor's next packet.
5. **Weekly audit** by the architect.

### 5. Human in the loop, exhaustively

The owner is asked for exactly these things and nothing else: a grill answer; an ADR merge;
a console or credential step; the weekly release click; an irreversible production data
step. Every ask is multiple choice with a recommendation, or a numbered idiot-proof
procedure.

### 6. Direction and measurement

Work is pointed where `vision.md`'s cut line says the bottleneck is. At the time of writing
that is derivation quality (thin, duplicated entities), so the ADR-101 migration is held to
the minimum that unblocks it (steps 2 to 4 of #1321) before packets go to the graph. The
architect maintains three derived metrics for the bottleneck (ADR-052: derived at read,
never stored) and reports them weekly. Progress is those numbers moving, not PR count.

## Consequences

- **Good:** the executor's mistakes are bounded by allowlist, size and guards, and are
  caught by an acceptance test it did not write. The owner's time drops to decisions. The
  architect's time goes to design and the weekly audit instead of firefighting.
- **Good:** every packet is a record. A new session with a clone and the issue list can
  resume everything (AFK protocol §0).
- **Cost / watch:** a wrong packet is executed faithfully. The architect's review of its
  own packets, and the acceptance test, are the only defences. Packets are kept small for
  that reason.
- **Cost / watch:** guards accumulate. Each one must say in its header which failure it
  prevents (the existing convention), and the weekly audit removes any that no longer earn
  their place.
- **Cost / watch:** merge discipline is by instruction, not by GitHub. Rulesets and branch
  protection need GitHub Pro or a public repository, and the owner chose (2026-10-04) to stay
  on the free plan with a private repository. So nothing stops a token with write access
  merging its own PR; the executor's standing instruction is "never merge", the QA auto-merge
  is the only sanctioned path to `dev`, and the weekly audit checks every merge of the week
  for a `qa:approved` label and a QA round. The first drift (2026-10-04: four PRs merged
  within a minute of opening) is the evidence this matters. Revisit if it recurs.
- **Cost / watch:** the executor stopping to ask will feel slow. It is the intended
  behaviour; a guess that lands on `dev` costs more than a question.
- **Follow-up:** `docs/guides/OPERATING_MODEL.md` is the how-to; `.github/ISSUE_TEMPLATE/
  work-packet.md` is the packet; the guards in §3 are packets of their own under #1321.

## Links

- Tracking issue: [#1321](https://github.com/anguspersonal/ahOS/issues/1321)
- How-to: [`docs/guides/OPERATING_MODEL.md`](../guides/OPERATING_MODEL.md)
- Label vocabulary: [`docs/agents/triage-labels.md`](../agents/triage-labels.md)
- Amends: [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md)
- Related: [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md),
  [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md),
  [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md),
  [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)
