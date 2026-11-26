# ADR-071: Guards run locally by default, CI is the backstop

- **Status:** Accepted
- **Created:** 2026-08-27
- **Accepted-on-dev:** 2026-08-27
- **Deciders:** Angus (solo maintainer)
- **Tags:** ci, guards, process, tooling
- **Builds on:** [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (a surface that cannot report its own absence is not a health surface),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (the freshness mechanisms this runs),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (the watermark),
  [ADR-065](./ADR065_ADR_Acceptance_Is_Stamped_Automatically_On_Merge_To_Dev.md) (stamping is CI's job — amended here, not reversed)

## Context and problem

Every guard in this repo runs in exactly one place: `pr-guards.yml`, plus two
scheduled workflows. GitHub Actions minutes are metered and this repo's allowance runs
out. **When it does, the guards do not degrade. They stop, silently, and the repo looks
green.**

This is not a hypothetical. Measured on `dev` at `fb00500`:

```
COLLISION: sequence 097 is claimed by 2 files:
    supabase/migrations/20260825120000_097_rename_dos_hl_config_to_dos_config.sql
    supabase/migrations/20260825180000_097_entities_people_hybrid_search_rpcs.sql
```

`check-migration-versions.js` had been failing since **2026-08-25** and nothing said so
(#918). #585 asked for that guard after the *third* occurrence of the bug; it was built,
it is correct, and it never ran. In the same tree, ADR-069 and ADR-070 sat reading
`Proposed` because ADR-065's stamper is also an Action.

The gap between "a guard exists" and "a guard runs" is where all of this lives, and the
current answer to it is developer discipline. Discipline is what the guards were built to
replace.

**The costs are not what the shape of the problem suggests.** Every script-backed guard
in the repo, run together:

| | | | |
|---|---|---|---|
| adr-index-status | 49ms | undeclared-deps | 102ms |
| apex-watermark | 50ms | standalone-lockfiles | 141ms |
| adr-citations | 135ms | migration-versions | 62ms |
| skill-bodies | 117ms | migration-signatures | 131ms |
| type-duplicates | 187ms | artifact-surface-writes | 172ms |
| user-id-reads | 691ms | `test:workflows` (123 tests) | 1016ms |

**1.8 seconds for the guards, 2.8 with the tests.** The reason they live only in CI is
not cost. It is that nobody wired them anywhere else.

## Decision

### 1. The guards get a second execution path, and `npm install` wires it

`scripts/guards.js` runs the guards from a manifest. `.githooks/pre-commit` and
`.githooks/pre-push` call it. `package.json`'s `prepare` script points
`core.hooksPath` at `.githooks`, so it is configured by the `npm install` everyone
already runs, with no per-clone step to forget and no new dependency.

Local execution is now **the path that actually runs**, because it runs on a laptop
rather than on a metered allowance. That is the amendment to ADR-065: stamping and
guarding are still CI's job in the sense that CI is authoritative and unskippable, but
CI is the **backstop**, not the primary. ADR-065's decision is unchanged; its premise
that CI is always available was wrong.

### 2. A hook blocks only on guards whose inputs your change touched

**This is the whole design, and everything else follows from it.** A hook that blocks
your commit over somebody else's merged mistake gets `--no-verify` the second time it
fires, and from then on it protects nothing.

The 097 collision proves the case: wire the guards naively and the first thing this
change does is block every commit in the repo on a migration conflict the committer did
not create and cannot safely fix in passing.

So the manifest maps each guard to the paths it reads, and `--staged` runs only the
guards your staged files touch. This is not a new principle. It is the rule the ADR link
guard already states in `pr-guards.yml`: *"pre-existing breakage elsewhere is not this
PR's problem, and failing on it would block unrelated work."*

### 3. `--push` sweeps everything and blocks on none of it

Scoping to touched files, on its own, would hide #918 exactly as CI's absence did. So
`pre-push` runs the full set and prints what is failing elsewhere under `NOT YOURS`,
without affecting the exit code.

This is ADR-052 §4 applied to the guard runner itself: a surface that cannot report its
own absence is not a health surface. Visible-and-not-in-your-way beats blocking, because
blocking becomes disabled and disabled reports nothing.

### 4. The watermark check stops dropping unstamped ADRs

`check-apex-watermark.js` filtered non-live ADRs out **before** measuring the gap, so an
ADR merged reading `Proposed` was in neither the gap nor the blind-spot list. The
watermark under-reported and said nothing while doing it. That is the ADR-065 defect, and
it is a defect **in the instrument**, which is worse: a stale number you can see is one
you act on.

The fix is the pattern the same file already applies to undated ADRs — *"the check
declares its own blind spot rather than hiding it"*. Unstamped ADRs are now counted and
named. They are **not** folded into `adrsBehind`, because an ADR with no
`Accepted-on-dev` genuinely cannot be placed in the order, and trading a silent wrong
number for a loud one is not an improvement.

`--strict-stamps` decides whether their presence is *alarming* rather than merely
reported. It is off by default and set by the runner only when the working tree is
`dev`, because `readAdrs` reads the tree: on the branch that **adds** an ADR, `Proposed`
is the correct status. This is the same reason `adr-stamp.yml` is a push-on-dev trigger
and not a `pull_request` gate.

Widening the parser for this surfaced a second, older blind spot. ADR-006, ADR-008 and
ADR-009 predate the metadata-line convention and write their status as a `## Status`
section. They parsed as having **no status at all**, so they were live-filtered out of
every measurement this file has ever made. They are read correctly now, which moves the
undated blind spot from 25 ADRs to **28** — a number that got worse because it got
honest.

### 5. What this deliberately does not cover

- **The unit tests, typecheck and lint.** They are `turbo` tasks over a monorepo and
  belong to a deliberate `npm test`, not to every commit. Nothing here changes the fact
  that when Actions are off, running them is discipline.
- **The four guards written as inline bash in `pr-guards.yml`** (ADR link, ADR number,
  docs index, commit authorship). They have no script to call. Re-implementing them in
  the runner would create two behaviours under one name, which is worse than the gap, so
  #919 tracks extracting them into scripts both paths call. Stated here and in the
  runner's header rather than left to be discovered.
- **The citation guard's scoping.** `pr-guards.yml` wraps `check-adr-citations.js` in
  bash that limits it to the files a PR touched; the hook runs it over everything. Same
  script, slightly stricter locally. Also #919.

### 6. Hooks are bypassable, and that is not a defect

`--no-verify` skips all of this, and `GUARDS_SKIP=1` skips just the guards. Both are
kept deliberately. A local guard is a tripwire for the mistake you did not know you were
making, not an access-control mechanism, and the failure mode of an unskippable local
hook is a developer who stops committing. CI remains the copy nobody can skip, for
whenever it can run.

## Consequences

**The guards run on the majority of days for the first time.** Actions are off more often
than they are on for this repo, so a mechanism that only runs in CI has, in practice,
been running rarely.

**Two live defects were found by wiring this up**, before it had guarded a single commit:
#918's migration collision, five days old and silent, and the three ADRs whose status
line no measurement in this repo has ever been able to read.

**The under-report is closed at the instrument, not at the trigger.** ADR-069 and ADR-070
still read `Proposed` on `dev` and will until #867 clears, but they are now *named* on
every run rather than quietly shrinking the gap. The stamp is still blocked; the lie
about it is not.

**`npm install` now writes to the local git config.** That is a real side effect of
installing dependencies, and it is how husky and lefthook work too. It is guarded so it
cannot fail an install and is a no-op outside a git worktree.

**One manifest is now a thing that can go stale.** A new guard script that nobody adds to
`GUARDS` runs in CI and not locally, silently — the same class of failure this ADR is
about, one level up. There is no check for that yet, which is worth stating plainly
rather than discovering later.

## Errata

**Erratum 1 — one guard was carried over without its teeth.**

The manifest ported each guard's *command* from `pr-guards.yml` and not its
*environment*. `check-adr-citations.js` reads `ADR_CITATION_GUARD_MODE` and exits 0
however many stale citations it finds unless the value is `fail`. `pr-guards.yml:188`
sets it. `scripts/guards.js` did not, so locally the guard printed its findings under
`Reporting only:` and passed.

That is this ADR's own thesis failing in its own implementation: the teeth existed only
in the resource §1 was written because we cannot rely on. **Between #922 and this fix the
citation guard could not block anything, anywhere.** It cost nothing only because no
citation went stale in the window, which is luck rather than design.

Fixed by giving the manifest an `env` field and merging it into the spawn. Verified by
injecting a stale `ADR-062` citation into `vision.md`: the runner reports
`BLOCKING · adr-citations` and exits 1, where before it exited 0.

**The general shape is worth keeping.** §1 argued about *where guards execute* and said
nothing about *what they are given when they get there*. A guard's behaviour is its
command plus its environment, and porting half of that is porting none of it. Any future
guard whose behaviour is env-dependent needs the same check.

**Erratum 2 — §6's leniency was applied to CI, where §1 says it does not belong.**

§6 keeps local hooks bypassable, and argues it well: "the failure mode of an unskippable
local hook is a developer who stops committing." `scripts/lib/range.js` implemented that
as a rule about *runners* rather than about *laptops* — "a runner that cannot resolve a
range must under-block, never over-block" — and CI is a runner. So when CI could not
compute a range, its guards reported success.

That is the worse half of this ADR's own trade. §6's next sentence is **"CI remains the
copy nobody can skip"**, and it was skipping: a guard with no range prints its OK line and
exits 0, so the run went green having checked nothing. A guard that cannot run is
recoverable; a guard that says "verified" about a range it never read is not, because
nobody goes back to look. #964 exists because migration 097 shrank a column comment nobody
noticed, and #536 is a tracker-decay problem caused by an automation that quietly did not
fire — both are this failure, one level down.

Three paths reached it, all live in CI until #1047:

- `pr-guards.yml` wrote `BASE_SHA=$(git merge-base …)` under `set -euo pipefail`. `echo`
  exits 0 with an empty substitution, so a failed merge-base passed the step and wrote an
  empty base.
- `--base ''` then fell through to the guess path, because `argv[i + 1]` is falsy. On a PR
  targeting `main` — a release PR — the guess is `origin/dev`: the wrong range, silently
  substituted for the one the workflow explicitly computed.
- `git rev-parse --verify` accepts any well-formed 40-hex string without checking the
  object exists. A bogus sha "verified", the diff then failed, and `allowFail` turned that
  fatal into `[]` — into "no files changed".

Fixed by splitting the one question into the two it always was. **"Nobody gave me a base
and I cannot work one out"** stays policy: lenient by default, fatal under
`GUARDS_STRICT=1`, which only `pr-guards.yml` sets — so §6 is untouched on a laptop.
**"Somebody gave me a base and it is unusable"** is not policy and never was: it is fatal
everywhere, and costs hooks nothing because `guards.js` never passes `--base`.

**The general shape is worth keeping.** Erratum 1 was a guard whose teeth lived only in
CI; this is a guard whose leniency was written for a laptop and inherited by CI. Both come
from stating a rule about "the runner" when the rule was really about *which* runner.
§1's whole point is that local and CI are different execution contexts, so any rule this
ADR states needs to name which of the two it governs.

## Refs

#414 · #536 · #585 · #862 · #867 · #918 · #919 · #964 · #1047 · ADR-039 · ADR-052 §4 ·
ADR-056 · ADR-059 · ADR-065
