# ADR104: Every action call is ledgered, and an agent's outward call waits for the owner

- **Status:** Accepted
- **Created:** 2026-10-10
- **Accepted-on-dev:** 2026-10-11
- **Deciders:** Angus Hally (solo maintainer)
- **Tags:** architecture, actions, security, audit, mcp, web
- **Issue:** #1403. The owner answered the grills on the durable action ledger and the approval gate on 2026-10-10; those grills were not filed as issues. The packets are under Follow-up.
- **Amends:** [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) §1 (cross-cutting concerns: the `auditLog` flag is removed, every call is recorded, `needsApproval` joins the action contract), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) §4 (the front door records, gates and parks legacy tool calls until each family migrates)
- **Amended by:** [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md) (§1: trace and parent ids, a hash chain, client-local records; non-action routes unrecorded until they migrate)
- **Related:** [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md), [ADR-034](./ADR034_Lifecycle_Semantics.md), [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-055](./ADR055_Brevo_Connector_Via_Provider_Hosted_MCP_Upstream.md), [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md), [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md)

## Context and problem

Two gaps meet at one seam.

**Nothing durable says what ran.** `executeAction` prints one stderr line, and only for actions flagged `auditLog: true` (`packages/core/src/actions/adapters/direct.ts:59-64`). The MCP adapter calls `action.run` directly and keeps its own copy of that line (`packages/mcp-server/src/actions/adapters/mcp.ts:63,76-82`). Validation failures are never recorded, because `executeAction` parses before its `try` (`direct.ts:32-34`). The 133 legacy `register()` tools record nothing. When an unidentified scheduled task wrote into ahKMS (#988), the only attribution was the artifact's self-declared surface, although the OAuth client id was on the request (`auth/ownerOAuthProvider.ts:215`).

**Nothing stops an agent acting outward on its own.** Today's gates are set by the caller that wants the side effect (`drive_delete` takes `confirm: z.literal(true)`, `tools/drive/manage.ts:134-138`; an entity bulk delete over 50 takes `confirm`, `tools/entities.ts:596-600`) or are prose (`dex_call_tool`, `brevo_call_tool`, `slack_post`, `server.ts:1782,1804,1844`). Unattended Routines already send mail through `gmail_draft` then `gmail_send_draft` (#1236). The review queue that could hold a request is not execute-once: `review_resolve` checks that a row is pending, then writes without a status predicate (`tools/review.ts:245-262,266-280`) and ignores the generic approval's write error (`:503-512`).

The seam packets (#1404, which records every `executeAction` call to an injectable audit sink, and #1405, which routes MCP dispatch through `executeAction`; the owner split them by layer on 2026-10-11) make `executeAction` the one place both questions can be answered for every surface. The owner answered both grills on 2026-10-10. This ADR records the answers, what each ruled out, and the few points the architect derived from them.

## Decision drivers

- **One seam.** What is recorded and what waits for the owner is decided once, in `executeAction`, for MCP, `/api/actions`, the engine and internal callers alike. Legacy tools borrow the same functions until they migrate. §1 names the calls that do not reach the seam yet.
- **The model never holds an approval.** Release is a human act on a surface no agent can reach.
- **No silent loss.** A failed ledger write is reported, and an approval row never reads as done when the call failed.
- **Body-free records.** The ledger proves what ran, and with which input, without storing the input. The error text is the one field that can still carry input (Consequences).
- **Personal only.** The contracts come from example-org/ops and BuilderIO/agent-native as designs. No code, store, credential or call is shared with either.

## Considered options

Each answer as the owner gave it, then what it ruled out, one line each.

### Ledger

- **L1 Coverage.** Every action call is recorded, reads included. Ruled out: writes and failures only (the grill's recommendation), and agent-native's skip-read-only default; both leave no trail of what an agent read.
- **L2 The `auditLog` flag.** Removed; recording is not optional. Ruled out: keeping it as an opt-in or opt-out, a second rule beside L1.
- **L3 Inputs.** Top-level argument keys plus the SHA-256 of the canonical validated input; never values. Ruled out: redacted full inputs (agent-native), which still hold message bodies; raw params, the ops ledger's leak (example-org/ops#462); keys alone, which cannot tell two calls apart or bind an approval.
- **L4 Legacy tools.** A thin recorder in `makeRegistrar` wraps every legacy `register()` handler now, skips action-backed names so one dispatch writes one row, treats an `isError` result as an error, and goes per family as #1338 migrates it. Ruled out: recording actions only until migration, which leaves most calls unrecorded for months; a recording line inside each handler.
- **L5 Sink failure.** The action's result stands. The failure goes to Sentry and stderr with the request id, and `ahos_doctor` reports the failures since boot and the newest row's age. A stalled insert holds a call for at most 2 s. In the engine, which has no Sentry, a failure reaches stderr only (Consequences). Ruled out: failing the call (a ledger outage becomes a system outage); unbounded or unreported fire-and-forget (silent loss).
- **L6 Retention.** Everything is kept; no purge cadence. Ruled out: a purge, which needs a delete path through an append-only table.
- **L7 Store.** A new `public.action_ledger` table. Ruled out: `activity_logs` (unused, another shape); `system_decisions` (the decision ledger of ADR-079; a call is not a decision).
- **L8 Outcomes.** `success`, `error`, `validation_error`; `denied` and `pending_approval` join when the gate lands. Ruled out: free-text outcomes.
- **L9 Append-only.** RLS on, no `anon` or `authenticated` policy, a trigger that refuses `UPDATE` and `DELETE` (and `TRUNCATE`). Ruled out: narrowing `service_role` grants alone, which one later grant undoes.
- **L10 Attribution.** MCP calls carry the OAuth `client_id` and the MCP `session_id`. Ruled out: a self-declared caller parameter (example-org/ops#400); the signed-in email, which is always the owner here.

### Approval gate

- **G1 Surface.** A gated agent call is parked and returns `{ status: 'pending_approval', decision_id }`. The owner approves in an Approvals inbox in the web UI (`packages/web`), owner-only through the `/api/actions` owner check (#1394). When the MCP client declared the elicitation capability and the session is attended, the gate also asks in-client before it answers; the request row is written either way (D3). Ruled out: refusing with `approval_required` and leaving a draft (agent-native's headless behaviour, the grill's recommendation for Gmail); approving through `review_resolve`, which an agent can call; a page behind the OAuth owner password.
- **G2 Unattended callers.** Routines, the engine worker and stdio park: one mechanism for every gated action, Gmail included. Ruled out: refuse-and-draft for Gmail only; an `unattended` flag per OAuth client (a migration, and an unverified fact about client ids); a self-declared `unattended` parameter.
- **G3 Who is gated.** Every agent caller: `mcp`, `worker`, and `internal` unless inside an already-approved call. The owner's own web clicks (caller `ui` with the owner's JWT) are not. Ruled out: gating by OAuth client id; gating unattended callers only.
- **G4 Legacy tools.** Gated now by the same gate function in `makeRegistrar`, beside the L4 recorder, and removed as each family migrates. Ruled out: waiting for #1338 (the grill draft's position), which leaves Gmail, Drive and Slack ungated for months.
- **G5 First gated set.**
  - `gmail_send_draft` when a recipient is not one of the owner's own addresses (so #1236's self-sends keep working);
  - `slack_post`; `linkedin_post`;
  - `brevo_call_tool` when the upstream tool sends (D5);
  - `drive_share` when `type` is `anyone` or `domain`, or `role` is `owner`;
  - `drive_delete`;
  - `drive_import_file` when `cleanup` is `delete`, which makes `drive_delete`'s permanent delete once the artifact is stored (`tools/drive/import.ts:116-121`); the owner confirmed it on 2026-10-11;
  - a hard delete (`archive_only: false`) of more than 50 entity rows, through `entity_bulk_delete`, `entity_crud`'s `delete` and `bulk_delete` operations, the legacy `entity_delete`, or `person_delete`. People are `entities` rows, and `person_delete` hard-deletes with no threshold and no dry run (`tools/people.ts:563-571`);
  - `calendar_delete_event` when the event has attendees other than the owner.

  Not gated: `appsscript_run_function`, which #1400 marks destructive, and `dex_call_tool`, already marked destructive (`server.ts:1784`), so client permission prompts apply. Ruled out: gating every destructive tool, which turns approvals into noise.
- **G6 Old gates.** Retired in the same series: the `confirm` literal on `drive_delete`, the over-50 `confirm` on entity bulk delete, and the confirm-with-the-user prose on `slack_post`, `brevo_call_tool` and `dex_call_tool`, with the `toolSurface` tests and `docs/guides/tools/*.md`. Ruled out: keeping both, where the caller-set flag adds nothing the gate does not.
- **G7 Requests.** Rows in `system_decisions` (`decision_type 'action_approval'`, `review_type 'approval'`, `stage 'act'`, the input's SHA-256 on the row). Ruled out: a new approvals table; process memory (example-org/ops#458).
- **G8 Expiry.** A pending request expires after 7 days (`status 'expired'`); nothing is ever approved automatically. Ruled out: approve-on-expiry (the ops tier-2 rule); no expiry.
- **G9 Binding.** An approval binds to the input hash; re-entry with a different hash is refused. Ruled out: approving an action for any input.
- **G10 Claim.** A request is claimed by a conditional update on `status = 'pending'`. `review_resolve`'s reject and plain approve get the same predicate, which closes their read-then-write race; its `merge_suggested` writes (`tools/review.ts:356-367,468-484`) get it in #1421, and the `merge_entities` RPC's decision updates in #1397. Ruled out: read-then-write (today's `review_resolve`; the ops registry).
- **G11 Outcome status.** `executed` and `failed` join the `system_decisions` status CHECK by migration. Ruled out: leaving the row `approved` with the result in the payload, where an approved row for a failed send reads as success.
- **G12 Self-approval.** `review_resolve` and `decision_review` refuse `action_approval` rows. Without that, `decision_review`'s approve, reject, modify_and_approve and bulk_resolve (`actions/governance.ts:97-238`) could approve any request, or with bulk_resolve reopen one. Ruled out: one queue for both, which lets an agent approve its own request.
- **G13 Record.** One short ADR amending ADR-100 and ADR-101 §4 for both. Ruled out: two ADRs for one seam.

## Decision

We adopt L1 to L10 and G1 to G13 as stated. This section says how they fit.

### 1. The ledger

`executeAction` hands one record to the process's audit sink for every call, when validation fails or the run settles: action id, caller, request id, user id, OAuth client id and MCP session id (null when absent), outcome, duration, the first 500 characters of an error, the input's top-level keys, the input's SHA-256, the seam that wrote it (`action` or `legacy_tool`) and, when the gate was involved, the decision id. Both front-door processes install a sink at boot that writes the record to `public.action_ledger` and keeps the stderr line; a failed write there reaches Sentry, stderr and that process's `ahos_doctor` count. The engine installs the same sink in its composition root, but core has no Sentry dependency and the doctor counts only the failures of the process it runs in, so an engine sink failure reaches stderr only (engine Sentry waits on #770). A legacy tool's call is recorded by its `makeRegistrar` wrapper in the same shape. A nested dispatch (an action an action calls) is its own dispatch and writes its own row.

Three paths do not reach the seam yet, so L1 covers them only once each is closed:

- **MCP arguments the SDK rejects.** The SDK validates a tool's arguments before any handler runs (SDK 1.29.0, `dist/esm/server/mcp.js:125-126`), so an MCP call never records `validation_error`; the client still gets the SDK's error. #1414 closes it without taking validation away from the SDK: a wrapper around the SDK's own `tools/call` handler records each rejection once as `validation_error`, keys only with a null hash, and leaves the client's result unchanged.
- **The web's client-local actions.** `graph_node_level`, `graph_recalibrate_lod` and `graph_filter` run in the browser and never reach `/api/actions`; the first two write `entities` from the browser (`packages/web/src/lib/graphLevelActions.ts:102-104,267`). #1448 and #1449 move `graph_node_level` to the server. `graph_recalibrate_lod` has no packet yet. `graph_filter` writes nothing.
- **In-process cadences.** The seven in mcp-server and the three in the worker call domain code directly. Each is recorded once it moves into the engine (ADR-101 §5, steps 5 and 6) and runs its work through `executeAction`, as #1415 does for derive.

ADR-101 §4's last sentence now reads: *the front door writes no machine decision of its own; it records every legacy tool call to the action ledger, gates legacy tools through wrappers in `makeRegistrar` and parks gated legacy calls as `action_approval` rows through the same approval store the action seam uses, and each wrapper goes when its family migrates under #1338.*

### 2. The gate

`defineAction` takes `needsApproval: boolean | (input, ctx) => boolean | Promise<boolean>`; a predicate that throws counts as true. After validation, `executeAction` runs a gated call only when one of these holds:

- the caller is `ui` (the owner's web session);
- the context carries an approval for this action and this input hash;
- the caller is `internal` and the context carries an approval for another action (a call nested inside an approved call).

Only in-process code passes `ctx.approval` on to a nested call. Nothing passes it on automatically, so a gated call that tool code makes without it parks. Otherwise `executeAction` parks the call through the approval store, records `pending_approval`, and the surface returns `{ status: 'pending_approval', decision_id }`. With no store configured it refuses and records `denied`. The approval in context is set only by in-process code, never read from an input.

Approving, in the inbox or in-client, claims the row with one conditional update: `pending` to `approved`, only while the row is unexpired, has never been resolved (`resolved_at` is null) and belongs to the approving owner (`user_id`). It then re-checks the stored input against its hash, re-enters `executeAction` with the original caller and the approval in context, and finishes the row as `executed` or `failed`. Rejecting moves `pending` to `rejected`. An engine cadence moves rows past `expires_at` to `expired`. The inbox's list, approve and reject actions are served on `/api/actions` only, never on MCP, and refuse every caller but `ui`.

> **Amendment (2026-10-15, #1534 / #1544):** When a gated call parks, the owner's Slack DM receives an approval card (#1534) carrying inline Approve and Reject buttons, and `POST /webhooks/slack/interactive` (#1544) joins the web Approvals inbox and in-client elicitation as an approved release surface under five verification conditions: (1) Slack HMAC-SHA256 signature verified via `SLACK_SIGNING_SECRET`, (2) workspace `team.id` matches a non-empty `SLACK_ALLOWED_TEAM_IDS` allowlist, (3) clicking Slack user matches `owner_user_id` in `user_integrations` (`provider = 'slack'`), (4) button value carries `decision_id` only and releases through `executeApproved` with `via: 'slack'` (or `reject` on rejection) against the stored input hash, and (5) every outcome updates the Slack card via `chat.update` with buttons removed and never auto-approves.

### 3. Derived by the architect (confirmed by merging this ADR)

- **D1.** The web's in-app agent (the Gemini chat) is an agent caller under G3. Its calls reach `/api/actions` as caller `ui_agent` and are gated; only the owner's clicks are `ui`. The marker is set by the web app's own code, never by the model.
- **D2.** `action_ledger.caller` is text without a CHECK, so a new caller value never costs a row; `outcome` and `seam` keep their CHECKs.
- **D3.** Attended means Streamable HTTP with an OAuth token (stdio never is), a client that declared form elicitation, and an explicit `approve` answer within 60 s. A cancel, a timeout or an empty answer parks; a reject or decline is `denied`. An in-client approval still writes and claims the `system_decisions` row, so both paths leave the same record.
- **D4.** The owner's own addresses for the `gmail_send_draft` predicate are the connected Google accounts' Gmail profile addresses, read from each account's profile and cached for the life of the process. A failed read is never cached, and a lookup failure gates. The graph's self entity is not used, because an agent can edit it.
- **D5.** `brevo_call_tool` sends when any of these holds:
  - the upstream tool's name has `send` as a whole `_`-separated token;
  - the name is one of six sending tools: `conversations_post_messages`, `conversations_post_pushed_messages`, `contact_import_export_create_doi_contact`, `users_inviteuser`, `accounts_invite_admin_user`, `senders_create_sender`;
  - the arguments carry `scheduledAt`, `sendAtBestTime` or `rescheduleFor` set to anything but null or false;
  - a `*_campaign_status` call sets any status but the six that do not send (#1427 lists them);
  - `users_putresendcancelinvitation` resends;
  - `payments_create_payment_request` carries a notification.

  The rule was checked against the live catalogue on 2026-10-10 (#1427: 282 tools, where ADR-055 counted about 27). The catalogue is not ours and churns (ADR-055); a send the rule misses is a packet, not a guess.
- **D6.** The over-50 rule counts the rows the call would delete: the ids given, or the filter resolved first. A dry run is never gated.

## Consequences

- **Good:** what an agent did, from which client and session, has one answer for every surface, legacy tools included, once the gaps §1 names are closed. #988's next occurrence narrows to one OAuth client and one session.
- **Good:** an outward send, a public share or a hard delete from any agent waits for a human act the agent cannot perform, then runs at most once with exactly the input that was approved.
- **Good:** the caller-set `confirm` flags and the prose gates go; the gate is code, and tested.
- **Cost / watch:** every call awaits a ledger insert, bounded at 2 s. A slow Supabase shows up as tool latency before it shows up as failures.
- **Cost / watch:** `error_message` keeps the first 500 characters of a thrown message, and a handler that echoes its input into an error puts that text in the ledger. Nothing redacts it yet (#1411 leaves redaction out); the table is service-role only.
- **Cost / watch:** an engine sink failure reaches stderr only. Core has no Sentry dependency, and `ahos_doctor`'s since-boot count covers only the front-door process it runs in; the newest row's age still shows a stalled table.
- **Cost / watch:** the engine's cadences do not run in production. The worker's Railway config starts `node app.js` (`packages/worker/railway.json`), and `packages/worker/src/engineHost.js:41-44` starts the runner with no cadences. Until #1409 points the worker service at the engine and the owner turns its cadences on (#1410), the expiry cadence (#1429) does nothing in production and the engine writes no ledger rows. #1419's claim and #1422's list filter on `expires_at`, so an expired request can never be approved or listed, but its row keeps reading `pending`.
- **Cost / watch:** the table grows without bound by decision (L6). Revisit with a measured size, never with a delete path through the append-only table.
- **Cost / watch:** a crash, or a `finish` that fails after the claim, leaves the row `approved` with no outcome, the state G11 rules out. #1419, #1420 and #1422 leave recovery out. #1430 moves such a row to `failed` 30 minutes after its claim, never re-running it, and `ahos_doctor` lists it until then; #1430's sweep runs in #1429's engine cadence, so it too needs the engine running in production.
- **Cost / watch:** anything holding the owner's Supabase session is treated as the owner's click: `/api/actions` checks the token's user (#1394), and an absent `X-Action-Caller` header means `ui` (#1418). The session token is never handed to an agent, and the header can only move a call into the gated class, never out of it.
- **Cost / watch:** nothing tells the owner a request is waiting (#1423 leaves notifications out). A send parked by an unattended Routine sits until the owner opens the inbox, and lapses after 7 days.
- **Cost / watch:** the over-50 rule is per call, so a hard delete split into calls of 50 rows is never gated; the ledger is the only trace.
- **Cost / watch:** a Routine whose client declares elicitation waits up to 60 s on a gated call before it parks. If Routines prove to declare it, the per-client flag ruled out in G2 comes back as a grill.
- **Cost / watch:** a host that answers elicitations on the owner's behalf would defeat D3. Only an explicit `approve` runs, and the in-client path is the first thing to switch off if one is seen.
- **Cost / watch:** until each family migrates, `makeRegistrar` carries a recorder and a gate table beside `registerAction`. The family-migration recipe gains one step: the tool's gate entry moves onto the action's `needsApproval` in the same PR.
- **Current state:** nothing here is built when this ADR merges. `docs/architecture/architecture.md` gains the ledger when its sink is wired and the gate when its inbox actions ship, in those packets.
- **Answers:** an A2A peer (deferred) is an agent caller, so its gated calls park like a Routine's.
- **Follow-up (packets, in order):**
  - prerequisites: #1394 (`/api/actions` answers 403 to anyone but the owner), #1400 (the publish, send, run-code and hard-delete tools marked destructive, `appsscript_run_function` among them) and #1407 (one action manifest sets MCP and `/api/actions` exposure);
  - #1404, the core half of the seam packet as amended (every call recorded, `auditLog` removed);
  - #1405, its MCP half (MCP dispatch through `executeAction`, client and session on the record);
  - #1399, `review_resolve` and `decision_review` refuse `action_approval` rows, and `review_resolve` resolves only pending rows;
  - #1411, the `action_ledger` table and Supabase sink;
  - #1412, the sink at boot with Sentry and the doctor line;
  - #1413, the legacy recorder;
  - #1415, the engine through `executeAction`;
  - #1416, `needsApproval` in `executeAction`;
  - #1417, parking in `system_decisions`;
  - #1418, the `ui_agent` caller;
  - #1419, the approval store's claim, finish and reject;
  - #1420, the approval executor (`executeApproved`, `rejectApproval` and `actionResolver`);
  - #1429, the expiry cadence;
  - #1422, the owner-only approval actions;
  - #1423, the web Approvals inbox;
  - #1424, in-client elicitation;
  - #1425, the legacy gate table with `slack_post`, `linkedin_post` and `drive_delete`;
  - #1426, the Gmail, Drive-share and Calendar predicates;
  - #1427, Brevo sends and entity and people hard deletes;
  - #1428, retiring the old gates;
  - #1431, the route, golden-doc, cv and entity skills report a parked call as waiting for the owner and never retry it;
  - #1432, the web chat shows a parked call as waiting for the owner's approval, with a link to the Approvals inbox;
  - coverage (§1): #1414 records the MCP arguments the SDK rejects; #1448 and #1449 move `graph_node_level` to the server.

## Links

- Index: a row for this ADR in `docs/ADRs/README.md`; the ADR-100 and ADR-101 rows gain 'Amended by ADR-104' in the same PR. The two files gain it too, each as an `**Amended by:**` metadata line, because under [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 each link carries its own forward pointer ([ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md) carries one for ADR-096).
- Amends: [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)
- Related: [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md), [ADR-034](./ADR034_Lifecycle_Semantics.md), [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-055](./ADR055_Brevo_Connector_Via_Provider_Hosted_MCP_Upstream.md), [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md), [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md)
- Issues: #770 (worker Sentry), #988 (unattributed writer), #1218 (review queue), #1236 (unattended self-send), #1338 (family migration)
- Designs ported, nothing shared: example-org/ops `substrate/actions` (approval store, ledger; contract only); BuilderIO/agent-native `actions-access-control.mdx` (needsApproval) and `audit-log.mdx`
