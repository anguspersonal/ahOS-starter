# ADR091: Per-connector L3 map-versus-store policy

- **Status:** Accepted
- **Created:** 2026-09-25
- **Accepted-on-dev:** 2026-09-25
- **Deciders:** Angus
- **Amended by:** [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md) (adds `work-mcp` as a mapped L3 surface)

## Context and problem

In `docs/vision.md` §Storage, ahOS defines three storage layers:
- **L1 : Pointer**: existence, canonical id/URL (always stored in `artifacts` / `artifact_external_links`);
- **L2 : Derived**: extracted text, entities, relationships, embeddings, summary (always stored in the knowledge graph);
- **L3 : Original bytes**: the raw file, image, video, or message body.

The baseline policy is **store by default; map when there's a reason**. `docs/vision.md` defined four rubric reasons to leave L3 in place rather than storing the original bytes locally:
1. **Size** : large assets whose storage cost outweighs local copy benefits.
2. **Liveness** : actively edited documents where snapshots become stale or misleading.
3. **Access control** : organizational or third-party data not belonging to the user.
4. **Surface-native capability** : surfaces with interactive, native capabilities that cannot be replicated.

While the general rule was settled, individual connectors had not been comprehensively adjudicated against this rubric, leading to ambiguities across ingest adapters (#936).

## Decision drivers

- The rubric is a lens, not a verdict : each connector needed its size, liveness, access-control and surface-native-capability profile actually read against it, once, rather than adjudicated ad hoc per ingest adapter as questions came up.
- Ingest adapters need a single table to cite rather than re-deriving the rubric per connector.
- A connector with no data of its own (a transport/aggregator) is a distinct case from a connector that owns a copy of the data : the table needs to say so rather than force a store/map answer where neither applies.

## Considered options

**A. Leave the rubric as guidance, adjudicate per connector as ingest adapters are built.** Rejected : this is the status quo #936 exists to close; it leaves the line ambiguous exactly where an adapter has to make a call, and different adapters could land on different answers for the same rubric.

**B. Classify every connector against the rubric in one settled table, minted as an ADR.** **Chosen.** Matches ADR-075's lane split (the rubric stays in `vision.md`, the per-connector working-out was the `needs-grill` issue, and the settled classification is frozen as a decision here).

## Decision

Every connector is explicitly classified as **Store** (ahkms persists original bytes) or **Map** (pointer L1 and derived L2 stored, original bytes remain on the external surface) according to the rubric:

| Connector | Side | Reason |
|---|---|---|
| Gmail | store | small; retention and lost-account risk |
| Slack | store | small; workspace retention deletes history |
| Google Calendar | store | tiny; the event is the record |
| Google Drive | store, map above size cap (25 MB) | documents stored; video and anything over 25 MB mapped |
| Meeting notes (Plaud and similar) | store transcript, map audio | size |
| LinkedIn (outbound posts) | store | our own content; the platform is not an archive |
| Notion | map | liveness: actively edited, and ahkms reads it live |
| GitHub | map | bytes live in git; surface-native |
| Dex | map | live CRM; the people graph is the L2 copy |
| Brevo | map | access control and liveness on campaign content |
| PostHog, RevenueCat, Meta Ads | map | computed numbers, not raw data ahkms holds a copy of |
| Apps Script | map | code; surface-native |
| Composio | n/a : transport, not a data source | routes outbound posts (LinkedIn above); holds no L1/L2/L3 of its own |
| Supabase (when #871 lands) | map | live database, read-only |
| work-mcp (Work Ops graph & fleet, [ADR-113](./ADR113_Work_MCP_Is_A_Mapped_L3_Surface_Personal_Account_SaaS_Is_ahOS_First.md)) | map | access control (shared company data), liveness, and surface-native agent fleet; L1 pointer, L2 derived entity/summary, and owner-private observations stay in ahOS |

### Google Drive size cap
The size cap for Google Drive L3 byte storage is set to **25 MB** (matching the storage upload ceiling). Files exceeding 25 MB (including video and large binaries) store L1 pointers and L2 derived text/metadata, while L3 bytes remain on Google Drive.

### Notion L2 read adapter deferral
Notion pointers are discovered as Map (L1 pointer plus eventual L2 derived text/summary). Generating L2 for Notion pages requires recursive block-tree traversal (`/v1/blocks/{id}/children`), pagination across multi-level block hierarchies, and handling of rich-text block types (callouts, toggles, child databases, synced blocks). Implementing this server-side read adapter requires a dedicated pagination and rate-limited block-walker surface (#1229). Until that dedicated reader is introduced, Notion pointers remain at L1 with `processing_status='completed'` and are not selected by `ingest_enrich_next`.

## Consequences

- Ingest adapters operate under a clear per-connector policy.
- `docs/vision.md` §Storage incorporates the settled per-connector classification table.
- Future connector implementations must reference this classification matrix and state their alignment with the four rubric reasons.

## Links

- ADR-016 (federated architecture / completeness of index)
- ADR-018 (capture stays dumb / interpret at read)
- ADR-028 (surface registry & reference vs content artifacts)
- ADR-032 (Composio as a transport/aggregator, not a data source, for LinkedIn)
- ADR-043 (vision alignment)
- Issue #936 (Decide where the L3 map-versus-store line falls, per connector)
