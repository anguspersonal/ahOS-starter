# ADR110: Retained metrics ride artifacts at `role = 'metrics'`, and the State Doc is the load-bearing human review gate

- **Status:** Accepted
- **Created:** 2026-10-15
- **Accepted-on-dev:** 2026-10-15
- **Deciders:** Angus Hally (owner)
- **Amends:** [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) (§12 and §14: human review is load-bearing at the State Doc promotion hop; attended end-of-day Daily Log review is optional reflection and intent-setting, and `evidence_aggregated_unattended` logs do not wait in the State Doc review queue); [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§1 and the 2026-08-22 open note on tier-3 ingested metrics: resolves the storage question in favour of `role = 'metrics'` atoms in `public.artifacts` rather than a fifth storage primitive); [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md) (§2 and §3: metrics/evidence-only days closed by the unattended sweep carry no State Doc claims and require no human sign-off)
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md), [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md), [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md), [ADR-091](./ADR091_Per_Connector_L3_Map_Versus_Store_Policy.md), [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md)

## Context and problem

While designing time-series tracking for GitHub Actions minutes saved ([#1815](https://github.com/anguspersonal/ahOS/pull/1815)) alongside personal and operational metrics (daily steps, workouts, mood scores, emails sent, RescueTime [#575](https://github.com/anguspersonal/ahOS/issues/575), Fitness [#574](https://github.com/anguspersonal/ahOS/issues/574)), two architectural questions surfaced together:

1. **Where do retained measurements live without inflating the ontology?**
   [ADR-052 §1](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) established that internal system metrics (ritual adherence, capture volume, emails sent) are derived at read from existing tables, and [ADR-091](./ADR091_Per_Connector_L3_Map_Versus_Store_Policy.md) classified external analytics with durable upstream history (`PostHog`, `RevenueCat`, `Meta Ads`) as mapped at read. However, ADR-052's 2026-08-22 note (*"Bears on, not settled here"*) flagged an unresolved tension for ingested third-party or ephemeral measurements (fitness/steps, RescueTime, or GitHub Actions job telemetry whose upstream retention expires after 90 days): are they stored in a dedicated time-series table, or do they ride `public.artifacts` at `role = 'metrics'` ([ADR-046 §3](./ADR046_Per_Source_Ingestion_Policy.md))?
2. **If daily metrics ride `public.artifacts`, what does the human actually have to review?**
   Under [ADR-109 §3](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md), synthesis coverage stays role-blind (`no_material` means zero atoms of any tier). Once daily `role = 'metrics'` atoms arrive on every calendar day, even a quiet weekend day with zero narrative captures has material in `public.artifacts` and produces an unattended Daily Log (`evidence_aggregated_unattended`). If every unattended Daily Log required human sign-off, daily metric ingestion would manufacture a permanent review chore over factual numbers (`"you took 8,400 steps"`).

## Decision drivers

1. **Ontology parsimony (keep the four primitives).** Moving from a pure node-and-edge model to `artifacts`, `entities`, `artifact_entity_links`, and `entity_relationships` already commits the schema to four core knowledge primitives. Adding a fifth `metric_observations` table for numbers that can sit on the timeline as `role = 'metrics'` envelopes widens the schema unnecessarily.
2. **Factual daily summaries are useful; reviewing them by hand is not.** Having a factual daily record that includes step counts, CI savings, and activity aggregates on every day is desirable, provided the unattended sweep closes metrics/evidence-only days automatically and never demands human sign-off on pure facts.
3. **Human attention belongs at the State Doc gate.** In the two-level synthesis chain (`atoms → Daily Log → State Doc`, [ADR-051 §10](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)), the State Doc is the living projection of current priorities, RAG statuses, and open decisions. That second hop is where human confirmation is load-bearing; reviewing the end-of-day Daily Log prose live is a bonus for reflection and setting `tomorrow`'s intention, not an obligation on every calendar day.

## Considered options

### Option A — Add a fifth `metric_observations` time-series table

Store sampled measurements in a dedicated `(user_id, metric_key, observed_at, subject_key, value, dimensions)` table outside `public.artifacts`.

- **Pros:** Keeps `public.artifacts` strictly for prose/documents; `no_material` days remain zero-row days on quiet weekends.
- **Cons:** Introduces a fifth storage primitive alongside the four graph tables; splits ingestion across two pipelines despite [ADR-046 §1](./ADR046_Per_Source_Ingestion_Policy.md)'s single discover-shaped pipeline rule.

### Option B — Keep the four primitives (`role = 'metrics'` in `public.artifacts`) and anchor human sign-off at the State Doc (chosen)

Retained measurements ride `public.artifacts` at `role = 'metrics'`, metrics/evidence-only days close unattended with a factual summary, and human sign-off is required only when promoting narrative changes into the State Doc.

- **Pros:** Zero new database tables; preserves the four-primitive model; gives every day a factual summary record without creating a human review chore on quiet/metrics-only days.
- **Cons:** `no_material` (zero rows of any tier) becomes rare once daily metric syncs run, replaced by `evidence_aggregated_unattended` factual logs closed by the sweep.

## Decision

### 1. Four-way placement of metrics, with zero new storage tables

1. **Internal activity and counts** (e.g. emails sent, captures per day, agent/scheduler runs, adherence) are **derived at read** via SQL over `public.artifacts`, `public.entities`, and `public.action_ledger` ([ADR-052 §1](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)).
2. **Structured attributes on an existing entity or day** (e.g. a workout `event` entity's distance/duration under [ADR-025](./ADR025_Event_Entity_Type.md), or a mood score on the Daily Log twin's `processing_metadata`) live on that entity or twin and are **derived at read**.
3. **External analytics with durable upstream history** (`PostHog`, `RevenueCat`, `Meta Ads`) are **mapped at read** ([ADR-091](./ADR091_Per_Connector_L3_Map_Versus_Store_Policy.md)).
4. **Retained third-party or ephemeral measurements** (e.g. daily step/fitness rollups [#574](https://github.com/anguspersonal/ahOS/issues/574), RescueTime daily buckets [#575](https://github.com/anguspersonal/ahOS/issues/575), GitHub Actions daily workflow telemetry retained past GitHub's 90-day expiry) are ingested as **one `public.artifacts` row per day/source at `role = 'metrics'`** with the structured values and provenance dimensions (such as `head_sha` or regime tags) in `processing_metadata`. Per [ADR-046 §3](./ADR046_Per_Source_Ingestion_Policy.md), `role = 'metrics'` atoms are never LLM-enriched or embedded, and are aggregated deterministically at read.

### 2. Unattended factual closure on metrics/evidence-only days

When a day holds `metrics` and/or `evidence` atoms and zero `narrative` atoms, the unattended sweep writes a factual Daily Log summary (incorporating the day's metric aggregates and evidence list) and stamps `evidence_aggregated_unattended` ([ADR-108 §5](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md), [ADR-109 §3](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md)). An unsynthesised narrative day is never triggered by metrics alone, and the owner is never asked to review or sign off on a day whose only material is factual telemetry.

### 3. The State Doc is the load-bearing human review gate

Across the two-hop synthesis pipeline (`atoms → Daily Log → State Doc`, [ADR-051 §10–§14](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)):

- **Hop 1 (`atoms → Daily Log`):** Can close unattended (`synthesized_unattended` on narrative days, `evidence_aggregated_unattended` on evidence/metrics-only days). Attending the end-of-day Daily Log synthesis live is **optional** — valuable when the owner wants to reflect, draft an outbound audience update, or write the `tomorrow` intention line ([ADR-051 §12](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)), but never mandatory to keep the system moving.
- **Hop 2 (`Daily Log → State Doc`, `consumed_by_state`):** Is the **mandatory human gate**. Unattended runs never write the State Doc. Because `evidence_aggregated_unattended` Daily Logs contain only factual evidence and metric rollups with zero narrative claims that could alter the State Doc, they do **not** enter the unconsumed State Doc review queue; only Daily Logs carrying narrative material wait for the owner's State Doc review.

## Consequences

- **Good:** The database schema stays at the four core knowledge primitives (`artifacts`, `entities`, `artifact_entity_links`, `entity_relationships`) plus the operational `action_ledger`. ADR-052's open note on ingested third-party metrics is settled without a new table. Every day can carry a factual summary of metrics and evidence without creating human review debt, and human review is focused where judgement actually matters: updates to the State Doc.
- **Cost / bad:** `public.artifacts` carries daily `role = 'metrics'` envelope rows with null embeddings, and `no_material` days become rare once daily metric syncs are active (replaced by `evidence_aggregated_unattended` factual logs).
- **Follow-up:** This ADR settles design and ontology only and changes no as-built runtime code today, so `docs/architecture/architecture.md` is unchanged ([ADR-039 §2](./ADR039_ADR_Immutability_Metadata_And_Guards.md), [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md)); `docs/vision.md` is updated in the same PR ([ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md)).

## Links

- Amends: [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md)
- Related: [#494](https://github.com/anguspersonal/ahOS/issues/494), [#495](https://github.com/anguspersonal/ahOS/issues/495), [#574](https://github.com/anguspersonal/ahOS/issues/574), [#575](https://github.com/anguspersonal/ahOS/issues/575), [#1781](https://github.com/anguspersonal/ahOS/issues/1781), [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md), [ADR-091](./ADR091_Per_Connector_L3_Map_Versus_Store_Policy.md), [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md)
