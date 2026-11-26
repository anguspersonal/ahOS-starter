# ADR109: Evidence closes its day by arrival, is listed by date, and late arrivals ride the next aggregate

- **Status:** Accepted
- **Created:** 2026-10-14
- **Accepted-on-dev:** 2026-10-14
- **Deciders:** Angus Hally (owner: F1 to F4 chosen on 2026-10-14, recorded on #1781); drafted by the architect under [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md). Merging this ADR is the owner's approval of the two rules in §1 and §2, which the architect proposed.
- **Amends:** [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md) (§5: what the day aggregate counts, which clock defines its day, how late evidence is listed, what a multi-day entry lists, and the per-correspondent grouping); [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§8 and Amendment 7: the streak's states gain the two evidence kinds); [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (§8: a day may also be closed by an evidence row)
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md), [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md), [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md), [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md), [ADR-088](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md)
- **Amended by:** [ADR-110](./ADR110_Metrics_Ride_Artifacts_And_State_Doc_Is_The_Human_Review_Gate.md) (§2 and §3: metrics/evidence-only days closed by the unattended sweep carry no State Doc claims and do not enter the State Doc review queue)

## Context and problem

[ADR-108 §5](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md) decided that the ritual reads narrative atoms one by one, reads evidence as one aggregate per day, and closes a day's aggregate with one row (`evidence_aggregated`, or `evidence_aggregated_unattended` for the sweep) on that day's Daily Log twin. A code map of the five surfaces §5 changes, checked by two adversarial reviews, found that §5 leaves six things open, and gets one wrong (#1781):

1. A day holding only robot receipts, metrics atoms, unenriched pointers, requests or scaffolds has no narrative atom and an empty evidence aggregate, so as written it can never close.
2. §5 does not say which clock bounds the aggregate's day. [ADR-088 §3](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md) puts day windows on `effective_at` and coverage on `captured_at`. The sweep's candidate test reads coverage, and its stampable test reads the aggregate, so the two can disagree about the same day.
3. Evidence captured after a day's closing row (the evening after an attended run, or a later backfill into a closed day) appears in no aggregate.
4. A catch-up entry covers several days, but it has one twin and lists one day's evidence.
5. ADR-052 §8 and ADR-050 §8 name a day's states by the two synthesis kinds only, so the streak has no rule for the evidence kinds.
6. §5 says a day with "evidence atoms, no narrative marker and this row" reads closed. It does not say what a day with unmarked narrative atoms and the row reads as.
7. §5 groups the aggregate "per connection (repo, channel, correspondent)", but no ingest stores a correspondent.

## Decision drivers

1. **The readers stay role-blind.** Coverage, the streak and the doctor scan `idx_artifacts_user_captured_at` index-only (#1221). Making them classify rows by role would cost those scans.
2. **One day, one clock, for closing.** Coverage, the candidate test, the stampable test and the closing row must agree on which day a row belongs to, or a day can be offered and never closed.
3. **Nothing is lost silently.** Atoms never decay (ADR-067 §2), and evidence that arrives late is listed somewhere, or the record says where it is not.
4. **ADR-046 §3 holds.** Metrics stay invisible individually, and synthesis never narrates excluded rows.

## Decision

### 1. Closure (architect's proposal)

A (day, domain) is closed when any of `synthesized`, `synthesized_unattended`, `evidence_aggregated` or `evidence_aggregated_unattended` exists for that domain's provider on that day. An atom's marker counts on the atom's `captured_at` day. The closing row counts on its twin's day. Readers stay role-blind. A closed day that still holds unmarked narrative atoms is not hidden: those atoms stay in the narrative queue, and [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) Amendment 3's signal still reports them.

### 2. The streak (architect's proposal)

`evidence_aggregated` extends the streak, as `synthesized` does. `evidence_aggregated_unattended` pauses it, as `synthesized_unattended` does. On a day that carries kinds from both families, the attended kind of either family decides. `no_material`, `neither` and the in-progress-today rule of ADR-052 Amendment 7 are unchanged. Promotion is unchanged: it writes only `consumed_by_state` on the twin, so a promoted evidence-only day stays unattended, as a promoted narrative day does today.

### 3. What the aggregate counts (owner, F1-1)

The day's aggregate counts every row coverage counts as material that the narrative queue leaves out. That is evidence, metrics, excluded rows, unenriched pointers, task and event requests, and scaffolds. Its top-N and the [ADR-051 §13](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) list draw from evidence only. The closing row closes the day, and `no_material` stays "zero atoms of any tier". The sweep therefore writes a one-line draft for a day that holds only pointers or robot receipts.

### 4. The aggregate's clocks (owner, F2-1)

Membership is on `captured_at`: day D's aggregate counts what arrived on D, the same day coverage, the stampable test and the closing row use. Listing is on `effective_at`: the top-N and §13 list show the rows dated on D, and give the rest one line, "N arrived on D, dated earlier". This refines ADR-088 §3 for this one read: a day's evidence is selected on transaction time and presented on valid time.

### 5. Late arrivals (owner, F3-1)

A late arrival is evidence captured on a day that already carries this domain's closing row, after that row was written. The next aggregate lists late arrivals as their own group. A day with no closing row is left to its own aggregate, so a missed night's evidence is listed once, by the sweep. Evidence captured between a run's aggregate read and its closing row is listed nowhere, because the row stores no read time (`artifact_external_links` has only `created_at`). That gap is accepted, and the evidence stays searchable.

### 6. Multi-day entries (owner, F4-1)

An entry lists evidence for its own date only. The other days it `Covers` are closed by the markers on their narrative atoms (§1). Their evidence stays searchable and is not listed.

### 7. Correspondent is not grouped until an ingest stores it

ADR-108 §3 and §6 name only `account` and the `repo:` tag as envelope connection facts, and no ingest stores a Slack DM counterpart or a mail recipient. Until one does, Slack DMs form one `slack:dm` group and sent mail groups by account. The ingest packet that first writes a counterpart adds the grouping; that needs no new ADR.

## Consequences

- **Good:** every day with material can close, by the ritual or by the sweep, without the readers learning roles. The candidate and stampable tests read the same day. Late evidence is listed once. The streak has a rule for every kind.
- **Cost / bad:** the sweep writes one-line logs for days with nothing to narrate. The aggregate RPC carries two date predicates. Evidence captured during a run, between its aggregate read and its closing row, is listed nowhere. Evidence on a catch-up entry's earlier covered days is never listed.
- **Follow-up:** the slice plan on #1781 (S1 to S4c) builds §5 with these rules; #1781 reopens when #1769 is on `dev` and the engine has written a `scheduler_runs` row (#1409, #1410). This ADR is design only and changes nothing built today, so `docs/architecture/architecture.md` is unchanged ([ADR-039 §2](./ADR039_ADR_Immutability_Metadata_And_Guards.md)); the slices that build the readers and the ritual update it.

## Links

- Resolves: the forks on #1781 (F1 to F4)
- Related: #1767, #1769, #1779, #1780, #1409, #1410, [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md), [ADR-088](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md)
