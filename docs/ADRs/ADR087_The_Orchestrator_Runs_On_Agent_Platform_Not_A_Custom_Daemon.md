# ADR-087: The orchestrator runs on Agent Platform, not a custom daemon

- **Status:** Accepted
- **Created:** 2026-09-12
- **Accepted-on-dev:** 2026-09-14
- **Deciders:** Angus Hally

## Context and problem

During autonomous development workflows across Work repositories, multi-agent review
convergence failures (e.g. example-org/core#1097 cycling through 12 un-converged review rounds)
demonstrated the limits of stateless, ephemeral workers. An orchestrator / supervisor was
required to maintain cross-round state, enforce escalation limits, manage the human maintainer
merge queue, and delegate tasks to specialized worker jobs (`code-generator`, `qa-reviewer`,
and `triage-agent`).

The initial implementation stood up this supervisor as a bespoke Cloud Run Service
(`--min-instances 1`) running a FastAPI application with an autonomous 60-second `asyncio`
polling loop.

This introduced an architectural inconsistency with Work's runtime boundary
(`example-org/ops: docs/adr/2026-09-08-agent-runtime-follows-the-surface.md`):
containers on Cloud Run are strictly reserved for tasks requiring a working tree, git credentials,
and language toolchains (`pnpm`, `vitest`, `deno`). Orchestration and judgement agents do not
manipulate local file trees; they operate over APIs. Running a dedicated 24/7 container incurred
continuous idle compute, hand-rolled in-memory state tracking, and bypassed the native capabilities
of Vertex AI Agent Engine (Agent Platform).

## Decision drivers

- **Runtime follows the surface.** The architectural rule: *if a job does not need a git working
  tree or compiler toolchain, it belongs on Agent Platform.* The supervisor makes GitHub API and
  Cloud Run API calls; it never checks out a repo.
- **Persistent memory over ephemeral daemon memory.** The orchestrator must remember PR escalation
  counts, stalled leases, and historical review rounds across invocations. Vertex AI Memory Bank
  (`VertexAiMemoryBankService`) provides structured, long-term cross-session memory out of the box,
  unlike in-process Python dictionaries that vanish on container restarts.
- **Resource and cost discipline.** Paying for an idle Linux container on Cloud Run with
  `--min-instances 1` to execute `while True: sleep(60)` is wasteful when scheduled or event-driven
  serverless invocations can achieve the same orchestration at near-zero idle cost.
- **Unified agent governance.** Triage, Developer, and Reviewer already have Reasoning Engine wrappers
  (`AdkApp`) on Vertex AI. The supervisor functions as the conductor on the exact same platform.

## Considered options

### Option A: Retain the bespoke Cloud Run Service daemon

- **Pros:** Continuous internal 60-second polling loop; direct HTTP webhook listener.
- **Cons:** Bypasses Vertex Agent Engine; violates runtime-follows-surface rule; hand-rolls
  state tracking and locks; incurs 24/7 container billing.

### Option B: Ephemeral Cloud Run Job

- **Pros:** Serverless execution on Cloud Scheduler.
- **Cons:** Still requires custom container building; lacks managed Vertex Memory Bank and session
  telemetry without external database plumbing.

### Option C: Supervisor on Agent Platform (Vertex AI Reasoning Engine) (chosen)

- **Pros:** 100% aligned with ADR-2026-09-08; native long-term memory via `VertexAiMemoryBankService`;
  serverless execution; managed tracing in Google Cloud Console; zero container maintenance.
- **Cons:** Autonomous sweeps are driven by Cloud Scheduler or webhook forwarders rather than an
  in-process infinite sleep loop.

## Decision

We chose **Option C: Deploy the Supervisor to Agent Platform (Vertex AI Reasoning Engine)**.

1. Package and deploy `work-supervisor-agent` to Vertex AI Agent Engine using the Google ADK
   `AdkApp` wrapper and `VertexAiMemoryBankService`.
2. Trigger orchestration sweeps periodically via Cloud Scheduler calling the Reasoning Engine
   endpoint (or on GitHub webhook events).
3. Decommission the `supervisor-agent` Cloud Run Service (`--min-instances 1`) to eliminate
   redundant container infrastructure and ongoing idle billing.

## Consequences

- **Good:** Complete convergence on the Work multi-agent architecture. The supervisor
  leverages Vertex Memory Bank to track loop convergence and maintainer merge queue states
  without bespoke state persistence. No idle container costs.
- **Cost / bad:** Sweep frequency is determined by Cloud Scheduler intervals rather than
  an internal 60-second timer. Webhook events route through a lightweight invoker rather
  than hitting an in-process FastAPI endpoint directly.
- **Follow-up:**
  - Execute `python deploy/deploy_engines.py --agent supervisor` in `example-org/ops`.
  - Delete Cloud Run Service `supervisor-agent` in `work-ops`.
  - Update ops deployment workflows (`.github/workflows/deploy.yml`).

## Links

- Work Ops ADRs:
  - `example-org/ops: docs/adr/2026-09-08-agent-runtime-follows-the-surface.md` (An agent's runtime follows its surface)
  - `example-org/ops: docs/adr/2026-09-12-supervisor-agent-on-agent-platform.md` (The supervisor agent runs on Agent Platform)
