# ADR-090: A PR into `dev` merges itself on QA approval and green checks; `dev → main` stays human

- **Status:** Accepted
- **Created:** 2026-09-25
- **Accepted-on-dev:** 2026-09-25
- **Deciders:** Angus (solo maintainer)
- **Tags:** process, ci-cd, qa-loop
- **Builds on:** [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md) (the cheap gate on `dev`, the full gate on `main`),
  [ADR-087](./ADR087_The_Orchestrator_Runs_On_Agent_Platform_Not_A_Custom_Daemon.md) (GitHub as the only durable state; qa-review / address-review as the loop)

## Context and problem

The developer↔QA loop already exists and already writes its phase to a label. The
`qa-review` skill posts a round-stamped review and sets `qa:approved` (converged) or
`qa:changes-requested`; `address-review` dispositions every finding and sets `qa:ready`;
[`lifecycle-sync.yml`](../../.github/workflows/lifecycle-sync.yml) records each transition
([#337](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/337),
[#670](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/670)). What the
loop does **not** do is finish: a PR that reaches `qa:approved` with every check green
waits for a person to press merge. On 2026-09-25 five such PRs sat approved and green
while the maintainer did other work, and the release PR that would have carried them
waited on nothing the process could name.

Two things stop GitHub's own auto-merge from closing that gap. The repository is private on
a plan without branch protection, so required status checks (and therefore native
auto-merge) cannot be enabled (ADR-015; CONTRIBUTING §6). And a PR's first `qa:*` label is
set only when a review happens, so a freshly opened PR is invisible to the loop until
someone remembers to review it.

There is also a hard constraint on *who* performs the merge. A merge made by the default
`GITHUB_TOKEN` does not fire other workflows, so
[`issue-lifecycle.yml`](../../.github/workflows/issue-lifecycle.yml) (the `on-dev` labelling),
[`release-pr.yml`](../../.github/workflows/release-pr.yml) (the standing `dev → main` PR) and
[`adr-stamp.yml`](../../.github/workflows/adr-stamp.yml) would all silently stop running for
auto-merged PRs. Agents also open PRs as drafts, GitHub refuses to merge a draft, and the
ready-for-review mutation is forbidden to `GITHUB_TOKEN` (#670). The App token minted for
[#979](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/979) has neither
limitation.

## Decision drivers

- **The loop must terminate in a merge, not in a person.** QA already has the last say
  (the qa-review convergence contract); a human re-confirming it adds latency, not safety.
- **`main` is production.** ADR-015 put the expensive gate there and CONTRIBUTING §1 makes
  the release a deliberate act. That act stays human.
- **A PR enters the loop when it is opened**, so nothing can sit unreviewed with no label
  saying so (ADR-080's rule for issues: a status names what happens next).
- **No stored credential beyond the one that exists.** #670 declined a PAT for a
  cosmetic draft/ready flip; the App token from #979 is already trusted for opening the
  release PR and is reused, not added to.
- **The rule has to survive a changing check set.** `ci-dev.yml` is path-skipped on
  docs-only PRs and the guards in `pr-guards.yml` are added to over time, so a fixed list
  of required check names would rot.

## Considered options

### Option A — Keep merging by hand

- **Pros:** no automation to trust; a person sees every merge.
- **Cons:** the person adds nothing the loop did not already establish, and the batch to
  `main` is delayed by their attention rather than by the work. This is the status quo the
  five stalled PRs measured.

### Option B — Auto-merge on `qa:approved` + green checks, App token, `dev` only

- **Pros:** the loop ends where its contract says it ends; the App token keeps every
  downstream workflow firing; the rule is a pure function with unit tests; `main` is
  untouched.
- **Cons:** a wrong `qa:approved` (a skill mislabelling, or a human adding it by mistake)
  ships to `dev` without a second look. Mitigated by `dev` not being production, by
  `qa:changes-requested` and `needs-human` overriding approval, and by the merge itself
  being a squash the release PR still shows.

### Option C — Auto-merge `dev → main` as well

- **Pros:** fully unattended pipeline.
- **Cons:** `main` deploys; a bad batch is a production incident, and the release PR is
  the one place the maintainer reads the batch as a whole. Rejected: the human-in-the-loop
  is the point of that step, not an omission.

## Decision

We chose **Option B**. Three rules, each in one place:

1. **A PR into `dev` gets `qa:ready` when it is opened**
   ([`qa-ready-on-open.yml`](../../.github/workflows/qa-ready-on-open.yml)), unless it already
   carries a `qa:*` label. `qa:ready` now means **"a QA round is owed"**, whether that is
   round 1 on a new PR or the confirmation round after `address-review`. The old, narrower
   description ("addressed, awaiting confirmation") was a special case of this; nothing
   that read the label changes. The other two labels keep their meanings: `qa:approved` is
   the terminal verdict from a converged confirmation round; `qa:changes-requested` means
   findings are open and wins whenever both are present.
2. **A PR into `dev` merges itself** when it carries `qa:approved`, carries neither
   `qa:changes-requested` nor `needs-human`, has no conflict, and every check run on its
   head commit has completed with none failed and at least one succeeded. Checks still
   running mean *wait*; the workflow is re-triggered when they finish. A draft is marked
   ready first, then squash-merged with the PR title as the commit title (CONTRIBUTING §3).
   The rule is [`auto-merge-dev.js`](../../.github/scripts/auto-merge-dev.js), unit-tested in
   `pr-guards.yml` step 9; [`auto-merge-dev.yml`](../../.github/workflows/auto-merge-dev.yml)
   holds the two triggers (label added; CI workflow completed) and the App token. Without
   an App token the job fails loudly with one PR comment rather than merge with a token
   that would break the pipeline.
3. **`dev → main` is never automated.** `guard-main.yml` and a person merging the release
   PR remain the whole release process.

## Consequences

- **Good:** the QA loop is a pipeline again. A converged review is the last human-shaped
  event before code is on `dev`; the maintainer's attention is spent on the release PR.
- **Good:** every PR into `dev` carries a `qa:*` label from birth, so "which PRs are
  waiting for a review" is a label filter, not a memory.
- **Cost / bad:** the App token is now on the merge path. If `CI_APP_ID` /
  `CI_APP_PRIVATE_KEY` lapse, approved PRs stop merging and say so on the PR; they do not
  fall back to a `GITHUB_TOKEN` merge. That is deliberate.
- **Cost / bad:** two approved PRs that conflict with each other merge in label order; the
  second is skipped with "merge conflict with dev" until its author merges `dev` in and a
  confirmation round re-approves. Same as today, minus the human noticing.
- **Follow-up:** the registry copies of `qa-review` / `address-review` still describe
  `qa:ready` in the narrower wording and the label step in `gh` terms; a one-line pointer
  to this ADR belongs in both bodies (owner-side, kms-db). A Routine that runs `qa-review`
  on every `qa:ready` PR is the natural next automation and is the owner's to create
  ([#636](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/636)).

## Links

- Related: [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md), [ADR-087](./ADR087_The_Orchestrator_Runs_On_Agent_Platform_Not_A_Custom_Daemon.md)
- Issues: #337, #670, #979
