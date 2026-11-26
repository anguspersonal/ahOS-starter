# @ahkms/mcp-server (Phase 0)

A minimal MCP server that exposes the knowledge store as tools so you can
**dump-and-ask** from any MCP client (Claude Desktop, Claude web, the Agent SDK).
This is the Phase 0 trial described in `docs/ADRs/ADR012_Assemble_MCP_Tool_Layer.md`
and scoped in `docs/design/mcp-tool-layer.md`.

It runs **alongside** the existing app and deletes nothing.

## Tools

### Knowledge store

| Tool | Purpose |
|---|---|
| `capture` | Dump a note/content → stores the body in Storage + inserts an `artifacts` row. |
| `knowledge_search` | Full-text search over your artifacts (substring fallback if migration 044 isn't applied). |
| `artifact_get` | Fetch one artifact's full content + linked PARAMPS entities by id. |
| `artifact_get_file` | Same as `artifact_get`, plus a resolvable reference to the artifact's original file when one exists: a short-lived Storage signed URL for a real stored file, an as-is external link for a discovered pointer, or a clean null for a plain-text capture with nothing beyond its `plain_text`. |
| `artifact_update` | Patch one artifact row by id, including routing audit / provenance fields. |
| `artifact_extract_text` | Extract text from a captured PDF/image artifact (via Claude) into its searchable content. |
| `task_create` | Create a task in the user's external task system (Notion / "Work"). Routes to the database id in `user_integrations`. |
| `person_get` | Read one people row by id. |
| `person_match` | Rank candidate people rows from source clues. |
| `person_query` | Read rows from the `people` view/table with filtering. |
| `person_create` | Create one or many people rows. |
| `person_upsert` | Create or update one or many people rows. |
| `person_update` | Update one or many people rows by ids or filters. |
| `person_delete` | Delete or archive one or many people rows by ids or filters. |
| `entity_get` | Read one entity row by id. |
| `entity_query` | Read entity rows with filtering across type, ids, user/team scope, and archived state. |
| `entity_create` | Create one or many entities. |
| `entity_upsert` | Create or update one or many entities. |
| `entity_update` | Update one or many entities by ids or filters. |
| `entity_delete` | Delete or archive one or many entities by ids or filters. |
| `entity_unmerge` | Reverse an entity merge operation by `op_id`. Restores loser, moves edges and links back, un-archives redundant edges, and removes merged-in aliases and properties from winner. |
| `link_create` | Create one or many artifact-entity links. |
| `link_get` | Read one artifact-entity link by id. |
| `link_query` | Read artifact-entity links with optional filters. |
| `link_upsert` | Create or update one or many artifact-entity links using the unique key. |
| `link_delete` | Delete one artifact-entity link by id. |
| `artifact_sync_entities` | Resolve extracted entities, create missing rows, and link all resolved entities to one artifact. |
| `artifact_sync_people` | Legacy alias for `artifact_sync_entities`. |
| `integration_list` | List which external integrations are configured (without revealing stored ids). |
| `config_capture_get` | Show the owner's persisted, user-specific capture context (default tags, source channel, tag routing maps) from `user_preferences`. |
| `state_doc_update` | Edit one section of a Notion State Doc (`domain`: `work` / `angus`) by exact heading - `replace` / `rename` / `insert` / `delete` - and stamp `Last updated`. |
| `daily_log_create` | Create ONE Daily Log entry in a domain's Notion database (`domain`: `work` / `angus`, required). Discovers the destination's title/date properties, validates caller-supplied `properties` against a live read, refuses a duplicate for a date already logged, and returns `page_id` / `page_url` / `provider`. The dos ritual's writer only: a session note is a `capture`, and only the ritual stamps synthesis markers against an entry (#1017). |
| `notion_search` | Find a page or database by TITLE in either workspace (`domain`: `work` / `angus`, required, no default). Titles only - Notion's search does not index block text. Omit `query` to list most-recently-edited. Empty results name their three causes rather than reading as "not there". Read-only (#830). |
| `notion_database_query` | Query a Notion database's data source in either workspace (`domain`: `work` / `angus`, required, no default) and get its rows with flattened property values. `filter` and `sorts` are Notion's own grammar passed through; `properties` narrows the columns; cursor-paginated up to 100 rows per call. The list-shaped read the dos ritual makes against the Tasks DB and both Meetings DBs, so it no longer needs a Notion connector in the session (#830). |
| `notion_page_get` | Read an ARBITRARY Notion page or block container in either workspace (`domain`: `work` / `angus`, required, no default): page properties plus every child block's id, type and plain text. Read-only (#625). |
| `notion_page_update` | Write to an ARBITRARY Notion page (`domain` required, no default): `op: 'append'` (blocks from markdown-ish lines, optionally after a sibling), `'update_block'` (replace one block's text in place), `'update_properties'` (raw Notion REST shapes). Refuses State Doc pages: `state_doc_update` stays their only writer. No delete op (#818). |
| `notion_page_create` | Create a page in either workspace (`domain` required, no default): a row in a database (`database_id` or `data_source_id` — the data source is resolved to its database, since the 2022-06-28 write pin takes `database_id`) or a child page under a page (`parent_page_id`). `title` is a plain string, written into whichever property the database declares as its title; `properties` are Notion's own REST shapes keyed by property name. Every property name and select/multi_select/status option is validated against the schema BEFORE the first write — Notion answers an unknown option by creating it and returning 200, so an unvalidated typo lands as a real row against a real-looking new option. Refuses State Doc pages as a parent, and either domain's Daily Log database as a target: that log has one writer, `daily_log_create` (#1017). Never retries on an unreadable response: the page exists (#1057). |
| `notion_database_get` | Read ANY database's schema in either workspace (`domain` required, no default) - property names, types, and the options of each select, multi_select and status - from a `database_id` or a `data_source_id`. The discovery half of `notion_page_create`, which refuses names and options the schema does not have. Read-only (#1057). |
| `notion_user_list` | List one workspace's people and bots with their ids (`domain` required, no default), for filling a person-typed property. Read these rather than reusing an id copied into a skill body: a stale id assigns real work to nobody and reports nothing when it does. Bots sort last. Read-only (#1057). |
| `meeting_create` | File a meeting in either workspace (`domain` required, no default): title, `start`/`end` as ISO datetimes, `type`, internal `attendees` (user ids or exact names, resolved through the workspace user list), `external` (existing contact ids, or objects resolved through `contact_create`'s dedup), Markdown `body`, `source_url`. Every convention is checked against the LIVE schema first — the destination's own `Type` options, the property playing each role — and a value the database has nowhere to put is an error, never a silent drop: Notion accepts a create and ignores properties it does not recognise, so dropping `attendees` would return a cheerful id for a meeting with nobody on it. Writes to `meetings_source_data_source_id` (work) / `meeting_notes_data_source_id` (angus); never to the private meetings source (#617). (#1059) |
| `contact_create` | Create a contact in either workspace (`domain` required, no default), or return the existing one. Deduplicates on email first, then exact name — never fuzzy, because merging two real people is worse than one duplicate and is not reversible by whoever notices. `contact_type` is validated against the destination's own options. `idempotentHint: true` and means it, which is what makes it safe for `meeting_create` to call per external attendee. Writes to `contacts_data_source_id` (work) / `people_data_source_id` (angus). (#1059) |

### Google Drive

Full read + write + manage over your Drive. These require the Google OAuth env
vars below; the knowledge-store tools work without them.

Every tool takes an optional **`domain`** (`angus` | `work`, default
`angus`) selecting which Google account to act as (#338, #1062). Omitting it behaves
exactly as before the account dimension existed.

Google Docs and Sheets are read through the **Docs API and Sheets API with all tabs included**,
not through Drive's export. Drive's export renders the default tab only and drops the rest with
no error, which silently truncates tabbed documents (such as Gemini meeting notes where
summary and transcript are separate tabs) and multi-tab spreadsheets (Drive export returns only
the first tab as CSV). This applies to `drive_read_file`, `ingest_drive` and `drive_import_file`
alike, since the behaviour lives in `downloadFileBytes`.

| Tool | Purpose |
|---|---|
| `drive_list` | List files, optionally within a folder (`folder_id: "root"` for My Drive top level). |
| `drive_search` | Search by file name + full-text content, optional MIME-type filter. |
| `drive_get_metadata` | Metadata for one file (type, size, parents, link, sharing). |
| `drive_read_file` | Read a file's content inline as text (Google Docs/Sheets export to Markdown). |
| `drive_create_folder` | Create a folder, optionally inside a parent. |
| `drive_upload_file` | Upload a new file from inline text or a local file path. `convert_to: "google_doc"` turns HTML, Markdown, plain text or `.docx` into an editable Google Doc. |
| `drive_export` | Export a Google Doc to PDF or DOCX as a new file beside it (or in `parent_id`) and return its link; the source is only read. See [`drive_export.md`](../../docs/guides/tools/drive_export.md). |
| `drive_rename` | Rename a file or folder. |
| `drive_move` | Move a file/folder into a different parent folder. |
| `drive_copy` | Copy a file, optionally renamed/relocated. |
| `drive_trash` | Move to Trash (reversible); `restore: true` to bring back. |
| `drive_delete` | **Permanent** delete (bypasses Trash); parks at the owner approval gate. |
| `drive_list_permissions` | List sharing permissions on a file/folder. |
| `drive_share` | Grant a role to a user/group/domain/anyone-with-link. |
| `drive_unshare` | Revoke a permission by id. |
| `ingest_drive` | **Bridge to KMS** - download/export a Drive file to Storage + create an artifact, preserving Drive provenance for later routing. |
| `drive_import_file` | **Bridge to KMS** - download/export a Drive file to Storage + create an artifact, so it flows into `knowledge_search`/`artifact_extract_text`. |

### Google Sheets

`domain` (`angus` | `work`) is required with no default (ADR-054 §9). Uses the same Google OAuth credentials as Drive, and requires the **Google Sheets API** enabled on the project behind `GOOGLE_CLIENT_ID` (see Google account setup step 1 below).

| Tool | Purpose |
|---|---|
| `sheets_read` | List a spreadsheet's tabs with their grid sizes (hidden tabs flagged), or read up to 20 A1 `ranges` bounded by `max_cells` with explicit `truncated` and `next_range` continuation. |
| `sheets_write` | Write cell values to a spreadsheet (`mode`: `update` \| `append` \| `clear`, `RAW` by default), returning range and cell-count receipts without values. |

### Gmail

Read and organise a mailbox. Same optional `domain` argument as the Drive tools,
so `domain: "work"` reaches the work.example.com mailbox.

| Tool | Purpose |
|---|---|
| `gmail_search` | Search with Gmail's own query syntax (`from:`, `subject:`, `newer_than:`, `label:`, `is:unread`). |
| `gmail_read` | Read one message, or a whole thread, in full: headers, decoded body, attachment list. |
| `gmail_labels` | List labels with their ids, or idempotently create one (`action: "ensure"`). |
| `gmail_modify` | Add/remove labels, mark read or unread, archive or un-archive. |
| `ingest_meeting_notes_detect` | Find meeting-note emails by the configured sender/subject rules and report the meeting title and Google Doc links found. Read-only. |

**There is no send tool and no delete tool.** `gmail.modify` grants both at the API
level, so the boundary is enforced by the tool surface rather than by the scope —
`src/google/gmail.ts` exports no helper either one could be built on. Sending stays a
per-message human action.

`ingest_meeting_notes_detect` reads its rules from `user_preferences.meeting_note_sources`
when that key is present, and otherwise from the shipped defaults in
`src/meetingNoteEmails.ts` (Google Meet / Gemini only, until other note-takers'
real patterns have been observed). Rules are data — adding a source is a config
edit, not a new code branch.

### Google Apps Script

Inspect, manage, version, deploy, and execute Google Apps Script projects directly.
Same optional `domain` argument (`angus` | `work`, default `angus`) selecting which Google account to act as.

| Tool | Purpose |
|---|---|
| `appsscript_list_projects` | List Apps Script projects from Google Drive, optionally filtered by title substring or folder id. |
| `appsscript_get_project` | Get metadata for an Apps Script project by its script ID. |
| `appsscript_create_project` | Create a new project (standalone or container-bound to a Sheet/Doc). |
| `appsscript_get_content` | Retrieve source files (`.gs`, `.html`, `appsscript.json`) from a project, or a specific file. |
| `appsscript_update_content` | Update project files (merges incoming files by default, preserving manifest). |
| `appsscript_create_version` | Create an immutable version snapshot. |
| `appsscript_list_versions` | List version snapshots of a project. |
| `appsscript_list_deployments` | List deployments (web apps, add-ons, API executables). |
| `appsscript_create_deployment` | Create a new deployment for a specific version. |
| `appsscript_run_function` | Execute a function in an Apps Script project via the Google Apps Script Execution API. |

### PostHog

Read analytics from **one connection at a time**. Each connection is a separate
PostHog project with its own credential, region and test-account contract
(ADR-060), so `posthog_query` takes exactly one and there is deliberately no
cross-connection tool: summing a house-filtered user count with an unfiltered
pageview count produces a number that means nothing.

| Tool | Purpose |
|---|---|
| `posthog_connections` | List configured connections with project id, region and filter policy. |
| `posthog_project_filter` | Read a project's own "filter out internal and test users" setting, live from PostHog. |
| `posthog_query` | Run one read query and return rows stamped with connection, project, region, policy and pull time. |
| `posthog_write` | One authenticated write (POST/PATCH/PUT/DELETE on an `/api/` path). Separate write credential, per-connection opt-in, project-scope check, and an explicit acknowledgement for deletes and for history-restating edits. |

**Filter policy is three-state**, and the third state is the point:

| Policy | Meaning |
|---|---|
| `required` | The project has a test-account filter and every read must apply it. |
| `not_applicable` | The project genuinely has none, and says so deliberately. |
| *(absent)* | **Undeclared.** Nobody has decided, and reads are refused. |

A portfolio site with no internal traffic is `not_applicable`. A freshly added
project nobody has written a policy for is undeclared, and rendering its numbers
as though they were clean is the failure #742 exists to prevent. A boolean cannot
hold that difference.

Under `required`, a HogQL query must carry **both** the `{filters}` placeholder in
its SQL and `filters: { filterTestAccounts: true }`. The guard **refuses** rather
than injecting them, because rewriting a caller's SQL so it returns a different
number is the same class of bug. Structured query kinds set `filterTestAccounts`
directly instead.

The contract stores **policy, not the filter's clauses**. Project 110015's six
clauses live in PostHog and are applied by PostHog; `posthog_project_filter` reads
them live. A copy here would be a second record of one fact, drifting silently the
moment someone edits the setting in the UI.

Every response leads with its stamp before any figure, because a number gets quoted
a long way from where it was fetched.

### Dex CRM

Two tools in front of 38 (#1063): contacts, notes, reminders, tags, groups and custom
fields, proxied to Dex's hosted MCP endpoint. Needs `DEX_API_KEY` to call, not to list.

| Tool | Purpose |
|---|---|
| `dex_list_tools` | The Dex tool catalog: each tool's name, description, annotations and JSON-schema input, generated from its zod input in `src/tools/dex/*`. Local, never calls Dex. |
| `dex_call_tool` | `{ tool, args }` — run one of them by exact name. `args` are validated against that tool's schema first, so a bad field comes back named and nothing reaches Dex. Can reach the irreversible `dex_delete_*` / `dex_merge_contacts`. |

For example, what used to be `dex_search_contacts({ query: "ada" })` is now
`dex_call_tool({ tool: "dex_search_contacts", args: { query: "ada" } })`.


## Setup

1. **Env**: copy `.env.example` to `.env` and fill in `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, and `KMS_USER_ID` (your `auth.users` uuid).
   The `KMS_STORAGE_BUCKET` (default `inputs`) must already exist.
2. **Install** (from repo root): `npm install`
3. **Retrieval migration (recommended)**: apply
   `supabase/migrations/20260527120000_044_add_artifacts_fts_search.sql` to enable
   real full-text search. Without it the tool still works via substring fallback.

### Google account setup (optional, for the `drive_*`, calendar and Gmail tools)

1. In **Google Cloud Console** → *APIs & Services*: enable the **Google Drive API**,
   the **Google Calendar API**, the **Gmail API**, the **Google Docs API** and the
   **Google Sheets API**.
   The Docs and Sheets APIs are easy to miss because they need no scope of their own (they accept
   the Drive scope) — a disabled Docs or Sheets API fails as `SERVICE_DISABLED` on every Google Doc
   or Sheet read, long after consent has succeeded. A scope whose API is disabled
   fails at consent time rather than at call time, which is a confusing place to
   discover it.
   The project's **OAuth client ID** is of type **Web application**, so register the
   loopback redirect the helper listens on (default
   `http://localhost:53682/oauth2callback`) under *Authorized redirect URIs* -- a
   mismatch fails with `redirect_uri_mismatch` (#508).
   Under *APIs & Services -> OAuth consent screen*, ensure **Publishing status** is set
   to **In production** (if left in **Testing**, Google revokes issued refresh tokens
   after 7 days with `invalid_grant`, #2052).
2. Put the client id/secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. **Mint a refresh token once per Google account** (opens a browser consent flow,
   prints the token). The credential is per ACCOUNT, not per service: one token covers
   Drive, Calendar and Gmail for whichever account consented (#338).
   ```bash
   npm --workspace @ahkms/mcp-server run google-auth -- --account personal
   npm --workspace @ahkms/mcp-server run google-auth -- --account work
   ```
   Paste each printed line into `.env` (`GOOGLE_REFRESH_TOKEN_PERSONAL` for personal,
   `GOOGLE_REFRESH_TOKEN_WORK` for Work).

   **Sign in as the right user on the consent screen.** The `--account` flag only
   decides which env var name is printed; which mailbox and Drive the token can reach
   is decided by whoever you approved as. Approving as the wrong account produces a
   token that works, against the wrong data.

   A Workspace account (`@work.example.com`) may additionally need the OAuth client added as
   an allowed app by a Workspace admin, depending on the domain's app-access policy.
4. **Verify** (read-only, mutates nothing):
   ```bash
   npm --workspace @ahkms/mcp-server run drive-smoke
   ```

Every scope is requested in a single consent per account, listed in
`src/google/scopes.ts` (full Drive, Calendar events, Gmail read and Gmail modify).
That bundling is deliberate: a Google refresh token is scope-bound at mint time, so
re-running the consent for one more scope **replaces** the previous token instead of
adding to it (ADR-045). Adding a scope therefore costs a re-mint of every account.

Gmail scope note: Google has no "drafts but never send" scope, so `gmail.modify` is
the narrowest grant that supports drafting and labelling. No send tool is exposed, and
that is where the restriction is enforced (see `outwardWrite.ts`).

Revoke any time at <https://myaccount.google.com/permissions>.

### PostHog connection setup (ADR-060)

PostHog is **many connections, not one account**. Each is a `user_integrations` row with
`provider = "posthog:<slug>"`, and each resolves its own key from
`POSTHOG_API_KEY_<SLUG>`. Adding one is an env var plus a row, never a code change.

This is deliberately unlike the Google `account` enum above. A Google account needs an
OAuth consent ceremony, so its two-value union records a real constraint; a PostHog
project is an integer, and putting that list behind a deploy would encode the wrong
thing.

1. Mint a personal API key at PostHog > personal settings > Personal API keys. Scope it
   to `project:read` plus query read and nothing else. Unlike Gmail, the read-only
   boundary here can be enforced at the token, so it should be.
2. Set `POSTHOG_API_KEY_<SLUG>` (see `.env.example`).
3. Prove it before building anything on it:

```bash
npm --workspace @ahkms/mcp-server run posthog-smoke -- --connection work
```

The smoke script auto-detects the region, prints which account and organisation the key
belongs to, enumerates the projects it can actually reach, and prints the project's own
"filter out internal and test users" setting verbatim. That last one is the source of
truth for the test-account contract (#742) and it lives in PostHog, not in this repo.

**Region is per-connection.** A key minted in EU cloud returns 401 against the US host,
which reads as a bad key rather than a wrong region. The script tries both and names the
winner.

**The `{filters}` placeholder is the enforcement hook.** A raw HogQL query silently
ignores the project's test-account filter; the same query with `and {filters}` plus
`filters: { filterTestAccounts: true }` applies it, including the person-level cohort
legs that cannot be expressed in HogQL directly. Measured on project 110015, the two
differ by roughly 18% of 7-day event volume. Any raw-query surface must therefore
**refuse** a query without the placeholder rather than silently rewrite it.

Routing-safe ingestion uses `user_preferences.safe_mode` and the artifact audit
columns added by migration 052. Update the preference with `config_preferences_update`
and record routing decisions with `artifact_update`.

## Run

```bash
# from repo root
npm --workspace @ahkms/mcp-server start
```

The script layers the repo-root `.env` under the package one
(`--env-file-if-exists=../../.env --env-file=.env`, resolved from inside the
package) — see [`.env.example`](.env.example) for why the precedence is
package-over-root (#711). Run the script rather than a hand-rolled `node`
invocation, so there is one place the flags are written down.

The server speaks JSON-RPC over **stdio** (logs go to stderr).

## Remote serving surface — HTTP + OAuth (issue #84 / ADR-019 follow-up #1)

The same tool set is also served over **MCP Streamable HTTP** behind a self-hosted
**OAuth 2.1** gate, so the knowledge store is reachable from **any environment**
(claude.ai web/mobile, Cursor, another machine) — not just a local stdio subprocess. The
stdio path above is unchanged and stays the interim local-dev mechanism.

### How it's built

| Concern | Implementation |
|---|---|
| Transport | `StreamableHTTPServerTransport`, one session per `Mcp-Session-Id` (`src/http.ts`). |
| Tool set | Shared with stdio via `createServer()` (`src/server.ts`) — zero drift between surfaces. |
| Auth | Self-hosted OAuth 2.1 Authorization Server **inside** the MCP server (`src/auth/`), per the MCP authorization spec. Discovery + DCR + token + revoke come from the SDK's `mcpAuthRouter`; the owner login/consent screen and token logic are `OwnerOAuthProvider`. **Not** a platform/proxy auth layer (ADR-019). |
| Login gate | One shared **owner password** (`MCP_OWNER_PASSWORD`) entered on the consent screen. Correct password ⇒ an authorization code is minted. |
| Tokens | Stateless HS256 JWTs (`jose`) signed with `MCP_OAUTH_JWT_SECRET`. No token store; they survive restarts and expire on their own. |
| Clients | DCR registrations persisted in Supabase (`mcp_oauth_clients`, migration 053) so a paired client survives a redeploy. |
| Secrets | The Supabase **service-role key never leaves the server**. Clients only ever hold an OAuth bearer token. |

### Env vars (HTTP only — stdio ignores these)

| Var | Required | Notes |
|---|---|---|
| `MCP_PUBLIC_URL` | ✅ | The server's exact public HTTPS origin, no trailing slash (e.g. `https://your-app.up.railway.app`). Used as OAuth issuer + resource id. |
| `MCP_OWNER_PASSWORD` | ✅ | The consent-screen password. The credential that keeps the endpoint private. |
| `MCP_OAUTH_JWT_SECRET` | ✅ | HMAC secret for signing tokens. `openssl rand -hex 32`. Rotating it forces re-auth. |
| `PORT` | host-set | Railway injects it; defaults to `8080` locally. |
| `WEB_ORIGIN` | optional | Exact web origin(s), comma-separated, no trailing slash; production refuses localhost. Governs CORS for `/api/actions`. |
| `MCP_ACCESS_TOKEN_TTL` / `MCP_REFRESH_TOKEN_TTL` | optional | Seconds. Default 30d / 30d (`2592000`). |

The knowledge-store env (`SUPABASE_*`, `KMS_USER_ID`, and optional `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `NOTION_WORK_ACCESS_TOKEN`, `GOOGLE_*`) is still required server-side —
same as stdio.

### Run it locally

```bash
# fill packages/mcp-server/.env (see .env.example, incl. the MCP_* vars)
npm --workspace @ahkms/mcp-server run start:http
# MCP endpoint: http://localhost:8080/mcp ; health: http://localhost:8080/healthz
```

Verify the unauthenticated contract (health, OAuth discovery metadata, and that an
un-tokened `/mcp` call is rejected `401`) without a browser:

```bash
npm --workspace @ahkms/mcp-server run smoke:http
```

### Deploy to Railway (the hosting decision on issue #84)

Hosted as a **second Railway service in the same project as the worker** — always-on,
TLS on `*.up.railway.app`, and the Supabase service-role key already lives in that trust
boundary. Runbook (one-time):

1. **New service** → *Deploy from the same repo*.
2. Settings → **Root Directory** = repo root; **Dockerfile Path** =
   `packages/mcp-server/Dockerfile`.
3. **Variables**: set the knowledge-store env (copy from the worker where shared:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `KMS_USER_ID`, `ANTHROPIC_API_KEY`, …) plus
   the three required `MCP_*` vars. Leave `PORT` unset (Railway injects it).
4. **Generate a public domain**, then set `MCP_PUBLIC_URL` to exactly that `https://…` URL
   (no trailing slash) and redeploy.
5. Apply **migration 053** to the Supabase project (`mcp_oauth_clients`).
6. Confirm `https://<domain>/healthz` returns `{ "ok": true }`.

### Register it in a client (claude.ai web/mobile, Cursor)

Add a **custom MCP / connector** pointing at `https://<domain>/mcp`. The client shows
**"Needs authentication"**, opens the consent screen, you enter `MCP_OWNER_PASSWORD`, and
it completes the OAuth handshake (DCR → authorize → token) automatically. `capture` /
`knowledge_search` / `artifact_extract_text` then work over HTTP exactly as over stdio.

## Smoke test (end-to-end)

After filling `.env` and applying migration 044, validate the whole loop in one shot:

```bash
npm --workspace @ahkms/mcp-server run smoke
```

Runs `capture → search → artifact_get → (optional) artifact_extract_text` against your real
Supabase, then cleans up. Exits non-zero on failure.

## User-specific capture context (persisted, not in the skill)

The shareable capture skill (`.claude/skills/capture/`) is deliberately free of any one
user's tags/taxonomy. Per-user behaviour — **default tags**, **default source channel**,
and **tag routing maps** (regex rules that auto-apply tags / set a channel) — is persisted
in `user_preferences.capture_preferences` (JSONB) and applied by the `capture` tool at
runtime. This is what lets the skill be public while the context follows the user.

- Config lives in the DB, not a bundled file (ADR-030): capture preferences are stored in `user_preferences.capture_preferences` (Supabase) — see the `*_capture_preferences*` migrations.
- Schema/contract: `supabase/migrations/20260606120000_045_extend_capture_preferences_maps.sql`
- Inspect the active config: call `config_capture_get`.

Apply migration 045 to enable the maps. Without it (or with no preferences row), capture
falls back to its prior behaviour: caller-supplied tags only, `mcp` channel.

## External integrations (per-user wiring, persisted not hard-coded)

The system is opinionated and shared; what's per-user is the **wiring** that points it
at *your* instances of rented services — e.g. your Notion tasks database ("Work").
That split is deliberate so the skills stay public:

- **Non-secret pointers** (database ids, property names, connector/workspace routing)
  → `user_integrations` table (provider `notion`, `config.tasks_database_id`,
  `config.notion_connector`, `config.notion_workspace`, …). See migration 046 and
  `.claude/skills/create-task/references/notion-integration.example.json`.
- **Secret token** (`NOTION_WORK_ACCESS_TOKEN`) → environment only. Never the DB or a
  skill. It's a Notion **internal integration secret** (Bearer token) for the
  work/"Work" workspace — every currently-shipped Notion call uses it.
  `NOTION_API_KEY` remains supported as a backward-compat fallback name for the same
  token. A separate `NOTION_PERSONAL_ACCESS_TOKEN` carries the personal workspace and is
  now live: every `domain`-taking tool (`notion_search`, `notion_page_get`,
  `notion_page_update`, `task_create`, `state_doc_update`) resolves it through
  `getCredential('notion_personal')` when `domain: 'angus'` is selected (#424, ADR-045).
- Inspect what's configured with `integration_list` (ids are not echoed).

To enable `task_create`: apply migration 046, set `NOTION_WORK_ACCESS_TOKEN`, and
upsert a `notion` row into `user_integrations` with your tasks database id (the example
file has a ready-to-edit `insert … on conflict` snippet). The integration must be
**shared** with each target database/page (Notion → ••• → Connections) — an
otherwise-valid token still gets 404s from pages it hasn't been shared with.

## SOD/EOD state document (ADR-013 §3/§7, ADR-020 §B1)

The start/end-of-day state document is a **projection** kept in Notion, written by the
`dos` synthesis skill (homed in-repo per ADR-018 §7; one ritual for both domains, ADR-054 §7).

Per **ADR-020 §B1**, the *reading* and *consumption-marking* of that projection use the
**generic** surface (PR #59), not bespoke tools — scope is the caller's job:

- "what's not folded in yet" → `knowledge_search(not_consumed=true, domain=…, content_subtype=…)`
- "mark it folded in" → `external_link_create(kind='synthesized', run_id=…)`
- "which logs has the State Doc not absorbed yet" → `dos_daily_log_queue(domain=…)`, the
  second consumption hop (ADR-051 §10): atoms are consumed by the day's Daily Log, and the
  Daily Log is consumed by the State Doc. The queue is every Daily Log twin (#562) with no
  hop-2 row, oldest first, each saying whether it is a swept draft (#561) the owner has not
  confirmed. Catch-up is only ever over these logs, never over atoms.
- "mark a log folded into the State Doc" → `external_link_create(kind='consumed_by_state')`
  on the **twin**, `external_id` the State Doc page. The tool refuses that kind on an atom,
  and refuses a synthesis marker on a twin: no marker can be deleted, so a wrong one would
  be permanent.

`domain` is part of "scope is the caller's job". Markers carry the `provider` of the
domain that wrote them, so a domain-scoped ritual passes its own `domain` on every
consumption read (`knowledge_search(not_consumed)`, `dos_synthesis_coverage`) or it
treats the other domain's synthesis as its own: an atom folded into the `angus` Daily
Log would never be offered to `work`, and a day closed in one domain would read as
covered for both (#677, ADR-051 §11). Omitting it applies no provider predicate at all
and pools every domain — the cross-domain audit view, and the behaviour every caller had
before the second domain gained a Daily Log to write to (#674).

What stays here is the two pieces with no generic replacement — *writing* the Notion
pages:

- `daily_log_create` - create ONE Daily Log entry for a `(domain, date)`. The
  destination's title and date properties are discovered by introspection and any
  further `properties` are validated against that same read, because the two domains'
  Daily Logs genuinely differ and hardcoding either schema into a two-domain tool is
  what ADR-054 §6 forbids. Values are real Notion REST property objects, not the
  claude.ai connector's `__YES__` / `date:Date:start` conventions. A second entry for
  a date that already has one is refused with the existing page id unless
  `allow_duplicate` (#673). It returns the `provider` it authenticated as, so the
  caller's `external_link_create` marker cannot be stamped under a provider that
  makes it unfindable. Requires `daily_log_database_id` in that domain's config;
  `daily_log_data_source_id` is what the duplicate guard needs.
- `state_doc_update` - edit ONE section of a state page: `op: 'replace'` (rewrite a
  section's body), `'rename'` (its heading, and optionally its body), `'insert'` (a new
  section at an explicit anchor) or `'delete'`. `op` is required; the append-only
  contract is gone (ADR-053).

`domain` is required too, and selects which State Doc: `'work'` reads the
`notion_work` row and authenticates with `NOTION_WORK_ACCESS_TOKEN`, `'angus'` reads
`notion_personal` and authenticates with `NOTION_PERSONAL_ACCESS_TOKEN` (ADR-054 §9;
ADR-054 §3 renames that provider `notion_angus`, which has not happened yet). No
default, on the same reasoning as `op`: this tool is served to other surfaces
(ADR-019/031), so a silently-defaulted destination is one that will one day be wrong.
Selecting `angus` before its `state_doc_page_id` is set fails with the exact
`integration_set` call needed - plus the manual step Notion has no API for:
connecting the page and its parent to the ahKMS integration (⋯ → Connections), without
which every configured pointer 404s.

Two rules that are not negotiable, both from ADR-053. Sections are addressed by **exact
heading text** — zero matches or more than one is an error, never a guess. And a section
is a **flat span**, running from its heading to the next heading of *any* level: the
conventional same-or-higher rule would be destructive on this page, which carries a
single stray `#` among its `##`s. The tool stamps `Last updated` itself on every
successful mutation, rewriting only that line of the header callout through the block
API — `Sole writer` and `Read by` beside it are human-authored and stay untouched. The
page is never written through Notion's page content-update path, whose block
re-serialisation is what ADR-053 exists to route around.

Setup: add `state_doc_page_id` to your `user_integrations` `notion` config (the page must
be shared with your integration), and in multi-connector sessions also set
`notion_connector` / `notion_workspace` so `dos` targets the right Notion
workspace. Then set `NOTION_WORK_ACCESS_TOKEN` (`NOTION_API_KEY` still works as a
fallback). (`links.ts`'s `getSynthesizedArtifactIds` remains as plumbing the
synthesis loop / generic surface can reuse; `notion.ts`'s `queryNotionDatabase` was
dead code and was removed — see issue #424 defect 3.)

## Cross-store lineage (ADR-013 §5)

Knowledge lives in Supabase; tasks/state live in Notion. The link between them is stored,
not joined: pass `artifact_id` to `task_create` and the Notion page is recorded in
`artifact_external_links` (migration 047). `artifact_get` then shows a **Derived:** line,
so *"what tasks came out of that meeting?"* is answerable from the memory side without
querying Notion. `capture` also accepts `content_subtype` (e.g. `transcript`) to scope
what later feeds the SOD/EOD state doc. The same table carries the `synthesized`
marker (ADR-013 §7). All best-effort: without migration 047 the link is skipped, never
failing the task.

## Claude Desktop config

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ahkms-knowledge": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABSOLUTE/PATH/knowledgeMgmtSystemOct2025/packages/mcp-server/src/index.ts"],
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "...",
        "KMS_USER_ID": "...",
        "KMS_STORAGE_BUCKET": "user-uploads",
        "GOOGLE_CLIENT_ID": "...apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "...",
        "GOOGLE_REFRESH_TOKEN_PERSONAL": "...",
        "GOOGLE_REFRESH_TOKEN_WORK": "..."
      }
    }
  }
}
```

The `GOOGLE_*` vars are optional — omit them and only the knowledge-store
tools register usefully; the `drive_*` tools return a clear setup error if called
without credentials.

## Scope notes (Phase 0)

- Single-user, **service-role** access (bypasses RLS). Fine for a personal trial;
  revisit before any multi-user use.
- `capture` handles **text notes** today. To dump a PDF/image, upload it to the
  `inputs` bucket (e.g. via the existing app) and call `artifact_extract_text` with the
  artifact id; full file-upload-via-MCP capture is the next increment.
- `artifact_extract_text` does a single Claude call (default `claude-opus-4-7`, override via
  `KMS_EXTRACT_MODEL`). `max_tokens` is 16000 - very long documents may truncate.
- Entity / task / event tools are Phase 1 (see the scope doc).
- **Google auth is single-user OAuth, per account**: one refresh token per Google
  account (`personal`, `work`), each carrying the full scope bundle in
  `src/google/scopes.ts`. `drive_delete` is permanent and gated behind the owner approval gate;
  prefer `drive_trash` (reversible). `ingest_drive` writes into the same Supabase
  bucket as `capture`, so imported files are found by `artifact_extract_text`'s bucket sweep.
