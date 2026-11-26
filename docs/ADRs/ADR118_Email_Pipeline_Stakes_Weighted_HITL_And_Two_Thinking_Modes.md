# ADR118: The email pipeline judges with two thinking modes, gates by stakes, and is measured against a 15-a-day attention budget

- **Status:** Accepted
- **Created:** 2026-11-08
- **Accepted-on-dev:** 2026-11-08
- **Deciders:** Angus Hally

## Context and problem

The first native triage (`gmail_priority_triage`, #1990 / #2013) shipped a 1..7 score
and a three-tier storage boundary, but a live dry run over 100 inbox threads on
2026-11-08 showed it cannot be switched on:

1. **Promotions scored as urgent.** Any message whose `To:` held the owner's address and
   whose sender was not flagged automated became `to_respond` (base 5) plus one for being
   a direct recipient. The port never set the automated flag, so a Calvin Klein sale
   scored P6 and ten more retail and SaaS mails scored P5.
2. **The Work mailbox was blind.** The owner-address list held `owner@work.example.com`
   but the mailbox is `owner@work.example.com`, so nothing there read as direct. Every
   Work thread scored P4 or lower, and the sweep rule ("archive everything under the
   cut-line when anything is above it") would have archived a partner's "Call This
   Week", two meeting invitations and two documents the co-founder shared.
3. **One model of trust for everything.** Confidence was a hard-coded 0.85, there was no
   rule for when a human must decide, and Gmail's own tabs were not read at all, neither
   as evidence nor as something to distrust.
4. **No measure of success.** Nothing counted the inbox, what arrived, what was
   processed, or how much reached the owner, so "is it working" had no answer.

The goal is concrete: **fewer than 15 emails a day need the owner's attention, and those
are the right ones.**

## Decision drivers

- A wrong archive of a person's email costs a relationship; a wrong archive of a promotion
  costs nothing. The gate must know the difference.
- Gmail's automatic sorting is useful evidence and frequently wrong; it must never
  outrank the owner's own graph.
- Model calls cost money and latency; most of the inbox is machine mail a model adds
  nothing to.
- Every step must be reversible unattended: nothing sent, nothing deleted.
- One rubric, judged the same way by rules and by the model, and versioned so a change
  can be measured.

## Considered options

### Option A: tune the first-cut scorer

- **Pros:** small diff.
- **Cons:** the defects are structural (no stakes, no thinking-mode split, no metrics);
  tuning weights would move the failures, not remove them.

### Option B: send every thread to a model

- **Pros:** best per-thread judgement.
- **Cons:** about 50 model calls an hour for mail that List-Unsubscribe already
  classifies; and with no deterministic floor, a model outage would stop the pipeline.

### Option C: a staged pipeline, System 1 everywhere and System 2 where stakes or doubt warrant it, gated by stakes

- **Pros:** cheap on machine mail, careful on people, degrades safely when the model is
  down, and every stage is separately testable and measurable.
- **Cons:** more moving parts.

## Decision

We chose **Option C**. One run of `gmail_priority_triage` is:

1. **Signals (System 1)** in `domain/emailSignals.ts`: sender kind (`self`,
   `known_contact`, `human`, `automated`, `bulk`) from headers (`List-Unsubscribe`,
   `List-Id`, `Precedence`, `Auto-Submitted`), address shape and the graph match; text cues
   (ask, deadline, money, security, legal, calendar, promotion, receipt, share). The owner's
   addresses come from `user_preferences.identity.emails` plus a constant fallback.
   **Gmail's tab is a weak prior**: it can lower confidence but never sets a verdict, and
   `gmailCategoryContradiction` is raised whenever Gmail files a known contact or a human's
   direct ask outside Primary.
2. **Rubric** in `domain/emailRubric.ts` (`EMAIL_RUBRIC_VERSION`): a definition, inclusions
   and exclusions for each of the eight intent categories, an email reading of each step of
   the ADR-116 scale, and four priority factors (who, ask, time, stakes). The System 1 pass
   (`assessEmailSystem1`) applies it deterministically; the same text is rendered into the
   System 2 prompt. Each decision records the rubric version it was judged under.
3. **Thinking mode** (`selectThinkingMode`, `EMAIL_TASK_THINKING_MODES`): signal
   extraction, noise filtering, routing, the HITL gate, Gmail writes and metrics are always
   System 1. Categorising and prioritising start in System 1 and **escalate** to System 2
   when the thread is high-stakes or System 1 confidence is under 0.7. Reply drafting and
   entity and task extraction are System 2 only.
4. **System 2** (`ports/emailReasoner.ts`, `adapters/email/llmEmailReasoner.ts`) runs on
   the existing derive LLM transport (Gemini by default, no new key). Its context is the
   sender's graph profile (relationship, organisation, role, last contact), a matched
   organisation entity, open tasks naming them, and a bounded excerpt of the domain's
   State Doc. It returns category, priority, calibrated confidence, a one-line rationale,
   an optional reply draft (tone rules enforced, em dashes stripped), and extracted tasks
   and entities. A failure returns null: the thread keeps its System 1 judgement with its
   confidence capped below the auto-apply band, so the gate holds it.
5. **Routing** (`routeEmail`): `attention`, `draft_reply`, `review`, `calendar`,
   `awaiting_reply`, `digest`, `archive`, `unsubscribe_candidate`, each with an `ahOS/*`
   label. Only the first three keep the thread in the inbox.
6. **HITL, weighted by stakes** (`isHighStakes`, `applyHitlPolicy`). A thread is
   high-stakes when a person is involved, it is sensitive (money at risk, security, legal),
   Gmail and the graph disagree, or it sits one step below the attention line; calendar
   bookkeeping is never high-stakes. The owner decides when the thread is going to them
   anyway, when it is high-stakes and confidence is under 0.9, when a known contact would be
   archived without a confident System 2 read, when sensitive mail has not been cleared by
   System 2, or when Gmail and the graph disagree. Below 0.55 nothing touches the thread.
   Low-stakes machine mail auto-applies above 0.55. **Sending is never in scope**: drafts
   wait in Gmail, and `gmail_send_draft` keeps its own approval gate.
7. **Budget** (`applyAttentionBudget`): what reaches the owner is ranked by priority, route
   and recency and capped at the daily budget (15) less what earlier runs surfaced today.
   Priority 7 is never cut. Overflow stays in the inbox flagged `over_budget`: a breach is a
   rubric problem to fix and is measured, never hidden.
8. **Modes**: `shadow` (default; log only), `label` (add `ahOS/*` labels), `act` (archive
   what the gate cleared, save drafts, create tasks extracted at 0.9 or more). `dry_run`
   writes nothing at all. Threads already decided are skipped (the `system_decisions`
   watermark). Threads that reach the owner are promoted to Tier-3 artifacts carrying the
   System 2 extraction in `processing_metadata.gmail`, so the derive pass and
   `process_artifact` start from it.
9. **Metrics**, placed per ADR-110 §1. Each run returns `metrics` (`domain/emailMetrics.ts`)
   and the cadence writes them flat onto `scheduler_runs.counts` (connector `gmail_triage`)
   as the run-health trail. The dashboard does not read that trail (it is hourly, covers
   only scheduled runs, and would have to sum overlapping runs). Instead
   `gmail_triage_metrics` returns a daily series (`domain/emailMetricsSeries.ts`, days cut at
   Europe/London midnight) built from two sources. **Flows** (processed, new, needs attention
   against the budget, review and how much of it the owner resolved, drafts, tasks,
   entities, routes, System 1 versus System 2, Gmail-tab contradictions, owner corrections)
   are **derived at read** from the decision rows in `system_decisions` (ADR-110 §1.1), so
   attended runs and later corrections count and nothing is stored twice. **Stocks** (inbox
   and unread threads per account) are **retained**, because Gmail keeps no history of them:
   every run outside `dry_run` updates one `role = 'metrics'` artifact per local day
   (`content_subtype = 'email_mailbox_daily'`, `dedup_key = 'email_mailbox_daily:<date>'`,
   surface `kpi_snapshot`, derivation skipped), so the day keeps its latest counts
   (ADR-110 §1.4). The web dashboard's Email pipeline panel reads the action.
10. **Cadence**: `runGmailTriageCadence` runs the registry action hourly under the
    existing `gmail_automations` lock, on by default under the master scheduler switch in
    `shadow` mode (`KMS_GMAIL_TRIAGE_ENABLED`, `KMS_GMAIL_TRIAGE_MODE`,
    `KMS_GMAIL_TRIAGE_INTERVAL_MINUTES`, `KMS_GMAIL_TRIAGE_MAX_THREADS`,
    `KMS_GMAIL_TRIAGE_ATTENTION_BUDGET`). The owner promotes it to `label`, then `act`, by
    environment variable once the shadow metrics look right.

## Consequences

- **Good:** replaying the 2026-11-08 sample through System 1 alone, with no list headers
  and no model (the pessimistic case), sends 22 of 100 threads (about two and a half days
  of mail across both mailboxes, so roughly nine a day) to the owner. The first cut sent
  15, of which 12 were machine mail, and would have archived at least five threads people
  wrote to the Work mailbox. In the replay every thread a named person wrote directly is
  among the 22 and no retail promotion is; most of the rest are newsletters whose list
  headers the replay could not see. With headers and System 2 that share falls further.
- **Good:** the first cut's two silent failures (Work blindness, sweep-everything) are
  now regression tests built from the live sample.
- **Good:** `review` decisions land in `system_decisions` as `status: pending`,
  `requires_user_action: true`, `review_type: clarification`, so the existing
  `decision_review` surface shows them.
- **Cost:** up to 40 System 2 calls a run (`maxSystem2Calls`); on the sample, 22 of 100
  threads escalate.
- **Cost:** the rubric's cue lists are English and hand-written; they will need upkeep, and
  the version stamp exists so that upkeep can be measured.
- **Follow-up:** the Curated Priority Inbox (`packages/web`) should read `route`,
  `requires_human`, `thinking_mode` and `over_budget` instead of recomputing tiers;
  owner corrections should feed an override-rate metric and few-shot examples back into
  the System 2 prompt; a daily digest artifact should list the `digest` route; the
  `Email Mgmt` Apps Script triggers retire once `act` mode has run clean for a week (#1989,
  #1990); calibrated confidence from #2121 can replace the model's self-reported number.

## Links

- Supersedes the routing and sweep rules of the first cut: #1990, #2012, #2013
- Uses: [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md)
  (the 1..7 scale), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)
  (sending stays gated), [ADR-110](./ADR110_Metrics_Ride_Artifacts_And_State_Doc_Is_The_Human_Review_Gate.md)
  (metrics ride run records), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)
  (rules and ports in core, adapters in mcp-server)
- Related: #2121 (calibrated decision judge), #2023 (enable the Gmail cadence on Railway),
  #1989 (Apps Script stopgap)
