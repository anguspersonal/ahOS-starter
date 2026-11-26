# ADR-097: Apex docs get their scoped pass against the ADR-079 to ADR-096 gap

- **Status:** Accepted
- **Created:** 2026-09-28
- **Accepted-on-dev:** 2026-10-02
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, architecture, vision, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (apex doc freshness mechanisms),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (a bump requires evidence; understating self-corrects),
  [ADR-074](./ADR074_Vision_Gets_Its_Second_Scoped_Pass_And_Two_Register_Entries_Do_Not_Survive_It.md) (vision's second pass),
  [ADR-076](./ADR076_Architecture_Gets_Its_Third_Scoped_Pass_And_Corrects_A_Claim_About_Its_Own_Instrument.md) (architecture's third pass),
  [ADR-077](./ADR077_The_Apex_Pair_Owes_A_Reader_Most_Design_Answers.md) / [ADR-078](./ADR078_The_First_Apex_Sufficiency_Baseline_Is_45_Percent_And_The_Target_Stands.md) (apex sufficiency)
- **Issue:** #1076

## Context and problem

Both apex documents tripped their freshness thresholds under `check-apex-watermark.js` (ADR-056 mechanism 2, ADR-059):

```
BEHIND  docs/vision.md — is 14 ADR(s) behind, the oldest unreviewed landing 16 day(s) ago
          in the gap: ADR-082 .. ADR-096
BEHIND  docs/architecture/architecture.md — is 17 ADR(s) behind, the oldest unreviewed landing 29 day(s) ago
          in the gap: ADR-079 .. ADR-096
```

Issue #1076 tracked this drift. On 2026-09-26, the owner triaged the issue as `status:agent-ready` with explicit mandate:
*"An agent reviews ADR-079 to ADR-096 against vision.md and architecture.md, then bumps the watermarks."*

The gap opened across a period of substantial architectural consolidation:
1. Retiring `packages/web` and deleting its public Vercel deployment (ADR-096).
2. Decommissioning the custom Cloud Run orchestrator daemon in favor of Agent Platform / Vertex AI Reasoning Engine (ADR-087).
3. Splitting scheduling substrate between GitHub Actions and Claude Routines (ADR-093).
4. Introducing the hot tier and term entities in the MCP handshake prompt (ADR-092).
5. Grounding temporal windows in valid time (`effective_at`) vs transaction time (`captured_at`) (ADR-088).
6. Settling open questions on entity domain derivation (ADR-084), public class ontology (ADR-085), per-connector L3 map-versus-store policy (ADR-091), and RAG status banding (ADR-083).

Leaving `architecture.md` un-reconciled meant the repository's primary "as-built" reference asserted that `packages/web` was an active production tier, that a Cloud Run daemon ran orchestration, and that the MCP handshake lacked the hot-tier dictionary.

## Decision

### 1. Eighteen ADRs in the gap: disposition table

| ADR | Title | Bearing on `architecture.md` | Bearing on `vision.md` | Disposition |
|---|---|---|---|---|
| **079** | Per-Class Handling Is A Capability | **Material.** §Decision bands and correction ledger | **Material, narrowly.** Review gate & confidence ranking | Added to §Decision bands. |
| **080** | Issues Carry One Status And One Priority | **Meta / process.** | **Meta / process.** | No apex doc edits needed (amended by ADR-089). |
| **081** | Connector Migrates Into ahKMS When Single Connection Cannot Serve Two Accounts | **Material.** In §Topology and §Integration Boundaries | **None.** Preserves multi-domain coherence thesis | Reconciled connector boundaries (Gmail, Calendar, Notion, PostHog in ahKMS; GitHub first-party). |
| **082** | Web Capture Meeting Notes Derived Artifact Path Retired | **Material.** §3b Meeting notes flow | **None.** As-built detail | Removed `cleaned_meeting_notes` capture path. |
| **083** | RAG Status Is LLM-Inferred And Banded | **Material.** Decision families | **Material.** Resolves state-doc health fence | Documented `rag_status` in `confidence_thresholds`. |
| **084** | Entity Domain Derived By Rule, Residue Stored As Override | **Material.** `entities.domain_override` (migration 101) | **Material.** Closes domain fence | Reconciled in §Capability status and §Fences. |
| **085** | People, Organization, Place, Event Anchor To Public Classes | **Material.** §Graph derivation vocabulary | **None.** Ontology alignment | Added public class mappings to `ENTITY_TYPE_CLASS_CONTEXT`. |
| **086** | PostHog Writes Travel On A Second Key | **Material.** Credential seam | **None.** Credential security | Added write key and policy constraints to §Integration Boundaries. |
| **087** | Orchestrator Runs On Agent Platform | **Material.** Production topology | **None.** Placement detail | Replaced custom Cloud Run daemon with Vertex AI Reasoning Engine supervisor. |
| **088** | Day Window Reads Valid Time, Coverage Reads Transaction Time | **Material.** Data model and day queries | **Material, narrowly.** Temporal precision | Documented `effective_at` vs `captured_at`. |
| **089** | `needs-human` Replaces `needs-angus`, `deferred` Parks Behind Trigger | **Meta / process.** | **Meta / process.** | No doc edits needed. |
| **090** | PR Into Dev Merges Itself On QA Approval | **Meta / CI-CD.** | **None.** | No doc edits needed. |
| **091** | Per-Connector L3 Map-Versus-Store Policy | **Material.** §Storage architecture | **Material.** Already absorbed in §Storage table | Added per-connector storage policy table in §Integration Boundaries. |
| **092** | Terms, Aliases, And Hot Tier In Handshake | **Material.** §Hot tier section | **Material.** Prompt grounding coherence | Added hot-tier rendering and `term` entity description. |
| **093** | Scheduling Substrate Split By Job Class | **Material.** §Scheduled cadences | **None.** Operational scheduling | Documented GitHub Actions vs Claude Routines split. |
| **094** | Model Behaviour Change Requests SOP | **Material.** Preferences architecture | **Material.** Single-home memory rule | Documented tone in `dos_config`, preferences in `user_preferences`. |
| **095** | Canonical Claude Instructions Hybrid And Single Block | **Material.** Handshake instructions | **None.** Client integration detail | Documented `{ sha256, pasted_at }` verification in `ahos_doctor`. |
| **096** | Retire The Web Surface | **Crucial.** Production topology & responsibilities | **Minor.** Web UI was never the thesis | Archived `packages/web`, removed Vercel tier, MCP sole serving surface. |

---

### 2. Concrete updates to `architecture.md`

1. **Production Topology & Web Retirement (ADR-096):**
   - Removed `packages/web` from active services in §Purpose, §Production Topology, and §Local Development Topology.
   - Recorded that `packages/web` is archived out of the tree (`web-archive-2026-09` tag / `archive/web` branch) and its Vercel deployment deleted.
   - Updated the serving architecture: `packages/mcp-server` on Railway is the sole serving surface; `packages/mobile` is the only client package.
2. **Orchestrator Placement (ADR-087):**
   - Updated §Production Topology to record that supervisor orchestration runs on Agent Platform (Vertex AI Reasoning Engine, `work-supervisor-agent`, with `VertexAiMemoryBankService` and Cloud Scheduler sweeps). The custom Cloud Run daemon was decommissioned.
3. **Scheduling Substrate Split (ADR-093):**
   - Updated §Scheduled cadences to reflect the two substrates: repo-scoped engineering jobs run on GitHub Actions `schedule:`; personal-ops jobs requiring connectors run on claude.ai Routines calling capability pointers (`run ahos/<capability>`).
4. **Hot Tier & Term Nodes (ADR-092):**
   - Expanded §Hot tier to describe `entity_type = 'term'` (expansion/context in properties), `aliases text[]` on `entities`, and the 100-line hard cap rendered into the MCP handshake prompt.
5. **Data Model & Temporal Precision (ADR-088):**
   - Documented `artifacts.originated_at` (valid time) and generated `effective_at` = `COALESCE(originated_at, captured_at)`. Day queries use `effective_at`; coverage and ritual execution checks use `captured_at`.
6. **Ontology & Domain Derivation (ADR-084, ADR-085):**
   - Added `entities.domain_override` (migration 101) derived by PARA containment then `domain_signals`.
   - Recorded public class anchoring for `people`, `organization`, `place`, `event` in `ENTITY_TYPE_CLASS_CONTEXT`.
7. **Connector Topology & Credentials (ADR-081, ADR-086):**
   - Documented the multi-account migration rule: Gmail, Calendar, Notion, PostHog, Booking.com migrate into ahKMS because first-party connectors authenticate as a single account; GitHub remains first-party because one account sees both personal and Work repositories.
   - Documented PostHog write isolation on `POSTHOG_API_KEY_..._WRITE` with project scope checks and explicit acknowledgement for filter/cohort edits.
8. **Primary Capture Flows (ADR-082, ADR-096):**
   - Retired the web capture routes; primary ingress flows are MCP `capture`, direct-to-worker upload, and adapter ingestion.
   - Retired path 2 in meeting notes (`cleaned_meeting_notes`).

---

### 3. Reconciliations to `vision.md`

1. **Header & Watermark:**
   - Watermark bumped to `ADR-096 · 2026-09-28 · evidence: ADR-097`.
   - Header date updated to 2026-09-28.
2. **Settled Fences:**
   - Former Fence 1 (L3 map-versus-store) was settled by ADR-091 (table in §Storage).
   - Former Fence 2 (RAG status / state-doc health) is settled by ADR-083 (LLM-inferred dedicated agent call, banded under `confidence_thresholds`).
   - Former Fence 3 (entity domain assignment) is settled by ADR-084 (rule-derived via PARA containment then `domain_signals`, residue stored in `entities.domain_override`).

---

### 4. Watermarks move to ADR-096

Both apex documents move to:
```markdown
Reviewed-against: ADR-096 · 2026-09-28 · evidence: ADR-097
```

`ADR-096` is the newest ADR accepted on `dev` at review time. Naming ADR-096 with evidence ADR-097 adheres to ADR-059 §3: a batch minting its own ADRs understates its freshness by design, self-correcting upon merge. Both apex documents read level (`0 ADR(s) behind`).

---

### 5. Scope and limits (ADR-059 auditability)

This pass covers the eighteen ADRs in the gap (ADR-079 through ADR-096), dispositioning each and reading the material ones in full against `architecture.md` and `vision.md`. It does **not** claim an unbounded re-derivation of the entire codebase or all 97 ADRs.
