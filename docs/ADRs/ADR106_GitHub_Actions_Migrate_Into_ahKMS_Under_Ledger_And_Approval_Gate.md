# ADR106: GitHub actions migrate into ahOS under the ledger and the approval gate

- **Status:** Accepted
- **Created:** 2026-10-12
- **Accepted-on-dev:** 2026-10-12
- **Deciders:** Angus Hally (solo maintainer)
- **Amends:** [ADR-081](./ADR081_A_Connector_Migrates_Into_ahKMS_When_One_Connection_Cannot_Serve_Two_Accounts.md) (the GitHub row and its reasoning)

## Context and problem

In the 11 October 2026 tool copy review, the owner approved bringing 25 GitHub capabilities (reads, issue comments and labels, pull request mutations, and merge conflict inspection) into ahOS natively.

Previously, [ADR-081](./ADR081_A_Connector_Migrates_Into_ahKMS_When_One_Connection_Cannot_Serve_Two_Accounts.md) evaluated GitHub as a connector rather than an ahOS-hosted tool family:
1. The **multi-account test** passed for the connector: a single GitHub user identity spans both personal (`anguspersonal/*`) and Work repositories without account-switching.
2. The **atom-production test** pointed away from migration: operating a repository does not produce knowledge store atoms, so maintenance costs of hand-rolling an API client argued against hosting GitHub operations inside ahKMS.

However, subsequent architectural foundations — in particular the append-only action ledger ([ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)), the external approval gate (ADR-104), and the Centralised Action Registry ([ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)) — fundamentally altered the cost-benefit balance. When an agent acts on GitHub via a third-party connector or shell `gh` invocations, the call bypasses the ledger, escapes the approval gate, and cannot be invoked from non-Claude environments (such as scheduled worker engine jobs or the web co-editing workspace). Furthermore, `github_issue_create` had already crossed this boundary into core actions (`packages/core/src/actions/github/issueCreate.ts`), creating an unratified discrepancy with ADR-081's connector table.

## Decision drivers

1. **One ledger ([ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)).** Every action call in ahOS, reads included, is recorded to `public.action_ledger`. A GitHub call executed via a third-party connector or shell CLI bypasses the ledger entirely, creating an unmonitored blind spot in the owner's audit log precisely where autonomous agents mutate backlog and code.
2. **One approval gate ([ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)).** High-consequence outward mutations must park in `system_decisions` until approved by the owner. While outward messages such as `slack_post` park for confirmation, agent-authored public PR comments, PR creations, or branch deletions through a connector do not. The approval gate only operates if calls flow through `executeAction`.
3. **One registry ([ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)).** Defining actions within `@ahkms/core` allows a single typed definition to serve stdio MCP, Remote HTTP `/api/actions`, the web agent, and background engine cadences. A vendor connector serves only claude.ai chat sessions; background engine jobs and the authenticated web app cannot access it.
4. **Preservation of ADR-081 principles.** The multi-account rule remains authoritative for all other connectors (Gmail, Calendar, Notion, PostHog). The ingest credential boundary ([ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md), ADR-081) remains strictly read-only (`GITHUB_TOKEN_INGEST`) with no fallback to mutating tokens.
5. **Controlled blast radius.** Operations must be restricted to explicitly authorized repositories via fail-closed allowlists, and maintenance overhead is mitigated by wrapping `@octokit/rest` rather than authoring custom HTTP clients.

## Considered options

### Option A: Keep ADR-081 as written (GitHub stays strictly a connector)

- **Pros:** Zero new code or token maintenance in ahOS; vendor MCP server tracks upstream API evolution.
- **Cons:** Bypasses the action ledger; mutating PR and comment actions escape the approval gate; non-Claude surfaces (worker engine, web UI) remain unable to interact with GitHub.

### Option B: Read operations in ahOS, write operations through the connector

- **Pros:** Read calls enter the action ledger; no write tokens needed in ahOS.
- **Cons:** Fails driver 2 completely: outward mutations (comments, PRs, branch deletions) are precisely the operations that demand owner approval. Splitting reads and writes across two separate systems creates confusion and partial coverage.

### Option C: Migrate GitHub actions into ahOS under the ledger, approval gate, and fail-closed allowlists

- **Pros:** Complete auditability on `action_ledger`; outward mutations safely held behind owner approval; all ahOS surfaces (MCP, web, worker) can execute GitHub operations; fail-closed repository allowlists prevent accidental out-of-scope modifications.
- **Cons:** ahOS maintains wrappers around `@octokit/rest` for the exposed operations; the owner manages one additional scoped token (`GITHUB_TOKEN_PULLS`).

## Decision

We chose **Option C**.

GitHub actions migrate into `@ahkms/core` as first-class actions served through the Centralised Action Registry, recorded to the `action_ledger`, and gated by the ADR-104 approval mechanism.

The following specific design points govern the implementation:

1. **Three discrete credentials with zero fallback:**
   - **Reads (`github`):** Resolves `GITHUB_TOKEN_INGEST` ([ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md), ADR-081). Widened to read repository contents and Actions workflow runs/logs, but remains strictly read-only. A read path can never write.
   - **Issues and Comments (`github_issues`):** Resolves `GITHUB_TOKEN_ISSUES`. Widened from issue creation to issue/PR comments and label management.
   - **Pull Requests (`github_pulls`):** Resolves a new fine-grained token `GITHUB_TOKEN_PULLS`, scoped strictly to `pull_requests:write` and `contents:write` on authorized PR repositories only.
   - There is strictly no fallback between these credentials. If a token lacks permission, the action fails rather than escalating credentials.

2. **Fail-closed repository allowlists:**
   - Reach is governed by explicit configuration in `user_integrations` (provider `github`): `read_repos`, `issue_repos` (extending `packages/core/src/actions/github/issueCreate.ts`), and `pr_repos`.
   - Each entry is formatted as `owner/name` or `owner/*`.
   - Actions validate the target repository against the corresponding allowlist and fail closed before executing any network request. Nothing is reachable by default.

3. **Approval gate enforcement ([ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)):**
   - Outward mutating actions — including PR creation, PR update, PR review, branch deletion, and issue/PR comments and label modifications — declare `needsApproval: true`. When called by an agent, execution pauses in `system_decisions` until approved by the owner.
   - Read actions and issue creation (`github_issue_create`) do not require prior approval (`needsApproval: false`).

4. **Interactive workflow separation:**
   - Interactive development in Claude Code continues to use local `gh` and Git CLI.
   - Automated ahOS workflows that author issues or manage triage (e.g. `create-issue`, `/triage`, `/to-issues`) will migrate to the native ahOS actions in subsequent work packets.

5. **Complete system isolation from external platforms:**
   - ahOS acts exclusively as the owner using his own GitHub personal access tokens.
   - No code, service accounts, GitHub App credentials, or runtime calls are shared with external operational stacks (such as example-org/ops).

> **Erratum (2026-10-19, #1926).** The `github_issues` credential's canonical environment name is `GITHUB_PERSONAL_ACCESS_TOKEN`, the name the owner's Railway deployment uses; `GITHUB_TOKEN_ISSUES` and `GITHUB_ISSUES_TOKEN` stay accepted as legacy names and the doctor asks for them to be renamed. The rule in §1 is unchanged: whatever the name, this token carries issues:write only, and no GitHub credential falls back to another.

## Consequences

- **Good:** All GitHub operations invoked by agents are fully ledgered in `action_ledger` with input hashes and timestamps.
- **Good:** Outward-facing mutations (comments, PR modifications) cannot be published autonomously without explicit human approval.
- **Good:** Non-chat execution surfaces (web workspace, engine cadences) gain consistent, typed GitHub capabilities.
- **Good:** Strict repository allowlists enforce least-privilege access per operation tier.
- **Cost / bad:** ahOS maintains `@octokit/rest` endpoint wrappers and accepts the maintenance overhead of tracking GitHub API changes for wrapped endpoints.
- **Cost / bad:** The owner configures and maintains three distinct fine-grained GitHub tokens in the environment.
- **Follow-up:** Implementation of port work packets (#1640, #1641, #1642, #1643, #1644, #1467, #1479, #1507) implementing actions, ports, adapters, and schema credentials.
- **Follow-up:** Migration of triage skills (`create-issue`, `/triage`, `/to-issues`) from raw CLI/connector to the native ahOS action surface.

## Links

- Amends: [ADR-081](./ADR081_A_Connector_Migrates_Into_ahKMS_When_One_Connection_Cannot_Serve_Two_Accounts.md) (the GitHub row and reasoning)
- Related: [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md) (credential boundaries and environment segregation)
- Related: [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) (Unified Action Wrapper)
- Related: [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) (Core rulebook and engine architecture)
- Related: [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) (append-only action ledger and approval gate)
