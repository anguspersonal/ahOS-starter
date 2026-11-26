# ADR029: Reject LangChain, LangSmith, and the Claude Agent SDK

- **Status:** Accepted
- **Date:** 2026-06-21
- **Accepted-on-dev:** 2026-06-21
- **Deciders:** Angus Hally

## Context and problem

As the MCP tool layer ([ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md)) matured,
the question arose whether to adopt LangChain (LLM orchestration framework),
LangSmith (LangChain's tracing/eval platform), or the Claude Agent SDK to
support this project's observability, evaluation, and runtime needs.

## Decision drivers

- The project is a **tooling layer**, not an agent. Intelligence is supplied by
  Claude Code (the user's subscription) calling MCP tools; this repo has no
  autonomous loop and makes no LLM calls of its own (except embedding generation,
  which is a direct API call, not an orchestrated chain).
- Invocation surfaces are limited: scheduled flows and the Claude Code CLI. There
  is no hosted agent runtime to manage.
- PostHog is already integrated and covers the observability need (tool call
  patterns, latency, errors) without a second vendor.
- Complexity budget: the codebase should stay small and directly owned.

## Considered options

### Option A — LangChain (framework)

- **Pros:** Rich abstractions for chains, memory, document loaders, vector stores.
- **Cons:** Solves LLM-orchestration problems this project doesn't have. The
  "chain" is Claude Code's reasoning loop, not ours. Adds a large dependency with
  abstractions that sit above what we actually do (direct Supabase + embedding
  calls).

### Option B — LangSmith (observability / eval)

- **Pros:** Purpose-built for LLM tracing and dataset-driven prompt evaluation;
  strong eval workflow.
- **Cons:** Designed for projects that own the LLM call — our LLM call is Claude
  Code's, invisible to us. What we want to observe is tool call patterns and data
  operations, which is structured analytics, not LLM tracing. PostHog already
  covers this and is already set up. Adds a paid vendor for the wrong abstraction.

### Option C — Claude Agent SDK

- **Pros:** First-class support for building Claude-powered agents; usage-based
  pricing aligned to autonomous agent workloads.
- **Cons:** Wrong pricing model (usage-based vs subscription) and wrong runtime
  model (hosted autonomous agent vs CLI + scheduled invocation). Adopting it would
  require rearchitecting the invocation surface for no benefit.

### Option D — None of the above (status quo)

- **Pros:** No new dependencies. Intelligence stays in Claude Code. Observability
  via PostHog. MCP tools stay as thin data-operation wrappers.
- **Cons:** Less eval tooling if we later want systematic prompt regression tests;
  would revisit if the project grows an autonomous loop.

## Decision

We chose **Option D**. This project is a set of tools and skills, not an agent.
The intelligence layer is the user's Claude Code subscription; the MCP server is
purely a data operations layer. None of the three frameworks address the actual
problems here — they address LLM orchestration, LLM tracing, and autonomous agent
runtimes respectively, none of which this project owns.

## Consequences

- **Good:** No framework dependency, no second observability vendor, no pricing
  model mismatch.
- **Cost / bad:** If a future capability requires an autonomous loop or systematic
  prompt evals, we will need to revisit. LangSmith in particular would become
  relevant if we ever run offline evaluation datasets against prompts we own.
- **Follow-up:** If [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md)
  leads to a hosted capability that makes its own LLM calls, reconsider LangSmith
  for that surface specifically.

## Links

- Related: [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md) — MCP tool layer design
- Related: [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) — future
  hosted capability surface (would be the trigger to revisit)
