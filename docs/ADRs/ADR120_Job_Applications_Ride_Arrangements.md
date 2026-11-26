# ADR120: Job applications ride arrangements

- **Status:** Accepted
- **Created:** 2026-11-22
- **Accepted-on-dev:** 2026-11-22
- **Deciders:** Angus Hally (owner: seven locked decisions on [#2439](https://github.com/anguspersonal/ahOS/issues/2439), 2026-11-22); grounded in primary-source audits [#2435](https://github.com/anguspersonal/ahOS/issues/2435), [#2436](https://github.com/anguspersonal/ahOS/issues/2436), and [#2437](https://github.com/anguspersonal/ahOS/issues/2437)
- **Builds on:** [ADR-033](./ADR033_External_Vocabulary_Adoption.md), [ADR-035](./ADR035_Relationship_Reification.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md), [ADR-085](./ADR085_People_Organization_Place_And_Event_Anchor_To_Public_Classes.md), [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md), [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md), [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md), [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md), [ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md), [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md), [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md), [ADR-118](./ADR118_Email_Pipeline_Stakes_Weighted_HITL_And_Two_Thinking_Modes.md)

## Context and problem

Angus runs an active personal job search across multiple matchmaker platforms, job boards, recruiting agencies, and direct company applications, generating email confirmations, screening invites, follow-up commitments, and recruiter contacts. Today those facts live scattered across personal Gmail threads and ad-hoc notes with no structured pipeline, no staleness tracking, and no link back to the [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md) career ledger or [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md) tracked CVs.

Database and ontology audit [#2435](https://github.com/anguspersonal/ahOS/issues/2435) confirmed against `origin/dev` and live `kms-db` that every required table and constraint already exists: `public.entities` accepts `entity_type = 'arrangement'` (migration `079`, retained in migration `146`), `public.entity_relationships` is open-vocabulary `text` (migration `049`), `public.user_tasks` carries all [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md) / [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md) dimensions, `public.artifact_entity_links` supports provenance links, and `public.system_decisions` holds [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) `action_approval` rows. Because `ADR-119` is already accepted on `dev`, this contract is minted as **ADR-120**.

## Decision drivers

- **Zero database migrations:** reuse `entities`, `entity_relationships`, `user_tasks`, `artifact_entity_links`, and `system_decisions` without adding tables or SQL `CHECK` enums.
- **Career-ledger isolation:** never pollute [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md) §9's `entity_neighbourhood` CV read (`employer` / `employee`) with job applications.
- **Personal domain containment:** ensure job-search applications always resolve to `angus` ([ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md)), even when notes mention Work, and read only the personal mailbox.
- **Orthogonal lifecycle and pipeline detail:** keep `user_tasks` / entity `status` anchored to [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md) commitment semantics while expressing recruitment funnel detail in a dedicated stage vocabulary.
- **Derived metrics, never stored:** compute funnel counts, interview rates, silence flags, and next-action schedules at read time ([ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)).
- **Safe unattended execution:** interactive UI/MCP edits apply immediately, while unattended mutations route through the owner-only Approvals inbox ([ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)).

## Considered options

### Option A — Dedicated `job_applications` SQL table and entity type

- **Pros:** relational columns for `stage`, `channel`, and `applied_on`.
- **Cons:** requires new Supabase migrations, RLS policies, and a new `entities.entity_type` value; duplicates graph participation, provenance linking, and task attachment already modelled on `arrangement` nodes.

### Option B — Reuse `arrangement` with existing `employer` / `employee` edges

- **Pros:** zero new `EDGE_TYPES` strings.
- **Cons:** breaks [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md) §9, whose CV render traverses `employer` and `employee` edges without filtering `properties.kind`, pulling active applications into employment history.

### Option C — Job applications ride `arrangement` (`kind: 'job_application'`) with five dedicated participant edges (chosen)

- **Pros:** zero migrations; inherits GIN-indexed `properties`, `tags`, `aliases`, `artifact_entity_links`, and `user_tasks.entity_id`; keeps career-ledger queries isolated via dedicated edges; shares one isomorphic TypeScript contract across Core, MCP, and Web.
- **Cons:** active-title uniqueness (`entities_user_entity_type_title_lower_unique`, migration `129`) requires deterministic title/re-application handling in `job_application_upsert`.

## Decision

We chose **Option C** and lock the seven owner decisions from [#2439](https://github.com/anguspersonal/ahOS/issues/2439) as the Phase 1 MVP contract.

### 1. Application node (`entities.entity_type = 'arrangement'`)

Each job application is an `entities` row with `entity_type = 'arrangement'`, `title = "<Organisation> · <Role>"`, `domain_override = null` (inherited from `Job Search` area containment in §4), and `properties.kind = 'job_application'`.

`properties` carries:
- `kind`: `'job_application'` ([ADR-035](./ADR035_Relationship_Reification.md) §4).
- `role_title`: advertised role title (`string`).
- `role_category`: one of `ROLE_CATEGORIES` (§5).
- `channel`: one of `APPLICATION_CHANNELS` (§5).
- `ats`: optional ATS identifier for `company_site` (`lever`, `greenhouse`, `ashby`, `workable`, `rippling`, `teamtailor`, `ucl_portal`, etc.).
- `stage`: one of `JOB_APPLICATION_STAGES` (§3).
- `stage_history`: append-only event array `[{ stage, at, source?, evidence_artifact_id?, note? }]` ([ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) §2).
- `applied_on`: nullable ISO date (`null` for pre-application stages `identified`, `matched`, and `drafting`).
- `date_precision`: `'day' | 'month' | 'estimated' | 'unknown'`.
- `closed_on`: nullable ISO date, set when entering a terminal stage.
- `salary_band`: optional advertised band string.
- `salary_expectation_submitted`: optional numeric figure entered on an application form (private personal finance data; never written outward).
- `platform_ref`: optional external reference (for example UCL `B28-00397`; highest-priority match key).
- `priority_level`: `1..7` integer on the [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md) scale.
- `status`: [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md) `TaskStatusSlug`, always derived by `statusForStage(stage)`, never set independently.
- `source`: [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md) `TaskSourceSlug` (`owner`, `email_triage`, `agent_proposed`, etc.).
- `notes`: optional short factual notes.

### 2. Five minted participant edges (`EDGE_TYPES`, ADR-033)

Append five `ahos:`-native edge strings to `EDGE_TYPES` in `packages/core/src/domain/vocab.ts` (re-exported unchanged by `@ahkms/mcp-server` and `relationshipType.ts`). Per [ADR-033](./ADR033_External_Vocabulary_Adoption.md), none are added to external JSON-LD `@context` maps because no published ontology term matches `arrangement -> participant` with these semantics:

| Edge | Direction & cardinality | Nearest external term (why minted) |
| --- | --- | --- |
| `applicant` | `arrangement` → `people` (self), `1` | `schema:agent` sits on `schema:ApplyAction`, not a reified arrangement |
| `applied_to` | `arrangement` → `organization`, `0..1` | `schema:hiringOrganization` has domain `schema:JobPosting`, not an application arrangement |
| `applied_via` | `arrangement` → `organization` (job site / agency), `0..1` | `schema:instrument` sits on `schema:Action`, not an arrangement participant |
| `recruiter` | `arrangement` → `people`, `0..n` | `schema:participant` / `schema:agent` loses the external-recruiter distinction |
| `hiring_contact` | `arrangement` → `people`, `0..n` | `schema:contactPoint` targets `schema:ContactPoint`, not `foaf:Person` |

`employer` and `employee` are deliberately not reused so [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md) §9's career-ledger query remains isolated.

### 3. Locked Decision 1 — 11 stages and `statusForStage`

`JOB_APPLICATION_STAGES` defines 11 stages using `DimensionTerm<JobApplicationStage>` plus `terminal` and `submitted` flags, mapped deterministically to [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md) `TaskStatusSlug`:

| # | Stage (`slug`) | `statusForStage` | `terminal` | `submitted` | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `identified` | `proposed` | `false` | `false` | Self-found / saved, undecided; counts in `to_review`; creates `"Decide: apply or pass"` task (+3 days, priority 4) |
| 2 | `matched` | `proposed` | `false` | `false` | Suggested by platform / recruiter / agent, undecided; counts in `to_review`; creates `"Decide: apply or pass"` task (+3 days, priority 4) |
| 3 | `drafting` | `todo` | `false` | `false` | Started, not yet submitted; excluded from `submitted` and `to_review` |
| 4 | `applied` | `in_progress` | `false` | `true` | Submitted; awaiting human reply |
| 5 | `screening` | `in_progress` | `false` | `true` | First call offered, booked, or held |
| 6 | `interviewing` | `in_progress` | `false` | `true` | Subsequent rounds, tasks, or panels |
| 7 | `offer` | `in_progress` | `false` | `true` | Offer received |
| 8 | `accepted` | `done` | `true` | `true` | Offer accepted |
| 9 | `rejected` | `cancelled` | `true` | `true` | Declined by organisation; retained for lineage |
| 10 | `withdrawn` | `cancelled` | `true` | conditional | Counts as `submitted` only when `applied_on` is set |
| 11 | `closed_no_reply` | `cancelled` | `true` | `true` | Closed after prolonged silence (manual or 42-day auto-close) |

Every non-terminal application maintains a single open `user_tasks` row (`entity_id = application.id`), replaced or completed when advancing stages and cancelled/completed on terminal entry.

### 4. Locked Decision 2 — Personal mailbox scope and `Job Search` area containment

Job-hunt email ingestion and evidence reads scope strictly to the **personal mailbox only (`angus` domain)**; the Work workspace and mailbox are out of scope.

Audit [#2435](https://github.com/anguspersonal/ahOS/issues/2435) showed that live `angus` `domain_signals` do not match job-search vocabulary and `resolveEntityDomain` evaluates `work` signals first. Therefore, the `Job Search` area entity (`entity_type = 'area'`) is seeded with `domain_override = 'angus'`, and each application attaches via a single primary `belongs_to -> Job Search` edge so `resolveEntityDomain` Step 3 resolves every application to `angus` (`resolved_by: 'parent'`) even when notes reference Work.

Job-site organisations (`tags: ['job-site']`, `properties.channel_kind`, `properties.url` per [ADR-085](./ADR085_People_Organization_Place_And_Event_Anchor_To_Public_Classes.md)) must keep `Dex jobs` (`https://meetdex.ai`, aliases `["Dex jobs", "meetdex", "meetdex.ai"]`) strictly separated from the Dex CRM integration (`getdex.com`): bare `"Dex"` is forbidden as an alias for `Dex jobs`.

### 5. Locked Decision 3 — Role categories and channels

`ROLE_CATEGORIES` is the closed 6-value taxonomy (`DimensionTerm<RoleCategory>`): `product`, `ai_engineering`, `data_leadership`, `ops_chief_of_staff`, `solutions`, `other`.

`APPLICATION_CHANNELS` is the 8-value channel taxonomy (`DimensionTerm<ApplicationChannel>`): `jumpstart`, `cord`, `dex_jobs`, `jack_and_jill`, `company_site`, `recruiter`, `referral`, `direct_outreach`.

### 6. Locked Decisions 4 & 5 — 14-day silent threshold and 7 / 14 / 28 / 42-day cadence

- **Silent threshold (`SILENT_THRESHOLD_DAYS = 14`):** An `applied` application with `>= 14` days elapsed since its last inbound human reply (or `applied_on` when no inbound reply exists) is flagged `silent` (`false` at 13 days, `true` at 14 days).
- **Follow-up cadence (`FOLLOWUP_CADENCE_DAYS = [7, 14, 28]`):** Unanswered `applied` applications surface chase nudges at **7 days (1 week)**, **14 days (2 weeks)**, and **28 days (4 weeks)**.
- **Auto-close (`AUTO_CLOSE_DAYS = 42`):** At **42 days (6 weeks)** without an inbound human reply, an `applied` application transitions to **`closed_no_reply`** (`status = 'cancelled'`, `terminal = true`).
- **Derived metrics ([ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)):** `submitted`, `reached_interview` (`stage_history` contains `screening` or later), `rejected`, `silent`, `to_review` (`identified` or `matched`), `drafting`, and `interview_rate` (`reached_interview / submitted`), aggregated overall, by channel, and by role category in `packages/core/src/domain/jobApplications.ts`.

### 7. Locked Decision 6 — Optional CV document link

Applications support an optional `references` edge (`dcterms:references`, already in `EDGE_TYPES`) from the application `arrangement` to the [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md) tracked CV `resource` entity, enabling version-level conversion analysis without adding schema columns. Specific tailored CV rendition artifacts can additionally attach via `artifact_entity_links` (`link_type = 'related'`).

### 8. Locked Decision 7 — Unattended vs interactive routing

Composite operations live in `@ahkms/core` (`packages/core/src/actions/jobhunt/`, distinct from `actions/jobs/`):
- **Interactive UI/MCP calls** to `job_application_upsert` execute directly (refusing with candidate matches on ambiguous match).
- **Unattended calls** (for example background email ingestion with `caller === 'worker'` or review-band confidence) route through the owner-only [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) Approvals inbox (`approval_list` / `approval_approve` / `approval_reject` over `system_decisions` `action_approval` rows), which auto-executes on owner approval.
- Reads flow through `job_pipeline_read` so web and MCP consumers share identical derived metrics.

### 9. Phase 2 Contract — Personal-mailbox Gmail ingestion (`#2440`, `#2452`)

- **Dedicated core action & cadence seam:** `job_hunt_gmail_ingest` (`packages/core/src/actions/jobhunt/jobHuntGmailIngest.ts`) runs as a standalone CAR action invoked via `runJobHuntGmailSweep` (`packages/core/src/engine/cadences/jobHuntCadence.ts`) inside the existing hourly `gmail_automations` lock (`connector: "job_hunt_gmail"` in `packages/mcp-server/src/schedule/index.ts`), with zero new schedule files and zero changes to `gmail_priority_triage`.
- **Personal mailbox containment:** Strictly scoped to `domain: "angus"` across all mail plus `in:sent`; any other domain is rejected. Never sends, replies to, or archives mail, and never removes `INBOX`.
- **Deterministic System 1 classifier:** Pure isomorphic rules in `packages/core/src/domain/jobApplicationEmail.ts` classify ATS confirmations/rejections (Lever, Greenhouse, Ashby, Workable, Rippling, UCL portal with `platform_ref`, Teamtailor, Firststage), multi-role digests (Dex jobs `"Thanks for applying"`, Jack & Jill), Jumpstart statuses/intros, task-only alerts (`matchmaking@careers.example.com`, `update@hiring.example.com` -> `proposed` tasks without overwriting stage tasks), and evidence-only mail (`notify@updates.jobs.example.com` screening briefings, inbound linked-contact replies, and owner `in:sent` replies; only inbound human replies update `last_inbound_at`).
- **Application matching order:** `platform_ref` → single application linked to the same Gmail `thread_id` → `(organisation, normalised role_title)` (including aliases and the `Dex jobs` alias collision guard). Multi-candidate matches park for review rather than guessing.
- **Approvals gating, watermarks & rollout modes:** Per-message watermarks ride `public.system_decisions` (`decision_type = "job_application_update"`, keyed on `message_id` + `item_key`, ignoring `mode: "shadow"` rows and skipping Gmail message IDs already linked as provenance on seeded applications). Gated independently via `KMS_JOB_HUNT_GMAIL_ENABLED` (default `false`) and `KMS_JOB_HUNT_GMAIL_MODE` (default `"shadow"`): `dry_run` writes nothing; `shadow` writes audit-only watermarks; `label` adds additive `ahOS/job-hunt` and parks `job_application_upsert` in the ADR-104 Approvals inbox; `act` auto-executes unambiguous, conflict-free updates only when `user_preferences.confidence_thresholds.job_application.auto_apply` is explicitly enabled and met.

## Consequences

- **Good:** zero database migrations; full reuse of graph edges, task dimensions, tracked-CV links, and ADR-104 action ledgering/approvals; deterministic isomorphic domain contract pinned against the 27-row Appendix A baseline.
- **Cost / bad:** active-title uniqueness (`entities_user_entity_type_title_lower_unique`) requires explicit re-application disambiguation in `job_application_upsert`, and automated follow-ups/auto-closes depend on Phase 2 ingestion/cadence wiring (`#2440`).
- **Follow-up:**
  - **P2:** implement `job_application_upsert` and `job_pipeline_read` in `packages/core/src/actions/jobhunt/` plus `TaskRepository` (`entity_ids`) and `ArtifactRepository.listLinkedArtifactsForEntities` port extensions (`#2436`).
  - **P3 (owner-attended):** seed `Job Search` (`domain_override = 'angus'`), job-site organisations (including `Dex jobs` collision guard), 27 Appendix A rows, and the `job-hunt` capability.
  - **P6:** build `/job-hunt` web view in `packages/web` (`#2437`).
  - **Phase 2 (`#2440`):** wire Gmail personal-mailbox ingestion (`job_hunt_gmail_ingest`) and cadence/nudge sweep (`job_hunt_nudge_sweep`).
  - Same-PR current-state sync: `docs/architecture/architecture.md` `## Capability status (what actually works today)` updated in the same PR.

## Links

- Resolves: P1 domain contract and ADR in [#2439](https://github.com/anguspersonal/ahOS/issues/2439)
- Related: [#2434](https://github.com/anguspersonal/ahOS/issues/2434), [#2435](https://github.com/anguspersonal/ahOS/issues/2435), [#2436](https://github.com/anguspersonal/ahOS/issues/2436), [#2437](https://github.com/anguspersonal/ahOS/issues/2437), [#2440](https://github.com/anguspersonal/ahOS/issues/2440)
- Related ADRs: [ADR-033](./ADR033_External_Vocabulary_Adoption.md), [ADR-035](./ADR035_Relationship_Reification.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md), [ADR-085](./ADR085_People_Organization_Place_And_Event_Anchor_To_Public_Classes.md), [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md), [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md), [ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md), [ADR-116](./ADR116_Universal_Seven_Point_Priority_Scale_And_Surface_Mappings.md), [ADR-117](./ADR117_Orthogonal_Task_And_Actionable_Entity_Dimensions.md), [ADR-118](./ADR118_Email_Pipeline_Stakes_Weighted_HITL_And_Two_Thinking_Modes.md)
