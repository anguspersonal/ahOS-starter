# ADR-DRAFT: ahkms is the source of truth for single-file skills; local `.claude/skills` is a cache

<!-- Feature-branch draft. Integer minted at merge to dev (next free number). -->

- **Status:** Proposed
- **Created:** 2026-07-15
- **Accepted-on-dev:** (pending merge)
- **Deciders:** Angus, Claude (grill-me session)

## Context and problem

Skills the user owns are registered in the ahkms capability registry ([ADR031](./ADR031_Capability_Registry.md), [ADR030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md)) so they resolve on any surface (claude-code / cowork / chat), not only where a local file happens to live. As of 2026-07-15 the capability layer is live: 68 capabilities registered, ~28 own skills with their body in `kms-db`, ~40 mattpocock-derived skills sitting as `storage_location='claude'` (indexed pointers, body not owned by ahkms).

The observed pain is **drift**, not reachability. Cross-surface reachability already works: when a skill is not available locally, the global CLAUDE.md fallback fetches its body from ahkms via `get_capabilities`. The bug is that **claude-code prefers a local skill file and never consults ahkms when one exists** — the fallback is explicitly "when it is *not* available locally." So a local file **shadows** a fresher ahkms body: edit `/qa-review` on one surface, push to ahkms, and claude-code keeps serving its stale local copy. There is **no server-side enforcement** — `properties.surface[]` is declarative metadata only (ADR028), and ahkms cannot push to claude-code. The local file is the *only* artifact claude-code reads.

Therefore "ahkms is the source of truth" is a fiction in claude-code **unless something rewrites the local file from ahkms**. This ADR decides the direction of authority and the mechanism that makes it real.

## Decision drivers

- **Kill cross-surface drift** without requiring the user to remember to sync.
- **Never silently lose a local edit** (naïve pull-only sync would clobber unpushed local work).
- **Don't fight Claude's native model more than necessary** — local files stay the authoring surface; ergonomics preserved.
- **No new ahkms DB fields / migrations** — work within `register_capability` (name/kind/surface/storage_location/storage_url/body/description) and body-text conventions. The four known registry gaps (no provenance field, no drift detection, no bulk sync, no version pin) stay untouched at the schema level.
- **The skill set churns 3–4×/month** (user preferences + external-creator drops) — the tiering rule must be mechanical, not a curated list to maintain.
- **Preserve the serveable-body invariant:** the ahkms `body` is *also* what the cross-surface fallback serves verbatim as the skill definition. It must remain a usable skill, not an opaque archive.

## Considered options

### Option A — ahkms-authoritative for everything (local is a pure projection)

- **Pros:** clean single source of truth; strongest cross-surface story.
- **Cons:** the 11 multi-file skills (`solid` = 10 files, `tdd` = 6, …) reach supporting files by filesystem path / shell — packing a folder into one `body` breaks the serveable-body invariant and buys nothing, since those skills cannot function off claude-code anyway (no filesystem, no shell on cowork/chat).

### Option B — local-authoritative, ahkms indexes (status quo)

- **Pros:** Claude-native; no fight.
- **Cons:** doesn't fix the drift bug at all — the reverse-direction case (edit on a surface with no local file, then invoke on a surface that *has* the stale file) still shadows.

### Option C — hybrid, tier computed by file count

- **Single-file skills → ahkms-authoritative;** multi-file skills → local-authoritative.
- **Pros:** fixes drift for exactly the skills that have cross-surface value; sidesteps the multi-file blocker instead of solving it; tier is *computed*, not curated, so it survives churn.
- **Cons:** two sync systems coexist (ahkms + dotclaude) and must be kept from overlapping.

## Decision

We chose **Option C — hybrid, tier computed by file count**, with these mechanisms:

1. **Tier by live file count, re-evaluated every sync.**
   - **Single-file skills → ahkms-authoritative.** `body` = the full `SKILL.md` verbatim (serveable cross-surface as-is). In the reconcile loop.
   - **Multi-file skills → local-authoritative.** Excluded from the reconcile loop; ahkms keeps at most an indexed `SKILL.md` snapshot. No folder packing.
   - A 1→N file transition is logged and demotes the skill to local-only (never pushes orphan files).
   - **Escape hatch:** flatten a multi-file skill (inline references into `SKILL.md`) to auto-promote it into the single-file tier.

2. **Local↔ahkms reconcile via a 3-way merge base.** Per skill, store the last-synced content hash as a merge base in a **per-machine, gitignored `~/.claude/skills/.sync-state.json`**:

   | local vs base | ahkms vs base | action |
   |---|---|---|
   | same | same | nothing |
   | **changed** | same | push local → ahkms (auto) |
   | same | **changed** | pull ahkms → local (auto; backup first) |
   | **changed** | **changed** | conflict → defer to `/skill-sync resolve` |

   The base is per-machine (each machine's own reconciliation point) and never shared through dotclaude. Hashing is on canonicalized `SKILL.md` (normalized line endings / trailing whitespace; the `x-upstream` block is intentional body content and is hashed).

3. **External-creator provenance in `x-upstream:` frontmatter** — no DB field, no migration. Records `repo`, `path`, `base_commit`, `base_blob`, `reviewed`. General across N upstreams; each upstream is a read-only local clone under **`~/.claude/skills/.upstream/<owner>-<repo>/`** (gitignored), `git fetch`ed at reconcile time. Because the ~40 existing forks have no recoverable fork-point, the **first** upstream reconcile per skill is a full fuzzy diff that *declares* a synthetic base; every reconcile after is a clean 3-way (`base_blob` vs upstream-HEAD vs your-current). Mappings (handling name drift like `to-issues`↔`to-tickets`) are **auto-suggested by body-similarity, confirmed by the user**.

4. **`sync-dotclaude` survives with narrowed scope.** ahkms owns single-file skills; dotclaude git owns multi-file skills, agents, and `settings.json`/hooks (which the capability layer does not cover). Both tools consult **one shared tier check**, so their scopes never overlap. **Symlinked skills** (into `~/.agents/skills`) are **compare-only, never pull-overwritten** — warn rather than stomp another system's tree.

5. **Execution shape: 1 hook + 1 skill + 1 shared core.**
   - A **`SessionStart` hook** auto-reconciles every boot: auto-applies the push and pull rows (auto-push accepted), backs up before any local overwrite, **defers row-4 conflicts** (logs + surfaces a count), and **fails open** if ahkms is unreachable.
   - A **`/skill-sync` umbrella skill** with subcommands `status` · `resolve` · `upstream` · `push`/`pull`.
   - A **shared core module** (tier detection, canonical hashing, 3-way merge, ahkms client) called by both, so the logic is written once.

## Consequences

- **Good:** the `/qa-review`-shadowing drift bug is fixed automatically at boot; unpushed local edits are pushed, not lost; the multi-file blocker is sidestepped with no packing; tiering survives 3–4×/month churn because it is computed; no ahkms migration required.
- **Cost / bad:** a boot-time hook mutates files under `~/.claude/skills` (mitigated: backups, auto-apply only unambiguous rows, fail-open); two sync systems must stay coordinated via the shared tier check; the first upstream reconcile per existing fork is irreducibly fuzzy (declared base, not discovered).
- **Follow-up:** first-run bootstrap needs a one-time `/skill-sync init` to set initial bases where local==ahkms and route genuine mismatches to `resolve`. Agents/commands could adopt the same file-count rule later but are out of scope for v1. D7 ("curated best set") is moot — the tier is computed.

## Links

- Related: [ADR031](./ADR031_Capability_Registry.md), [ADR030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md), [ADR028](./ADR028_Surface_Registry_And_Reference_Artifacts.md), [ADR026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md), [ADR019](./ADR019_Capability_Hosting_And_Binding_Layer.md)
- Grill handoff: [`docs/sessions/2026-07-15-skill-registry-source-of-truth-handoff.md`](../sessions/2026-07-15-skill-registry-source-of-truth-handoff.md)

## Errata

### Erratum 1 — item 4's "`sync-dotclaude` survives with narrowed scope" is false (2026-08-26, #756)

`dotclaude` itself was deprecated by #566 (2026-08-21) — the whole git repo goes
away, not just the sync tool's scope. There is no dotclaude git repo left for
`sync-dotclaude` to sync multi-file skills/agents/`settings.json` against.
Option C's tier-by-file-count split did ship, in a different form, via #689/#697
(the `skill-registry.json` `supporting_files[].travels` mechanism) — that part
of the design stands. Only the "two coordinated tools" premise in item 4 is
superseded: single-file skills reach `kms-db` via `skill-sync push`
(landed, #757); there is currently no cross-surface home for multi-file skills.
