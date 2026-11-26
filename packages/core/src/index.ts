// Centralised Action Registry (CAR) Core Primitives
export * from "./actions/types.js";
export * from "./actions/defineAction.js";
export * from "./actions/exposure.js";
export * from "./actions/registry.js";
export * from "./actions/adapters/direct.js";
export * from "./actions/scope.js";
export * from "./actions/inputHash.js";
export * from "./actions/gate.js";
export * from "./actions/approvalNotify.js";

// Canonical Domain Constants & Boundaries (ADR-051, ADR-054)
export * from "./domain/domains.js";
export * from "./domain/sweepOutcome.js";
export * from "./domain/expectedRoutines.js";
export {
	PRIORITY_LEVEL_NUMBERS,
	type PriorityLevel,
	PRIORITY_LEVEL_CODES,
	type PriorityLevelCode,
	PRIORITY_LEVEL_TITLES,
	type PriorityLevelTitle,
	PRIORITY_LEVEL_SLUGS,
	type PriorityLevelSlug,
	type CoarseTaskPriority,
	type NotionTaskPrioritySelect,
	type NotionPriorityTier,
	type PriorityLevelDefinition,
	DEFAULT_PRIORITY_CUT_LINE,
	PRIORITY_LEVELS,
	PRIORITY_SURFACES,
	type PrioritySurface,
	type PrioritySurfaceMapping,
	PRIORITY_SURFACE_MAPPINGS,
	PRIORITY_TIER_TO_NOTION_SELECT,
	isPriorityLevel,
	isPriorityLevelSlug,
	getPriorityLevelDefinition,
	getPriorityLevelBySlug,
	formatPriorityBadge,
	priorityTierToLevel,
	priorityLevelToTier,
	priorityLevelToNotionTier,
	notionTierToPriorityLevel,
	priorityLevelToTaskCrudPriority,
	taskCrudPriorityToPriorityLevel,
	priorityLevelToTaskPriority,
	taskPriorityToLevel,
	priorityLevelToNotionSelect,
	priorityTierToNotionSelect,
	notionSelectToPriorityLevel,
	mapPriorityToSurface,
	mapSurfaceToPriorityLevel,
	toExternalPriority,
	fromExternalPriority,
	resolveEffectivePriorityLevel,
} from "./domain/priorityScale.js";
export * from "./domain/taskDimensions.js";
export * from "./domain/geminiDeclarations.js";
export * from "./domain/domainInput.js";
export * from "./domain/agentReadyBar.js";
export * from "./domain/artifacts.js";
export * from "./domain/dex/catalog.js";
export * from "./domain/vocab.js";
export * from "./domain/jobApplications.js";
export * from "./domain/jobApplicationEmail.js";
export * from "./domain/ingest/selection.js";
export * from "./domain/ingest/exclusions.js";
export * from "./domain/extract/office.js";
export {
	discoverInput,
	discoverSchema,
	discoveryMetadata,
	driveColumns,
	envelopeFields,
	firstLine,
	isJunkTitle,
	JUNK_TITLE_PATTERNS,
	MAX_TITLE_LEN,
	needsEnvelopeRefresh,
	normalizePointerUrl,
	ORIGINATION_FIELD_BY_CONNECTOR,
	originatedAt,
	originationFor,
	pointerDescription,
	pointerEmbedText,
	pointerProcessingStatus,
	pointerUrl,
	resolveTitle,
	slugify as slugifyPointerTitle,
	URL_SUFFIX_CONNECTORS,
	type DiscoverCounts,
	type DiscoverItem,
	type EnvelopeRefreshRow,
	type ExistingRow,
} from "./domain/ingest/discoverPointers.js";

// Canonical Domain Action Schemas & Types (ADR-100)
export * from "./actions/domain/entities.js";
export * from "./actions/domain/governance.js";
export * from "./actions/domain/tasks.js";
export * from "./actions/domain/derive.js";
export * from "./actions/domain/derivePorts.js";
export * from "./ports/github.js";
export * from "./actions/github/issueCreate.js";
export * from "./actions/github/issueWrite.js";
export * from "./actions/github/prWrite.js";
export * from "./actions/ingest/github.js";
export * from "./actions/ingest/slack.js";
export * from "./ports/linkedin.js";
export * from "./actions/linkedin/post.js";
export * from "./ports/notion.js";
export * from "./actions/notion/pageCreate.js";
export * from "./actions/notion/pageUpdate.js";
export * from "./actions/notion/userList.js";
export {
	buildHeadingBlock,
	markdownToBlocks,
	NOTION_TEXT_LIMIT,
	richTextRuns,
	textBlock,
	type BlockPayload,
	type HeadingLevel,
	type NotionInlineAnnotations,
	type RichTextRun,
} from "./actions/notion/blocks.js";
export {
	blockPlainText,
	blockRichText,
	buildLastUpdatedText,
	findHeadingIndexes,
	findLastUpdatedBlock,
	findSectionSpan,
	HEADING_BLOCK_TYPES,
	headerRegion,
	isHeadingBlock,
	parseSectionBody,
	rewriteLastUpdatedLine,
	sectionBodyBlocks,
	sectionHeadings,
	type RichTextPayload,
	type SectionSpan,
} from "./domain/stateDoc.js";
export * from "./ports/sheets.js";
export * from "./ports/drive.js";
export * from "./actions/drive/changesList.js";
export * from "./actions/drive/commentRead.js";
export * from "./actions/drive/commentWrite.js";
export * from "./actions/drive/deleteAndUnshare.js";
export * from "./actions/drive/export.js";
export * from "./actions/drive/metadata.js";
export * from "./actions/drive/move.js";
export * from "./actions/drive/renameAndTrash.js";
export * from "./actions/drive/share.js";
export * from "./actions/drive/uploadFile.js";
export * from "./ports/docs.js";
export * from "./actions/docs/outline.js";
export * from "./actions/docs/get.js";
export * from "./actions/docs/findText.js";
export * from "./actions/docs/comments.js";
export * from "./actions/docs/batchUpdate.js";
export * from "./ports/onedrive.js";
export * from "./actions/onedrive/index.js";
export * from "./ports/driveWatch.js";
export * from "./ports/calendar.js";
export * from "./actions/calendar/deleteEvent.js";
export * from "./actions/calendar/eventCreate.js";
export * from "./actions/calendar/getEvent.js";
export * from "./actions/calendar/listEvents.js";
export * from "./actions/calendar/respondToEvent.js";
export * from "./actions/calendar/updateEvent.js";
export * from "./ports/gmail.js";
export * from "./actions/gmail/draft.js";
export * from "./actions/gmail/modify.js";
export * from "./actions/gmail/search.js";
export * from "./actions/gmail/sendDraft.js";
export * from "./ports/appsscript.js";
export {
	formatDeployment,
	formatDeployments,
	formatVersion,
	formatVersions,
	type FormattedScriptDeployment,
	type FormattedScriptVersion,
} from "./actions/appsscript/format.js";
export * from "./actions/appsscript/listVersions.js";
export * from "./actions/appsscript/listDeployments.js";
export * from "./domain/appsscript/mergeFiles.js";
export * from "./actions/appsscript/createVersion.js";
export * from "./actions/appsscript/createDeployment.js";
export * from "./actions/appsscript/createProject.js";
export * from "./actions/appsscript/updateContent.js";
export * from "./actions/outwardWrite.js";
export * from "./ports/review.js";
export * from "./ports/decisions.js";
export * from "./actions/domain/review.js";
export * from "./actions/review/decisionReview.js";
export * from "./actions/review/decisionReviewBody.js";
export * from "./actions/review/reviewList.js";
export * from "./actions/review/reviewResolve.js";
export * from "./ports/tasks.js";
export * from "./actions/tasks/taskCrud.js";
export * from "./actions/tasks/taskCrudBody.js";
export * from "./actions/tasks/createTask.js";
export * from "./actions/tasks/taskProperties.js";
export * from "./actions/tasks/createTaskRules.js";
export * from "./ports/artifacts.js";
export * from "./ports/storage.js";
export * from "./ports/cleanState.js";
export * from "./actions/domain/capture.js";
export {
	BACKDATABLE_CONTENT_SUBTYPES,
	SYSTEM_PRODUCED_CONTENT_SUBTYPES,
} from "./domain/vocab.js";
export * from "./actions/artifacts/capture.js";
export * from "./actions/artifacts/captureBody.js";
export * from "./actions/artifacts/cleanStateCheck.js";
export * from "./actions/artifacts/delete.js";
export * from "./actions/artifacts/documentDuplicates.js";
export * from "./actions/artifacts/documentDuplicatesBody.js";
export * from "./actions/artifacts/port.js";
export * from "./actions/artifacts/documentPointer.js";
export * from "./actions/artifacts/documentResolve.js";
export * from "./actions/artifacts/embedBackfill.js";
export * from "./actions/artifacts/externalLinkCreate.js";

export * from "./actions/artifacts/get.js";
export * from "./actions/artifacts/getFile.js";
export {
	createKnowledgeSearchAction,
	KNOWLEDGE_SEARCH_DESCRIPTION,
	knowledgeSearchInput,
	knowledgeSearchSchema,
	searchInput,
	type KnowledgeSearchInput,
	type KnowledgeSearchPorts,
	type KnowledgeSearchResult,
} from "./actions/artifacts/knowledgeSearch/index.js";
export * from "./actions/artifacts/update.js";
export * from "./ports/relationships.js";
export * from "./actions/domain/relationships.js";
export * from "./actions/relationships/relationshipCrud.js";
export * from "./ports/entities.js";
export * from "./ports/entityMerge.js";
export * from "./domain/entityMerge.js";
export * from "./ports/graphRead.js";
export * from "./actions/entities/core.js";
export * from "./actions/entities/port.js";
export * from "./actions/entities/entityCrud.js";
export * from "./actions/entities/entityBulkDelete.js";
export * from "./actions/entities/singleOps.js";
export * from "./actions/entities/unmerge.js";
export * from "./actions/entities/promoteEdge.js";
export * from "./actions/entities/relate.js";
export * from "./actions/entities/links.js";
export * from "./actions/entities/neighbourhood.js";
export * from "./actions/entities/format.js";
export * from "./actions/entities/relationshipType.js";
export * from "./ports/people.js";
export * from "./actions/people/shared.js";
export * from "./actions/people/scoring.js";
export * from "./actions/people/personFields.js";
export * from "./actions/people/create.js";
export * from "./actions/people/get.js";
export * from "./actions/people/match.js";
export * from "./actions/people/query.js";
export * from "./actions/people/self.js";
export * from "./actions/people/upsert.js";
export * from "./ports/gmailReconcile.js";
export * from "./actions/google/gmailPriorityTriage.js";
export * from "./actions/google/gmailTriageMetrics.js";
export * from "./actions/google/gmailUnsubscribeBatch.js";
export * from "./ports/enrich.js";
export * from "./ports/chat.js";
export * from "./ports/webhookWork.js";
export * from "./actions/webhooks/notionCompletedAtStamp.js";
export * from "./actions/webhooks/driveDiscoverSweep.js";
export * from "./ports/capabilities.js";
export * from "./actions/capabilities/shared.js";
export * from "./actions/capabilities/get.js";
export * from "./actions/capabilities/register.js";
export * from "./actions/capabilities/resolve.js";
export * from "./ports/externalLinks.js";
export * from "./domain/integrations.js";
export * from "./domain/capturePreferences.js";
export * from "./domain/emailTriage.js";
export * from "./domain/emailSignals.js";
export * from "./domain/emailRubric.js";
export * from "./domain/emailRouting.js";
export * from "./domain/emailFastPath.js";
export * from "./domain/emailGoldenExamples.js";
export * from "./domain/emailMetrics.js";
export * from "./domain/emailMetricsSeries.js";
export * from "./ports/emailMetrics.js";
export * from "./ports/emailReasoner.js";
export * from "./ports/decisionJudge.js";
export * from "./ports/config.js";
export * from "./actions/config/integrationList.js";
export * from "./actions/config/integrationSet.js";
export * from "./actions/config/notionConfigGet.js";
export * from "./actions/config/captureGet.js";
export * from "./actions/config/preferencesGet.js";
export * from "./actions/config/preferencesUpdate.js";
export * from "./ports/doctor.js";
export * from "./actions/config/ahosDoctor.js";
export * from "./actions/config/doctorReport.js";
export * from "./actions/config/canonicalInstructions.js";
export * from "./actions/config/instructionsGet.js";
export * from "./actions/config/instructionsMarkPasted.js";
export * from "./ports/vocabulary.js";
export * from "./ports/schema.js";
export * from "./actions/artifacts/storeSchema.js";
export * from "./ports/bindings.js";
export * from "./actions/bindings/shared.js";
export * from "./actions/bindings/list.js";
export * from "./actions/bindings/create.js";
export * from "./actions/bindings/update.js";
export * from "./actions/bindings/delete.js";
export * from "./ports/planning.js";
export * from "./actions/planning/render.js";
export * from "./actions/planning/read.js";
export * from "./actions/planning/edit.js";
export * from "./ports/revenuecat.js";
export * from "./domain/revenuecat/contract.js";
export * from "./actions/revenuecat/getMetrics.js";
export * from "./actions/graph/nodeLevel.js";
export * from "./ports/embeddings.js";
export * from "./domain/embeddings.js";
export * from "./ports/posthog.js";
export * from "./actions/posthog/render.js";
export * from "./actions/posthog/connections.js";
export * from "./actions/posthog/projectFilter.js";
export * from "./actions/posthog/query.js";
export * from "./ports/bigquery.js";
export * from "./actions/bigquery/query.js";
export * from "./actions/google/gmailAttachmentToDrive.js";
export * from "./actions/records/propertyRoles.js";
export * from "./actions/records/recordTarget.js";
export * from "./actions/records/meetingCreate.js";
export * from "./actions/records/communicationCreate.js";
export * from "./actions/ledger/clientActionRecord.js";
export * from "./domain/dailyLogTarget.js";
export * from "./domain/dailyLogCovers.js";
export * from "./ports/slack.js";
export * from "./actions/slack/post.js";
export * from "./actions/slack/slackRead.js";
export * from "./actions/slack/write.js";
export * from "./ports/whatsapp.js";
export * from "./actions/whatsapp/index.js";
export * from "./actions/metrics/index.js";
export {
	attachDosConfigToToneRules,
	audienceSpecs,
	audienceSpecsForDomain,
	audienceSpecSchema,
	dailyLogRoleProperty,
	DEFAULT_DOMAIN,
	DEFAULT_DOS_CONFIG,
	domainConfig,
	dosConfigSchema,
	findAudienceSpec,
	formatDomainSummaryLine,
	loadDosConfig,
	operatingPrinciples,
	pastedInstructionsSchema,
	pillarNotionOption,
	renderDosConfigSections,
	type ArtefactRegister,
	type AtomType,
	type AudienceSpec,
	type DailyLogProperty,
	type DomainConfig,
	type DosConfig,
	type DosConfigRowReader,
	type PastedInstructions,
	type Pillar,
	type ToneRulesWithConfig,
} from "./domain/dosConfig.js";
export * from "./actions/dos/configDrift.js";
export * from "./actions/dos/configGet.js";
export * from "./actions/dos/dailyLogCreate.js";
export * from "./actions/dos/dailyLogQueue.js";
export * from "./actions/dos/synthesisCoverage.js";
export * from "./actions/dos/stateDocUpdate.js";
export * from "./ports/search.js";
export * from "./domain/uiActions.js";
export * from "./actions/ui/graphFilter.js";
export * from "./actions/ui/viewScreen.js";
export * from "./domain/ingest/meetingNoteEmails.js";
export * from "./actions/ingest/meetingNotesDetect.js";
export * from "./ports/discover.js";
export {
	createIngestDiscoverAction,
	DISCOVERED_STAGE,
	embedShortfallNote,
	formatIngestDiscoverMcp,
	INGEST_DISCOVER_DESCRIPTION,
	type DiscoverFormatMeta,
	type IngestDiscoverDeps,
} from "./actions/ingest/discover.js";
export * from "./ports/jobQueue.js";
export * from "./actions/entities/deriveNext.js";
export { isMissingColumnError } from "./domain/aliases.js";
export {
	fetchPrimaryParentsBatch,
	matchesDomainSignals,
	resolveEntityDomain,
	resolveEntityDomainSafely,
	type DomainResolutionContext,
	type EntityDomainReader,
	type EntityDomainResolution,
} from "./domain/entityDomain.js";
export * from "./ports/extraction.js";
export * from "./actions/artifacts/extractText.js";
export * from "./actions/drive/importFile.js";
export * from "./ports/mcpPassthrough.js";
export * from "./actions/passthrough/brevoSends.js";
export * from "./actions/passthrough/brevo.js";
export * from "./actions/passthrough/dex.js";
export * from "./actions/passthrough/metaAds.js";
export * from "./actions/entities/artifactSync.js";
export * from "./actions/domain/jobhunt.js";
