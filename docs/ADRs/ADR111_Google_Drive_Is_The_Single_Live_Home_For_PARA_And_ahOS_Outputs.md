# ADR111: Knowledge Graph is the unified single source of truth across a format-split personal cloud estate (OneDrive for Office/PC folders, Google Drive for Google-native docs) and Work Google Workspace

- **Status:** Accepted
- **Created:** 2026-10-16
- **Accepted-on-dev:** 2026-10-16
- **Deciders:** Angus Hally (owner)
- **Builds on:** [ADR-016](./ADR016_Discover_And_Index_Axis.md), [ADR-028](./ADR028_Surface_Registry_And_Reference_Artifacts.md), [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md), [ADR-091](./ADR091_Per_Connector_L3_Map_Versus_Store_Policy.md), [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md), [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md)

## Context and problem

The owner's files span two cloud providers (Google Drive and Microsoft OneDrive) and two domains (`angus` personal and `work` company), alongside Windows PC local folders (`Desktop`, `Documents`, `Pictures`) backed up through OneDrive Known Folder Move. Without an explicit rule for which cloud holds which live document and how ahOS resolves canonical identity across both, three problems arise:

1. **Ambiguous canonical identity across surfaces.** Tracked documents ([ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)) and career artifacts ([ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md)) had copies sitting simultaneously in Google Drive and OneDrive without a single canonical pointer rule.
2. **Broken native desktop Office workflows when forcing Office files onto Google Drive.** Opening `.xlsx`, `.xls`, `.pptx`, and `.docx` files in desktop Excel, PowerPoint, and Word requires OneDrive for native AutoSave, version history, and Windows Known Folder Move (`Desktop`, `Documents`, `Pictures`). Moving those files into Google Drive breaks native desktop Office AutoSave.
3. **Company file scatter.** Roughly 303 Work company files sat in personal OneDrive folders ([#1251](https://github.com/anguspersonal/ahOS/issues/1251)), splitting company assets away from the shared Work Google Workspace Drive.

On 2026-10-16 ([#1250](https://github.com/anguspersonal/ahOS/issues/1250)), the initial version of this ADR proposed moving all personal files and PC folders onto Google Drive. On 2026-11-01 ([#2085](https://github.com/anguspersonal/ahOS/issues/2085)), after shipping the full Microsoft Graph OneDrive adapter (`onedrive_*` actions) and Office Open XML extraction ([#2084](https://github.com/anguspersonal/ahOS/issues/2084)), the owner amended this decision to establish the **Knowledge Graph as the single source of truth** across a **format-based personal split** and a **single Google Workspace home for Work**.

## Decision drivers

1. **One canonical source of truth in the Knowledge Graph.** `document_resolve` ([ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)) and `document_duplicates` resolve the single canonical pointer (`canonical_artifact_id`) for every tracked document regardless of whether the file lives in Google Drive or OneDrive.
2. **Native editing ergonomics for each file format.** Microsoft Office files (`.xlsx`, `.xls`, `.pptx`, `.docx`) and Windows PC folders (`Desktop`, `Documents`, `Pictures`) belong on OneDrive where desktop Excel/PowerPoint AutoSave and Windows Known Folder Move work natively. Google Docs and Google Sheets belong on Google Drive.
3. **Full ingestion parity across both clouds.** Both `gdrive` (`gdrive_work`) and `onedrive` are first-class enrichable connectors in `ingest_discover` and `ingest_enrich_next` ([ADR-016](./ADR016_Discover_And_Index_Axis.md)).
4. **Single company workspace for Work.** All Work company files belong in the Work Google Workspace Drive regardless of file format so the team has one shared estate.

## Considered options

### Option A: Force every personal file and PC folder into Google Drive

Move all personal PARA folders, Office files, and PC local folders (`Desktop`, `Documents`, `Pictures`) to Google Drive and use OneDrive only as a backup target.

- **Pros:** Only one cloud provider for personal files.
- **Cons:** Breaks native desktop Excel and PowerPoint AutoSave; requires reconfiguring Windows Known Folder Move onto Google Drive for Desktop; forces manual migration of active personal spreadsheets and slide decks.

### Option B: Knowledge Graph as the unified single source of truth; format-based split for personal (`angus`) and Google Workspace for Work (`work`) (chosen, 2026-11-01 amendment)

Use the Knowledge Graph (`artifacts` + `resource` entities via `document_resolve`) as the single source of truth across both clouds, indexing both Google Drive and OneDrive via `ingest_discover` and `ingest_enrich_next`:

- **Personal (`angus` domain):** OneDrive Personal is the live home for Microsoft Office documents (`.xlsx`, `.xls`, `.pptx`, `.docx`) and Windows PC local folders (`Desktop`, `Documents`, `Pictures`). Google Drive Personal is the live home for Google-native Docs/Sheets and personal ahOS outputs (with OneDrive `Backup - Google Drive` remaining the one-way backup destination for Google Drive under [#1292](https://github.com/anguspersonal/ahOS/issues/1292)).
- **Work (`work` domain):** Work Google Workspace Drive is the single live home for all company files regardless of format (including `.xlsx`, `.pptx`, `.docx`).

## Decision

### 1. The Knowledge Graph is the unified single source of truth

The Knowledge Graph (`artifacts` + `resource` entities managed by `document_resolve` and `document_duplicates` per [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)) is the single source of truth for document identity across Google Drive and OneDrive:

- Every tracked document has one `resource` entity whose `canonical_artifact_id` points to its single authoritative live file (whether that pointer's `source_channel` is `discovered_gdrive`, `discovered_gdrive_work`, or `discovered_onedrive`).
- Both `gdrive` (`gdrive_work`) and `onedrive` are enrichable connectors in `ENRICHABLE_CONNECTORS` ([ADR-016](./ADR016_Discover_And_Index_Axis.md)), extracting full text from PDFs, plain text, Google Docs/Sheets, and Office Open XML (`.docx`, `.xlsx`, `.pptx`).

### 2. Personal domain (`angus`): format-based live home split

For personal files (`angus` domain):

1. **OneDrive Personal is the live home for Microsoft Office files and PC local folders:**
   - All personal `.xlsx`, `.xls`, `.pptx`, and `.docx` working documents live in OneDrive Personal so desktop Excel, PowerPoint, and Word AutoSave and version history work natively.
   - Windows PC local folders (`Desktop`, `Documents`, `Pictures`) stay on **OneDrive Known Folder Move** (superseding the earlier plan to switch PC folders to Google Drive for Desktop). Screenshots in `Pictures` remain excluded from knowledge synthesis per [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md).
2. **Google Drive Personal is the live home for Google-native documents and personal ahOS outputs:**
   - All personal Google Docs, Google Sheets, and personal ahOS document outputs (canonical golden copies rendered as Google Docs or PDFs, CV renders under [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md), and filed meeting notes) live in Google Drive Personal.
   - OneDrive's `Backup - Google Drive` folder continues to serve as the isolated one-way backup destination for Google Drive ([#1292](https://github.com/anguspersonal/ahOS/issues/1292)) and is excluded from live canonical resolution.

### 3. Work domain (`work`): Google Workspace Drive for all formats

For Work company files (`work` domain):

- **Work Google Workspace Drive (`gdrive_work`) is the single live home for all company files regardless of format**, including `.xlsx`, `.pptx`, `.docx`, PDFs, and Google Docs/Sheets.
- The ~303 Work files sitting in personal OneDrive folders ([#1251](https://github.com/anguspersonal/ahOS/issues/1251)) will be moved by the owner into the Work Google Workspace Drive as a low-priority cleanup task.

## Consequences

- **Good:** Desktop Excel and PowerPoint AutoSave and Windows Known Folder Move work out of the box on OneDrive Personal; `ingest_discover` and `ingest_enrich_next` index both clouds into one Knowledge Graph; `document_resolve` provides a single canonical pointer across Google Drive and OneDrive; Work keeps a single company workspace in Google Drive.
- **Cost / bad:** Personal PARA folders exist in both clouds by format, making `document_duplicates` and `document_resolve` essential whenever a document has been copied across clouds ([#1219](https://github.com/anguspersonal/ahOS/issues/1219)).

## Links

- Serves: [ADR-016](./ADR016_Discover_And_Index_Axis.md), [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md), [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md)
- Related: [#1211](https://github.com/anguspersonal/ahOS/issues/1211), [#1219](https://github.com/anguspersonal/ahOS/issues/1219), [#1238](https://github.com/anguspersonal/ahOS/issues/1238), [#1249](https://github.com/anguspersonal/ahOS/issues/1249), [#1250](https://github.com/anguspersonal/ahOS/issues/1250), [#1251](https://github.com/anguspersonal/ahOS/issues/1251), [#1292](https://github.com/anguspersonal/ahOS/issues/1292), [#2084](https://github.com/anguspersonal/ahOS/issues/2084), [#2085](https://github.com/anguspersonal/ahOS/issues/2085)
