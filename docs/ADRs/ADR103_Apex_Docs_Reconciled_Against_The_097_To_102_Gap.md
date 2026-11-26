# ADR-103: Apex docs get their scoped pass against the ADR-097 to ADR-102 gap

- **Status:** Accepted
- **Created:** 2026-10-06
- **Accepted-on-dev:** 2026-10-06
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, architecture, vision, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (apex doc freshness mechanisms),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (a bump requires evidence; understating self-corrects),
  [ADR-074](./ADR074_Vision_Gets_Its_Second_Scoped_Pass_And_Two_Register_Entries_Do_Not_Survive_It.md) (vision's second pass),
  [ADR-076](./ADR076_Architecture_Gets_Its_Third_Scoped_Pass_And_Corrects_A_Claim_About_Its_Own_Instrument.md) (architecture's third pass),
  [ADR-097](./ADR097_Apex_Docs_Reconciled_Against_The_079_To_096_Gap.md) (apex docs pass ADR-079..096)
- **Issue:** #1371

## Context and problem

`docs/vision.md` tripped its freshness threshold under `check-apex-watermark.js` (ADR-056 mechanism 2, ADR-059):

```
BEHIND  docs/vision.md — is 6 ADR(s) behind, the oldest unreviewed landing 3 day(s) ago
          in the gap: ADR-097 .. ADR-102
OK      docs/architecture/architecture.md — is 1 ADR(s) behind (ADR-102: 2026-10-04)
```

Issue #1371 tracked this drift. Between 2026-10-02 and 2026-10-04, six ADRs landed on `dev`:
1. Auditing and reconciling apex docs through ADR-096 (ADR-097).
2. Modeling tracked documents ("my CV", passports, contracts) as `resource` entities with canonical pointers and `dcterms:isVersionOf` artifact links rather than separate document tables or artifact-merging (ADR-098).
3. Modeling the career master ledger directly within the graph using existing entity types (`arrangement`, `achievement`, `concept`, `person`) and standard vocabularies (`schema:knowsAbout`), adhering to valid time and strict projection derivation rules (ADR-099).
4. Reversing ADR-096's permanent retirement of the web surface by establishing the blueprint for `@ahkms/web` as an authenticated-only Agent-Native Co-Editing and Knowledge Graph workspace, backed by a universal Centralised Action Registry (`defineAction` / CAR SSOT) guaranteeing 100% Agent-UI parity (ADR-100).
5. Structuring the repository into two packages and two processes: `@ahkms/core` as the isomorphic rulebook and background engine, and `@ahkms/mcp-server` as the fast front door (ADR-101).
6. Establishing the three-role operating model (Owner, Architect, Executor), bounded work packets for `agent-ready` tasks, a rigorous verification ladder, and derived bottleneck metrics (ADR-102).

Leaving `docs/vision.md` un-reconciled left its §Two consumers description of the human-facing surface asserting that humans have no dedicated vision backing and only passive/weak views, whereas ADR-100 and ADR-101 established the active co-editing workspace and unified action substrate.

## Decision

### 1. Six ADRs in the gap: disposition table

| ADR | Title | Bearing on `vision.md` | Bearing on `architecture.md` | Disposition |
|---|---|---|---|---|
| **097** | Apex Docs Reconciled Against The 079 To 096 Gap | **Meta / audit.** Prior audit of 18 ADRs. | **Meta / audit.** Prior audit of 18 ADRs. | Documented prior watermark baseline. |
| **098** | Tracked Documents Are A Resource Entity With A Canonical Pointer | **Material.** §The model, in one sentence; R1 (Universal access); R4 (Coherence across surfaces). | **Already absorbed** in graph derivation & schema views. | Documented document identity resolution without artifact merges. |
| **099** | The Career Ledger Rides Existing Graph Types | **Material.** §The model, in one sentence; §Projections (projections never invent facts). | **Already absorbed** in graph derivation vocabularies. | Documented career ledger riding existing graph types with valid time. |
| **100** | Unified Action Wrapper And Agent-Native Co-Editing Surface | **Crucial.** §Two consumers (human co-editing surface); R6 (Capabilities accessible the same way). | **Already absorbed** in View 0, View 1, View 2, View 3. | Reconciled §Two consumers to record `@ahkms/web` as the authenticated co-editing canvas with 100% Agent-UI parity. |
| **101** | Two Packages, Two Processes: Core Is Rulebook And Engine | **Material.** §Load-bearing principles (One substrate, many consumers); §Where the trail lives. | **Already absorbed** in View 1 & View 2 target topologies. | Documented `@ahkms/core` and two-process runtime model in vision trail. |
| **102** | Operating Model: Architect Writes Packets, Executor Builds Them, Owner Decides At Forks | **Material.** §The cut line (honesty enforced by owner); §Keeping this document true. | **Material.** View 2 Monorepo Architecture & CI Delivery Pipeline. | Documented three-role operating model, work packets, and verification ladder. |

---

### 2. Concrete updates to `docs/vision.md`

1. **Header & Watermark:**
   - Watermark bumped to `ADR-102 · 2026-10-06 · evidence: [ADR103](./ADR103_Apex_Docs_Reconciled_Against_The_097_To_102_Gap.md)`.
   - Date updated to 2026-10-06.
2. **The model, in one sentence (§The model, in one sentence):**
   - Clarified entity derivation: tracked documents (CVs, passports, identity records) resolve as `resource` entities with canonical pointers and `dcterms:isVersionOf` links ([ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)); career history rides existing graph nodes and edges (`arrangement`, `achievement`, `concept`, `schema:knowsAbout`) rather than bespoke tables ([ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md)).
3. **Promises R1 & R4 (§What we promise the user):**
   - R1 ("Universal access"): "Get my CV" or "Get my passport" resolves via tracked `resource` entities without guessing ([ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)).
   - R4 ("Coherence across surfaces"): Multiplicity of file copies across surfaces (e.g. 24 Drive copies of a CV) resolves to one `resource` entity with a golden pointer; superseded copies are soft-archived rather than merged or trashed ([ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)).
4. **Two consumers (§Two consumers):**
   - Reconciled "Humans see it": reverses the void left by ADR-096. Under [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), humans interact with an authenticated Agent-Native Co-Editing workspace and interactive Knowledge Graph canvas (`packages/web`). With 100% Agent-UI parity powered by the Unified Action Wrapper (`defineAction` / CAR SSOT in `@ahkms/core`), every capability is equally available to an autonomous tool caller or a human co-editor, with zero unauthenticated endpoints.
5. **The cut line (§The cut line) & Operating model:**
   - Recorded that the cut line is kept honest by the Owner in ~30 minutes a day; the Architect translates the cut line into bounded, test-backed work packets; and the Executor builds them bounded by mechanical guards rather than unverified judgement ([ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md)).
6. **Trail references (§Where the trail lives):**
   - Added citations for ADR-098, ADR-099, ADR-100, ADR-101, and ADR-102.

---

### 3. Concrete updates to `docs/architecture/architecture.md`

1. **Header & Watermark:**
   - Watermark bumped to `ADR-102 · 2026-10-06 · evidence: [ADR103](../ADRs/ADR103_Apex_Docs_Reconciled_Against_The_097_To_102_Gap.md)`.
2. **Delivery Pipeline Architecture (View 2):**
   - Added documentation of the three-role operating model ([ADR-102](../ADRs/ADR102_Operating_Model_Architect_Owner_Executor.md)): Owner, Architect, Executor; bounded work packets on `status:agent-ready` issues; and the verification ladder (CI → QA loop → Architect review → Release gate).

## Consequences

- **Good:** Both apex documents (`docs/vision.md` and `docs/architecture/architecture.md`) are reconciled against the decision record through ADR-102.
- **Good:** The watermark check `node .github/scripts/check-apex-watermark.js` reports 0 ADRs behind for both apex documents.
- **Good:** Closes issue #1371.
