# ADR-072: The post-merge hook stamps ADRs, and commits them

- **Status:** Accepted
- **Created:** 2026-08-27
- **Accepted-on-dev:** 2026-08-27
- **Deciders:** Angus (solo maintainer)
- **Tags:** ci, guards, process, tooling
- **Builds on:** [ADR-065](./ADR065_ADR_Acceptance_Is_Stamped_Automatically_On_Merge_To_Dev.md) (stamping is automatic, not the author's job),
  [ADR-071](./ADR071_Guards_Run_Locally_By_Default_CI_Is_The_Backstop.md) (anything depending on Actions is a thing that does not run)

## Context and problem

ADR-071 moved the guards local because Actions are metered and stop. It left the
**stamper** on Actions, and shipped `npm run stamp:adrs` as the substitute. That is
discipline wearing a script's clothes, and ADR-071's own argument condemns it.

The evidence took two hours to arrive. #920 merged, ADR-071 landed on `dev` reading
`Proposed`, and closing that needed a second PR (#921) whose entire content was a stamp
a machine should have written.

**The alarm ADR-071 built also barely fires where it matters.** `--strict-stamps` engages
only when the tree is `dev`, and nobody commits on `dev` — you pull it and branch off it.
Nothing ran on `git pull`, so in practice the unstamped state waited to be noticed on
some later commit under `docs/ADRs/`, on a branch, where the check correctly downgrades
itself to a non-blocking note.

## Decision

### 1. `post-merge` runs the stamper on `dev`

`.githooks/post-merge` runs `stamp-accepted-adrs.js --write` when the branch is `dev`
**and** the merge brought in changes under `docs/ADRs/`. Every other pull is silent. It
is the same script `adr-stamp.yml` runs, triggered by `git pull` rather than a push
webhook, so there is one implementation and two triggers.

`git pull --rebase` does not fire `post-merge`. `npm run stamp:adrs -- --write` covers
that by hand, and the `--strict-stamps` check catches it either way.

### 2. It commits, and that is the point

A stamp left uncommitted in the working tree is a thing to remember, which is the failure
mode this closes. So the hook commits.

This is a genuine liberty for a hook to take and is worth naming rather than assuming: it
is defensible only because the value is **derivable, not a judgement** — that was #620's
argument, which ADR-065 adopted. The merge happened; its date is on the commit; there is
no decision for a human to make. A hook that wrote anything requiring judgement would not
get this latitude.

**It does not push.** Committing on your behalf is one liberty and pushing is another,
and a hook that pushes can fail or hang on a network the merge never needed. It prints
`stamped and committed. Push when ready.`

### 3. The stamp commit skips the guards

`--no-verify`, deliberately. The stamp is a metadata correction, and blocking it on an
unrelated guard the merge happened to bring in is exactly the "blocked by somebody else's
mistake" case ADR-071 §2 refuses. The guards still run on the next commit and push.

### 4. It fails loudly on no identity, and is skippable

With no `user.email` configured it stamps, does not commit, and says so with the command
to run. `ADR_STAMP_SKIP=1` skips it, for the same reason ADR-071 §6 keeps `--no-verify`:
a local hook is a tripwire, not access control.

## Consequences

**ADR-065 is now true as written for the first time.** *"Becomes `Accepted` only when
merged to `dev`"* has been a rule the repo stated and did not keep since the stamper was
built, because the stamper could not run. It runs now, on the machine that does the merge.

**The #862 defect class closes.** An ADR reaching `dev` reading `Proposed` was found six
times in seventeen days before ADR-065, and three more times after it, every one of them
because Actions were off. The remaining exposure is `git pull --rebase` and merges done
in the GitHub UI by someone who never pulls, both of which the `--strict-stamps` check
still reports.

**Two hooks now write to the repository** rather than only reading it. That is a
meaningful change in what installing dependencies signs you up for, and the honest way to
say it is: `npm install` in this repo wires hooks, and one of them makes commits.

**This ADR will be stamped by the hook it describes**, which is either a good sign or a
short circuit, and is worth checking on merge rather than assuming.

## Errata

**Erratum 1 — the hook wrote a commit the repo's own authorship guard rejects.**
§2 said the hook commits and left the identity to `git config`, which is right on a
maintainer's machine and wrong everywhere else. `pr-guards.yml`'s commit authorship guard
fails any commit whose author *or* committer email ends `@anthropic.com`, and this hook
fires in agent sessions, where that is exactly what `git config` says.

Found on the hook's first live run, which stamped this ADR correctly and then wrote
`ad91dfd chore(adr): stamp ADRs accepted on dev` authored by `Claude
<noreply@assistant.example.com>` — onto `dev`, where the guard's own remediation says *"do NOT
rewrite anything already on dev or main."* Caught before pushing.

§4's no-identity branch now also covers an identity the guard would reject: stamp, do not
commit, print the command with a human identity. Fixed in #923.

The general shape is worth keeping in view: **§2's latitude was argued from the value
being derivable, and said nothing about who signs it.** Those are separate questions, and
only the first was answered.

## Refs

#620 · #862 · #867 · #918 · ADR-039 §1 · ADR-065 · ADR-071
