# ADR-054: One `dos` config — split stores behind one façade, two domains, and an open audience set

- **Status:** Accepted — §7's survives/retires list **amended by addition** and §8's conclusion **superseded in place** 2026-08-22 (`dos-catchup` retires; catch-up folds into attended `dos`); see Amendment 2 in the Errata and amendments section below
- **Created:** 2026-08-10
- **Accepted-on-dev:** 2026-08-10
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, skills, config, dos, notion, synthesis
- **Builds on:** [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) (capability hosting and binding),
  [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md) (skill config in DB),
  [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) (immutable records),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (one ritual per name),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) (one EOD ritual)
- **Supersedes in part:** [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) §1 — the closed audience enumeration
- **Resolves:** #569 (config unification, naming, `dos-catchup`)
- **Amended by:** [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) (§7: the three canonical ahOS ritual verbs are `prep`, `sync`, and `reflect`; `dos` and `synth` resolve as permanent aliases for `sync`, and `dos-reflect` resolves as a permanent alias for `reflect`)

---

> **Same-PR as-built note (ADR-039 §2).** This ADR changes the system's intended
> shape but nothing is built yet, so `docs/architecture/architecture.md` keeps
> its as-built §7 and its existing forward-pointing note is extended to name this
> ADR. The section updates when the ritual ships (#569, #415).

## Context and problem

[ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
replaced ADR-023's three sibling rituals with one, routed by `domain` and shaped
by `audience`. It closed the projection layer and deliberately left one thing
open, named in its own Consequences: *"Config unification (one config carrying
both Notion wirings) remains to design."*

That gap is not cosmetic. Today the ritual's configuration is Work-shaped
throughout, in ways that make a second domain unrepresentable rather than merely
unconfigured:

- `user_preferences.dos_hl_config` is singular everywhere — one
  `state_doc_rules`, one `daily_log_schema`, one `priorities` list.
- Its `domains` key holds a **topic** taxonomy (`Apple · Google Play · Round ·
  Product · EHS · Pricing · Team · Advisors · Legal · Ops · Personal · Other`)
  while ADR-051 §1 uses `domain` for the **routing** axis. One of those topic
  values is `Personal`, doing by hand the job §1 assigns to routing.
- `user_integrations` has `state_doc_page_id` and `daily_log_data_source_id`
  under `notion_work` and **no equivalent under `notion_personal`**, which
  carries only tasks, people and meeting-notes pointers.
- `artefact_registers` holds five entries (`Bri · Team · Mitesh · Investor ·
  Advisor`) against ADR-051 §1's three-value `audience`.

The practical consequence, observed 2026-08-10: the personal State Doc **exists
in Notion and has never had a writer**. `dos-personal` is written to stop before
writing when its destination is unwired, and it has been unwired since it was
authored. This is not a stale document; it is a document nothing has ever been
able to reach.

## Decision drivers

- **A second domain must be representable, not merely absent.** A config key that
  exists and points nowhere is the defect class already logged on this system
  (`097bf71f`, gate-keyed-on-unset-field): the feature reads as present and does
  nothing.
- **One vocabulary per word.** `domain` cannot mean both a routing axis and a
  topic taxonomy in the same config that a ritual reads to decide routing.
- **ADR-030's storage split is load-bearing**, not incidental — Notion ids in
  `user_integrations` are read by `set_integration_config`, `get_notion_config`,
  `create_task` and capture routing, none of which are part of this ritual.
- **The safety half of an audience spec must survive.** Under ADR-051 §4 an
  audience spec carries standing exclusions; a spec that covers three different
  recipients cannot carry three different exclusion sets.
- **Names should not be reused across eras** (ADR-050 §1, capability lineage).

## Considered options

### Option A — one config blob carrying everything

Collapse pointers and behaviour into a single `user_preferences` blob, as #569 §5
asks literally. One fetch, one place to look.

Rejected: it duplicates Notion ids that four other consumers read from
`user_integrations`, producing two records of the same pointer free to disagree —
the failure ADR-051 §16 rejects for the Notion synthesis markers, in a second
location.

### Option B — leave the split and leave the call site alone

Status quo: two fetches, two mental models, the ritual knowing which table holds
caps and which holds page ids.

Rejected: it concedes #569 §5's actual complaint, which is about the caller, not
the storage.

### Option C — split storage, one façade (chosen)

Storage follows ADR-030 unchanged; a single tool returns the union. §5's
ergonomics without §5's duplication.

## Decision

### 1. Storage stays split; `get_dos_config` is the single read

`user_preferences.dos_config` holds behaviour (topics, tone, types, caps, schema,
pillars, audience specs). `user_integrations` remains the only home for Notion
ids. **One MCP tool, `get_dos_config`, returns both**, so the ritual never learns
that its configuration lives in two tables.

The façade may drift from what it wraps. That is the accepted cost, and it is
smaller than the alternative: a drifted façade returns a stale *view* of one
truth, whereas Option A creates two truths.

### 2. `domain` is the top layer; the topic taxonomy is renamed and nested

The existing `domains` list becomes **`topics`**, nested per domain. The value
`Personal` is removed — routing now carries what it was standing in for. The
`angus` domain owns its own topic list, to be authored rather than inherited.

`domain` is thereafter unambiguous: ADR-051 §1's routing axis, `work | angus`.

### 3. The provider is renamed `notion_personal` → `notion_angus`

> **Superseded in place 2026-09-26 (owner decision on #681) - see Amendment 4 below.**
> The rename is dropped. `notion_personal` is retained, and the domain `angus` maps
> to it permanently via `DOMAIN_PROVIDER`. Avoiding a risky cross-store data migration
> across `user_integrations` and `artifact_external_links` marker rows is preferred over
> cosmetic naming uniformity.

ADR-051 §1 chose `angus` over `personal` deliberately — repo and KMS work is
`angus` domain, not personal life, and that is the argument for dissolving
`dos-infra`. Rather than carry a permanent domain/provider mismatch, the provider
follows the axis. Precedent exists:
`20260621120000_053_rename_notion_to_notion_work.sql` performed this exact
rename once.

**`credential_ref` and `NOTION_PERSONAL_ACCESS_TOKEN` are unchanged.** They name a
token for a Notion workspace, not a domain; renaming them would convert a code
change into a secrets operation for no gain.

### 4. `audience` is an open set of named specs — ADR-051 §1 superseded in part

ADR-051 §1 enumerates `team | briana | external`. `Bri` → `briana` and `Team` →
`team` map cleanly; `Mitesh`, `Investor` and `Advisor` do not, because they differ
on the axis ADR-051 §4 makes the safety half of a spec:

| Spec | Register | Standing exclusions |
|---|---|---|
| `mitesh` | contractor-scoped, technical, direct | the round, pricing, team/pay matters |
| `investor` | outcome-framed, polished, formal | contractor issues, internal engineering |
| `advisor` | candid, signal-rich, explicit asks | deliberately the least filtered |

A single `external` spec cannot hold three exclusion sets, and it would fail
hardest for the recipients where a leak is least forgiving.

**Therefore `audience` is an open set.** Each spec carries ADR-051 §4's three
parts — register, standing exclusions, examples — **plus a `cadence` field**
(`nightly` | `on_demand`). ADR-051 §7's "team nightly, Briana and external on
demand" is thereby preserved as data rather than as an enumeration.

Nothing else in ADR-051 changes: §4's transforms-not-filters reasoning, §8's
manual-send gate, and the rejection of per-item visibility tags all stand. This
clause widens *how many* audiences may exist, not *what an audience is for*.

The cost is real: no compile-time check that a report names a live audience, and
five specs to keep current instead of three.

### 5. Per-domain and global keys are fixed

| Per-domain | Global |
|---|---|
| `topics`, `daily_log_schema`, `state_doc_rules`, `pillars`, `domain_signals`, `artefact_registers` | `types`, `tone`, `audiences` |

*(This table classifies all nine keys. Per Amendment 1 and ratification under Amendment 3 (#685), `artefact_registers` stays per-domain until global `audiences` exists to absorb it.)*

`domain_signals` is ADR-051 §1's classifier, repurposed from
`workspace.{work_entities, personal_signals}` — from "which ritual refuses
you" to "which domain does this item route to".

~~**`angus` pillars start empty and stay empty** until a personal daily log has run
often enough to show whether it wants them.~~ **— see Erratum 2 below: for the five
pillars the owner had already authored in Notion the premise is void, and `angus`
ships with them.** An empty list is a legitimate answer; a guessed list is projected
into Notion checkbox properties and is then awkward to remove.

This exposed that *priority* names two different things system-wide — task
urgency (P0–P4, Tasks DB, #471) and strategic objective (#411's Pillar 1–4) —
while `dos_hl_config.priorities` still ships the losing name and generates the
Notion properties #470 is about to rename. Settling that vocabulary is **#618**,
a precondition for authoring per-domain pillars rather than part of this ADR.

### 6. Two domains from day one

The `angus` destinations are wired before the ritual ships, not after. The
personal State Doc already exists; wiring it is a pointer plus a manual Notion
step, not new authoring.

Shipping the domain axis with `angus` present-but-unwired would reproduce
`097bf71f` exactly: a routing feature that reads as configured and silently
writes nowhere.

**Two preconditions are owner-only and cannot be automated.** Notion exposes no
endpoint for page-level sharing, so the personal State Doc and its parent must be
connected to the ahKMS integration by hand (⋯ → Connections → ahKMS) or every
configured pointer 404s — the failure already seen on #355. And whether a personal
Daily Log database exists is a fact about the owner's workspace, not the repo; ~~if
one must be created its schema is **minimal** — Name, Date, Type, Summary, and the
two markers — never a copy of the Work schema, which would import pillar
checkboxes and an `Artefacts generated` register the `angus` domain does not have.~~
**— see Erratum 1 below: the database already existed when this was written, and it
is a structural copy of the Work schema, pillar checkboxes included.**

### 7. The unified ritual is `dos`

Both destinations are literally named *Daily Operating System*. The domain becomes
an argument, not part of the name.

- **Survives:** `dos` (nightly) · `dos-catchup` (missed nights) · `dos-reflect`
  (weekly and monthly, per ADR-051 §10)
- **Retires together:** `dos-hl`, `dos-personal`, `dos-infra`, `dos-eod` —
  executed by #415
- **Amended by addition, 2026-08-22 — `dos-catchup` moves from *survives* to
  *retires*.** Catch-up is no longer a separate ritual: it folds into attended
  `dos`, whose standing shape is *fetch today's atoms **and all unconsumed daily
  logs**, handle everything, mark everything*. The list above is left as written;
  this bullet is the correction. `dos-catchup` was never built, so nothing joins
  #415's registry-retirement set — the name is withdrawn, not a capability. See
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
  Amendment 2, and Amendment 2 below.

Nothing is renamed *into* a name that previously meant something narrower, which
is what would happen if `dos-hl` simply grew a second domain and kept its name.
`dos-eod` is specifically not revived: it is a dangling registry row being
retired, and reusing it would produce two capability rows with one name across two
eras — the ambiguity ADR-050 §1 exists to prevent.

The config key follows: `user_preferences.dos_hl_config` → `dos_config`. That
migration is authored alongside #618's `priorities` → `pillars` rename, since both
rewrite the same blob.

### 8. `dos-catchup` is a separate capability, not a flag on `dos`

> **Conclusion superseded in place 2026-08-22 — see Amendment 2 below.** The
> **argument in this section survives**: catch-up must never be a *flag*, because
> behind a flag the logs-not-atoms guarantee is enforced by a boolean that one run
> can leave unset. What is superseded is the **conclusion** that a separate
> capability was therefore the answer. There is a third option this section did
> not consider — make the catch-up read part of `dos`'s **default path**, with no
> dial to set or unset — and that is what was chosen.

Own registry row, own skill body. ADR-051 §14 asserted this; the argument is
recorded here.

The reason is the **input**, not ergonomics. ADR-051 §14's structural claim is that
catch-up reads *daily logs, never atoms*, and that this is what makes the
2026-08-04 failure unreachable — `318216cc`, a confident synthesis of May
assembled from a two-month atom backlog. Behind a flag, that guarantee is enforced
by a boolean, and one run with the flag unset over a stale window restores the old
failure. As two names, the dangerous combination has nothing to call itself.

The `dos-braindump` → `/capture --braindump` precedent (ADR-050 §3) does not
transfer: that flag changes the shape of the *output*, not what the run is
permitted to *read*.

### 9. The state-doc write path becomes domain-addressable

`appendNotionBlocks` is the only export in `packages/mcp-server/src/notion.ts`
with no `token` parameter — it calls `resolveToken()` with no argument, resolving
`getCredential("notion_work")`. Its docstring records the assumption this ADR
falsifies: *"Callers that only ever touch the work workspace (update_state_doc)
omit it."* Every other export either requires a token or takes an optional one its
callers supply.

Separately, `retrieveNotionPage(pageId, token)` exists and is already
workspace-capable but is **not exposed as an MCP tool**, so no skill can read a
State Doc before proposing edits — which ADR-051 §6's review gate requires and
`dos-personal` Setup step 3 has asked for since June.

Therefore `update_state_doc` — rewritten as a section-op tool under **ADR-053**,
which is still Proposed on PR #615 and therefore cited here by number rather than
by link, per ADR-039's rule that an unmerged draft is never authoritative to cite
— takes a **required `domain` argument**, on the same reasoning as its required
`op`: a destination that defaults silently is a destination that will one day be
wrong. Execution is #616; if #615 merges first, this clause becomes a change to
that ADR's scope rather than an addition to it.

## Consequences

- **Good:** the `angus` domain becomes representable rather than absent, and the
  personal State Doc gains a writer for the first time. One word, one meaning —
  `domain` routes, `topics` classify, `pillars` are objectives, `priority` is task
  urgency. The audience axis keeps its exclusion sets at the granularity where
  they matter. The `dos` family reads as one thing with two helpers instead of
  three siblings plus a dangling row.
- **Cost / bad:** an Accepted ADR is superseded in part five days after merging. A
  façade is introduced that can drift from the two stores beneath it. A provider
  rename touches a key column and 31 files. The open audience set removes any
  compile-time check that a report names a live audience. Two preconditions (§6)
  are manual, owner-only, and block everything downstream of them.
- **Follow-up:** #616 (domain-parameterised section-op tool, the block-read path),
  #618 (priority/pillar vocabulary, precondition for authoring pillars), #415
  (registry retirement of the four `dos-*` rows), #617, #561 and `dos-catchup` as
  complementary halves. `docs/architecture/architecture.md` §7 updates when the
  ritual ships.

## Errata and amendments

Recorded 2026-08-21 while closing #679, under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1. **Errata 1 and 2 are
corrections of fact with no decision attached**, so this ADR is edited in place and
its Status line is not stamped: both clauses were written on 2026-08-10 about a
Notion database nobody had read, and the workspace is the source of truth about the
workspace. **Amendment 1 fills a gap** rather than correcting an error — it decides
where one key lives because the restructure could not proceed without deciding, and
it is flagged for ratification in #685 rather than presented as settled.

**A third entry, the #692 supersession note at the end of this section, is neither.**
It corrects nothing: the pillar checkboxes it discusses were really there, and both
errata describe them accurately as of the day they were written. What changed is the
workspace. It is recorded here because §5, §6 and Errata 1–2 all read as current
descriptions and would otherwise send a reader looking for properties that were
deleted the same week.

**A fourth entry, Amendment 2, was recorded 2026-08-22 and carries a decision** —
it retires `dos-catchup`, which §7 lists as surviving and §8 argues for. That is
why this ADR's Status line is now stamped: the "no decision attached, so the Status
line is not stamped" reasoning above covers Errata 1 and 2 only.

**A fifth entry, Erratum 3, was recorded 2026-08-26** and is a correction of fact with
no decision attached, like Errata 1 and 2: it names the wrong issue as executing §7's
retirement.

### Erratum 1 — §6 prescribes a personal Daily Log schema for a database that already existed

§6 says a personal Daily Log, if one must be created, is **minimal** — "never a copy
of the Work schema, which would import pillar checkboxes and an `Artefacts
generated` register the `angus` domain does not have".

Read live 2026-08-21 from data source `35ab7b8b-edcd-811a-a3bc-e37d4ced1d87`
("Personal Daily Log"):

| Property | Notion type |
|---|---|
| `Name` | title |
| `Date` | date |
| `Type` | select |
| `Summary` | rich_text |
| `Synthesis Status` | select (`Confirmed` / `Unconfirmed`) |
| `Other domains` | multi_select |
| `Artefacts generated` | multi_select |
| `Reflection included` | checkbox |
| `P1 Laura` · `P2 Friends and Family` · `P3 Health and Fitness` · `P4 Home and Admin` · `P5 Finances` | checkbox |

It is a structural copy of the Work schema, pillar checkboxes and `Artefacts
generated` included — the exact artefact §6 forbids. The owner had built it before
this ADR was written; §6 did not create the situation it legislates against, it
mis-described one that already existed.

§6's *first* half is the correct instinct and survives verbatim: whether a personal
Daily Log exists "is a fact about the owner's workspace, not the repo". The second
half then legislates about that fact anyway. Only the second half is struck.

The one thing §6 asked for that was genuinely missing — the markers — is not part of
this erratum: the owner added `Synthesis Status` by hand and migration 087 declared
it (#678).

**Consequence:** `angus` gets a `daily_log_schema` that **mirrors the live
properties**, not a minimal one. Ratifying reality is cheaper than reshaping the
owner's workspace to match a guess, and reshaping would delete structure the owner
deliberately built.

### Erratum 2 — §5's "`angus` pillars start empty and stay empty" rests on a void premise

**§5's literal test is unmet, and no usage evidence is claimed here.** §5 says the
list stays empty "until a personal daily log has run often enough to show whether it
wants them". The personal Daily Log has **zero rows** (REST query, 2026-08-21). It
has never run. Nothing about frequency of use justifies this amendment.

What fails is the premise. §5 guards against **a guessed list being projected into
Notion checkbox properties**, which is then "awkward to remove". Neither half of that
describes what is happening:

- **Nothing is guessed.** The five pillars are read from Notion, where the owner
  authored them, and the owner confirmed on 2026-08-21 that they are deliberate and
  current.
- **Nothing is projected.** Data flows Notion → config — the opposite direction to
  the one §5 guards. The config records checkbox properties that already exist; it
  does not create them.
- **The removal cost §5 is protecting is already sunk**, and stays sunk whether or
  not the config names the pillars. An empty config does not un-create the
  checkboxes; it only leaves the ritual unable to tick them — five permanently blank
  boxes on every personal entry, which is #679's actual complaint.

**§5 is narrowed, not repealed.** Its rule still binds anything not already in the
workspace: a pillar list authored config-first, with no Notion counterpart, is still
a guess being projected, and still starts empty. Only ratification of existing
workspace structure is exempt.

The same sentence's surviving half is applied in this PR rather than merely quoted:
**`angus.artefact_registers` ships empty**, because the personal `Artefacts
generated` multi_select has zero options and there is therefore nothing in Notion to
ratify. "An empty list is a legitimate answer" — used exactly as §5 intended, in the
one place where the premise does hold.

### Amendment 1 — `artefact_registers` is per-domain (filling a gap in §5's table)

§5's table classifies eight keys. The blob has nine: `artefact_registers` is in
neither column. #679 could not restructure the blob without placing it, so it is
placed **per-domain**, on the same evidence §5 uses elsewhere — the five live entries
(`Bri`, `Team`, `Mitesh`, `Investor`, `Advisor`) are Work people and audiences,
and a global key would offer "generate an artefact for Investor" on a personal day.

**This is a gap-fill, not a §5 decision, and it may be transitional.**
`artefact_registers` is plausibly the predecessor of a key §5 *does* classify as
global: §4's audience specs carry a **register** as one of four parts, over the same
five names. The likely end state is that `audiences` absorbs it and the key stops
existing — which cannot be settled here, because `audiences` is unbuilt (§4) and out
of scope on #679. Ratification, or a scheduled absorption, is **#685**.

### Superseded by #692 — every "pillar checkbox property" above has been deleted

Recorded 2026-08-21, the same day as the errata above and hours behind them. **This
is not a correction.** The checkbox properties were real, both errata describe them
accurately, and nothing in §5 or §6 was wrong about them. The workspace changed.

**What changed.** A pillar objective was a Notion checkbox property *named after the
objective* (`P1 Launch`, `P1 Laura`, …), which puts time-varying content in the
schema. Changing an objective left two moves and both are bad: rename the property
and Notion rewrites what every historical tick meant, or leave it and the schema
names something retired. Both had happened. On both Daily Logs a `Pillars`
multi-select was created, every historical tick was backfilled into it **verbatim**
(a May entry ticked `P1 Launch` says `P1 Launch`, never `Product`), and the checkbox
properties were then deleted. `Reflection included` survives and is now the only
checkbox on either database.

**Which statements above are now historical, not current:**

- §5's "a guessed list is projected into Notion checkbox properties";
- §6's struck clause about importing "pillar checkboxes";
- Erratum 1's property table, whose last row lists five checkboxes that no longer
  exist — the table is a faithful record of what was read on 2026-08-21 and stays;
- Erratum 2's "the config records checkbox properties that already exist".

Each still reads correctly as an account of that day. None describes the workspace
now.

**What is unaffected, and is the point.** Erratum 2's *reasoning* survives intact —
data still flows Notion → config, the `angus` pillars are still ratified rather than
guessed, and the option strings are the same five strings the checkboxes were called.
Only the mechanism they project through changed.

**The rule #692 adds, which binds anything downstream of this ADR: never rename a
`Pillars` option, only add.** An option name is an objective's immutable identity. A
changed objective is a NEW option; the retired one stops being selected and stays in
Notion so history still reads correctly. Renaming reintroduces the exact defect the
change removed. The rule is carried in config — `daily_log_schema`'s `Pillars`
property notes — so it reaches the ritual at write time and not only here.

Repo-side: migration 089 renames `pillars[].notion_property` → `notion_option` (it is
an option VALUE now, not a property NAME), repoints Work onto its four current
objectives, and declares `Pillars` for both domains. Readers accept both keys, because
the migration is pushed by hand long after the code deploys.

### Amendment 2 — `dos-catchup` retires; catch-up folds into attended `dos`

Recorded 2026-08-22 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1, by the owner, in
the same pass that resolved both of
[ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)'s
errata. **The decision is recorded in full at ADR-051 Amendment 2**; this entry
records what it changes here.

**What changes in this ADR:**

- **§7's list is amended by addition** — `dos-catchup` moves from *survives* to
  *retires*. The bullet is added beneath the original list; the original is left as
  written.
- **§8's conclusion is superseded** — `dos-catchup` is not a separate capability
  either. Its **argument stands and is the reason the fold is safe**: catch-up must
  never be a flag, because behind a flag the logs-not-atoms guarantee is enforced
  by a boolean and one unset run restores `318216cc`. The fold introduces no flag.
  The nightly session **always** reads today's atoms and **all** unconsumed daily
  logs, so there is no dial, no unset state, and no dangerous combination for a run
  to fall into — the guarantee is enforced by there being **one** read shape. §8's
  unexamined premise was that the only alternative to a separate capability was a
  flag.

**What does not change:**

- **The retirement costs nothing operationally.** `dos-catchup` was never built:
  no skill body under `.claude/skills/`, no registry row. #415's retirement list —
  `dos-hl`, `dos-personal`, `dos-infra`, `dos-eod` — is **unchanged**.
- **`dos` and `dos-reflect` still survive**, and the §7 reasoning that put them
  there is untouched.
- **Consequences' follow-up line** — "#617, #561 and `dos-catchup` as complementary
  halves" — reads now as *#561 and the attended `dos` session* as complementary
  halves. #561's machine half is unaffected.
- **This ADR's *Resolves: #569* claim narrows in one word only.** #569 asked for
  "config unification, naming, `dos-catchup`"; the `dos-catchup` part is now
  answered by a fold rather than by a name.

### Amendment 3 - Ratification: `artefact_registers` stays per-domain until `audiences` exists (#685)

Recorded 2026-10-02 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) section 1, following
owner decision on #685 (2026-09-26).

**Decision ratified:**

- `artefact_registers` stays **per-domain** in `dos_config` (ratifying Amendment 1's placement).
- The absorption of `artefact_registers` into section 4's global `audiences` is scheduled to occur when `audiences` ships (tracked in a follow-up issue).
- Section 5's table is updated to list all nine keys explicitly.

### Amendment 4 - Drop provider rename: keep `notion_personal` (#681)

Recorded 2026-10-02 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) section 1, following
owner decision on #681 (2026-09-26).

**Decision ratified:**

- Drop section 3's planned rename of `notion_personal` to `notion_angus`.
- Retain `notion_personal` as the stored provider key in `user_integrations` and
  `artifact_external_links`.
- The domain `angus` maps to `notion_personal` permanently in `DOMAIN_PROVIDER`
  (`packages/mcp-server/src/domains.ts`).
- Avoids the mass data migration and risk of marker or day desynchronization.

### Amendment 5 - Delivery: `audiences` open set + External Advisor audience spec (#743)

Recorded 2026-10-03 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) section 1, following
owner approval on #743.

**Decisions:**

- Deliver section 4's open set of audience specs in `user_preferences.dos_config.audiences`.
- Author External Advisor (`advisor`, External Strategic Advisor) audience spec with register and standing exclusions (personnel, compensation, contractor rates, raw finance, operational chores).
- Wire weekly draft routine (`weekly-scorecard-draft`) to resolve Advisor's spec via `dos_config_get(domain: 'work', audience: 'advisor')` instead of borrowing the internal team register.
- Seed baseline audience specs (`team`, `briana`, `mitesh`, `investor`, `advisor`) per section 4.
- In accordance with Amendment 3, `artefact_registers` remains per-domain for backward compatibility while `audiences` now exists globally.

### Erratum 3 — §7's "executed by #415" names the wrong issue

§7 reads *"**Retires together:** `dos-hl`, `dos-personal`, `dos-infra`, `dos-eod` —
executed by #415."* **#415 is *"dos-hl has forked across surfaces (cowork copy has no
ahkms lineage)"*.** It is a registry-side cleanup, and only its Q4 — *"retire or repoint
the stale `dos-eod` registry entry"* — is inside §7's retirement at all.

The scope is split, and stating it is the whole of this erratum:

- **#569 ships `dos`.** It is the issue that says *"replace the workspace-partitioned
  rituals with one canonical end-of-day synthesis"*, and nothing can retire until the
  thing replacing it exists. §7's own header line already cites it correctly
  (*"the section updates when the ritual ships (#569, #415)"*), and this ADR's
  *Resolves* line names it. Only the bullet drifted.
- **#415 retires the four registry entries**, once `dos` exists. That is the work it
  actually describes, and #569 §8 says so from its own side: *"`dos-eod` → dangling
  registry row, retired under #415 Q4."*

**Nothing is decided here** — no ownership is reassigned that the two issues did not
already have. §7's bullet is left as written; this entry is the correction.

The drift had reach: `docs/vision.md` repeated *"#415 executes the retirement"* from
this bullet until 2026-08-26, so the apex doc told a reader the retirement had an
executing issue when the ritual it depends on had none pointed at it. That is corrected
in the same change as this erratum.

## Links

- **Supersedes in part:** [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) §1 (audience enumeration)
- Builds on: [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md),
  [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md),
  [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md),
  ADR-053 (Proposed, PR #615 — not yet on `dev`, so cited by number)
- Related issues: #569 (the grill), #616, #617, #618, #470, #471, #411, #415,
  #487, #493, #560, #561, #562, #355; #679 (the §5/§6 errata and the per-domain
  restructure), #685 (`artefact_registers` classification), #621 (blob key rename),
  #692 (pillars move off checkbox properties onto an immutable-name multi-select;
  supersedes the renaming approach in #656), #743 (Advisor audience spec and weekly draft routine wiring)
- Evidence: `097bf71f` (gate keyed on an unset field), `318216cc` (unbounded
  catch-up, 2026-08-04), `0e0394ef` / `9df2d048` / `654ebd2e` (the team register)
