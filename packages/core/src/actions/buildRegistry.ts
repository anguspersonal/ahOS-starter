import type { NotionPort } from "../ports/notion.js";
import type {
	GithubActivityPort,
	GithubIssuesPort,
	GithubPullsPort,
} from "../ports/github.js";
import type { LinkedinPort } from "../ports/linkedin.js";
import {
	createGithubIssueAction,
	type GithubIssueActionDependencies,
} from "./github/issueCreate.js";
import {
	createGithubCommentCreateAction,
	createGithubLabelAddAction,
	createGithubLabelRemoveAction,
} from "./github/issueWrite.js";
import {
	createLinkedinPostAction,
	type LinkedinPostActionDependencies,
} from "./linkedin/post.js";
import {
	createGithubPrGetAction,
	createGithubPrDiffAction,
	createGithubPrMergeabilityAction,
	type GithubReadActionDependencies,
} from "./github/prRead.js";
import {
	createGithubPrCommitListAction,
	createGithubPrFileListAction,
	createGithubPrListAction,
	createGithubPrReviewListAction,
} from "./github/prLists.js";
import {
	createGithubIssueGetAction,
	createGithubIssueCommentListAction,
	createGithubIssueTimelineAction,
	createGithubIssueSearchAction,
} from "./github/issueRead.js";
import {
	createGithubRepoGetAction,
	createGithubBranchGetAction,
	createGithubFileGetAction,
	createGithubDirListAction,
} from "./github/repoRead.js";
import {
	createGithubRunListAction,
	createGithubRunJobListAction,
	createGithubJobLogGetAction,
} from "./github/runRead.js";
import {
	createGithubPrCloseAction,
	createGithubPrCreateAction,
	createGithubPrUpdateAction,
	type GithubPullsActionDependencies,
} from "./github/prWrite.js";
import {
	createGithubBranchDeleteAction,
	createGithubReviewCreateAction,
	type GithubReviewActionDependencies,
} from "./github/prReview.js";
import { createIngestGithubAction } from "./ingest/github.js";
import { createIngestMeetingNotesAction } from "./ingest/meetingNotes.js";
import { createIngestMeetingNotesDetectAction } from "./ingest/meetingNotesDetect.js";
import { createIngestSlackAction } from "./ingest/slack.js";
import {
	createIngestDiscoverAction,
	type IngestDiscoverDeps,
} from "./ingest/discover.js";
import type { DiscoverRepository } from "../ports/discover.js";
import {
	createEntityDeriveAction,
	type EntityDerivePorts,
} from "./definitions/entityDerive.js";
import {
	createEntitySynthesizeAction,
	type EntitySynthesizePorts,
} from "./definitions/entitySynthesize.js";
import {
	createGraphNodeLevelAction,
	type GraphNodeLevelActionDependencies,
} from "./graph/nodeLevel.js";
import { createGraphFilterAction } from "./ui/graphFilter.js";
import { createViewScreenAction } from "./ui/viewScreen.js";
import type { GraphEdgePort } from "../ports/graph.js";
import {
	createEntityPathAction,
	type EntityPathDependencies,
} from "./graph/entityPath.js";
import { createNotionBlockDeleteAction } from "./notion/blockDelete.js";
import { createNotionCommentCreateAction } from "./notion/commentCreate.js";
import { createNotionCommentListAction } from "./notion/commentList.js";
import { createNotionDatabaseGetAction } from "./notion/databaseGet.js";
import { createNotionDatabaseQueryAction } from "./notion/databaseQuery.js";
import { createNotionPageCreateAction } from "./notion/pageCreate.js";
import { createNotionPageGetAction } from "./notion/pageGet.js";
import { createNotionPageUpdateAction } from "./notion/pageUpdate.js";
import { createNotionSearchAction } from "./notion/search.js";
import { createNotionUserListAction } from "./notion/userList.js";
import { createContactCreateAction } from "./records/contactCreate.js";
import { createMeetingCreateAction } from "./records/meetingCreate.js";
import { createMcpResultProbeAction } from "./diagnostics/mcpResultProbe.js";
import { createCommunicationCreateAction } from "./records/communicationCreate.js";
import type { ReviewPort } from "../ports/review.js";
import { createDecisionReviewAction } from "./review/decisionReview.js";
import { createReviewListAction } from "./review/reviewList.js";
import { createReviewResolveAction } from "./review/reviewResolve.js";
import {
	createReviewLessonRecordAction,
	type ReviewLessonActionDependencies,
} from "./review/lessonRecord.js";
import type { TaskRepository, TasksPort } from "../ports/tasks.js";
import { createTaskCrudAction } from "./tasks/taskCrud.js";
import { createCreateTaskAction } from "./tasks/createTask.js";
import {
	createJobApplicationUpsertAction,
	createJobHuntGmailIngestAction,
	createJobPipelineReadAction,
	type JobHuntDeps,
	type JobHuntGmailIngestDeps,
} from "./jobhunt/index.js";
import type { ArtifactRepository, ArtifactsPort } from "../ports/artifacts.js";
import type { ConfigRepository } from "../ports/config.js";
import type { DecisionRepository } from "../ports/decisions.js";
import type { StoragePort } from "../ports/storage.js";
import type { ExternalLinkRepository } from "../ports/externalLinks.js";
import type { CleanStatePort } from "../ports/cleanState.js";
import { createArtifactDeleteAction } from "./artifacts/delete.js";
import {
	createArtifactEmbedBackfillAction,
	type ArtifactEmbedBackfillPorts,
} from "./artifacts/embedBackfill.js";
import type { TextExtractionPort } from "../ports/extraction.js";
import {
	createArtifactExtractTextAction,
	type ArtifactExtractTextPorts,
} from "./artifacts/extractText.js";
import { createArtifactGetAction } from "./artifacts/get.js";
import { createArtifactGetFileAction } from "./artifacts/getFile.js";
import { createArtifactUpdateAction } from "./artifacts/update.js";
import { createCaptureAction } from "./artifacts/capture.js";
import { createCleanStateCheckAction } from "./artifacts/cleanStateCheck.js";
import {
	createDocumentDuplicatesAction,
	formatDocumentDuplicatesMcp,
} from "./artifacts/documentDuplicates.js";
import {
	createDocumentResolveAction,
	type DocumentResolveEntitiesPort,
} from "./artifacts/documentResolve.js";
import {
	createExternalLinkCreateAction,
	type ExternalLinkCreateGuardPort,
} from "./artifacts/externalLinkCreate.js";
import type { SearchPort } from "../ports/search.js";
import {
	createKnowledgeSearchAction,
	type KnowledgeSearchPorts,
} from "./artifacts/knowledgeSearch/index.js";
import type { RelationshipsPort } from "../ports/relationships.js";
import { createRelationshipCrudAction } from "./relationships/relationshipCrud.js";
import type { EntitiesPort, EntityRepository, LinkRepository } from "../ports/entities.js";
import type { EntityMergePort } from "../ports/entityMerge.js";
import type { JobQueuePort } from "../ports/jobQueue.js";
import { createEntityCrudAction } from "./entities/entityCrud.js";
import { createEntityBulkDeleteAction } from "./entities/entityBulkDelete.js";
import { createEntityDeriveNextAction } from "./entities/deriveNext.js";
import { createJobListAction } from "./jobs/list.js";
import {
	createEntityCreateAction,
	createEntityGetAction,
	createEntityQueryAction,
	createEntityUpdateAction,
	createEntityDeleteAction,
	createEntityUpsertAction,
} from "./entities/singleOps.js";
import {
	createEntityUnmergeAction,
	type EntityUnmergeDeps,
	isEntityUnmergeDeps,
} from "./entities/unmerge.js";
import {
	createEntityPromoteEdgeAction,
	type EntityPromoteEdgeDeps,
	type EntityPromoteEdgeRepository,
} from "./entities/promoteEdge.js";
import {
	createEntityRelateAction,
	type EntityRelateDeps,
	type EntityRelateRepository,
} from "./entities/relate.js";
import {
	createArtifactSyncEntitiesAction,
	type ArtifactSyncDeps,
} from "./entities/artifactSync.js";
import {
	createLinkCreateAction,
	createLinkDeleteAction,
	createLinkGetAction,
	createLinkQueryAction,
	createLinkUpsertAction,
} from "./entities/links.js";
import type { GraphReadPort } from "../ports/graphRead.js";
import { createEntityNeighbourhoodAction } from "./entities/neighbourhood.js";
import { createHotTierCandidatesAction } from "./entities/hotTierCandidates.js";
import type { PeopleRepository } from "../ports/people.js";
import { createPersonCreateAction } from "./people/create.js";
import { createPersonDeleteAction } from "./people/delete.js";
import { createPersonGetAction } from "./people/get.js";
import { createPersonMatchAction } from "./people/match.js";
import { isPeopleWriteDeps, type PeopleWriteDeps } from "./people/personFields.js";
import { createPersonQueryAction } from "./people/query.js";
import { createPersonSelfAction } from "./people/self.js";
import { createPersonUpdateAction } from "./people/update.js";
import { createPersonUpsertAction } from "./people/upsert.js";
import type {
	NotionAutomationPort,
	DriveDiscoverPort,
} from "../ports/webhookWork.js";
import { createNotionCompletedAtStampAction } from "./webhooks/notionCompletedAtStamp.js";
import { createDriveDiscoverSweepAction } from "./webhooks/driveDiscoverSweep.js";
import type { ConfigPreferencesRepository } from "../ports/config.js";
import { createIntegrationListAction } from "./config/integrationList.js";
import { createIntegrationSetAction } from "./config/integrationSet.js";
import { createNotionConfigGetAction } from "./config/notionConfigGet.js";
import { createConfigCaptureGetAction } from "./config/captureGet.js";
import { createConfigPreferencesGetAction } from "./config/preferencesGet.js";
import { createConfigPreferencesUpdateAction } from "./config/preferencesUpdate.js";
import { createDosConfigDriftAction } from "./dos/configDrift.js";
import { createDosConfigGetAction } from "./dos/configGet.js";
import {
	createDailyLogCreateAction,
	type DailyLogTwinLookup,
} from "./dos/dailyLogCreate.js";
import { createDosDailyLogQueueAction } from "./dos/dailyLogQueue.js";
import { createDosEvidenceAggregateAction } from "./dos/evidenceAggregate.js";
import { createDosSynthesisCoverageAction } from "./dos/synthesisCoverage.js";
import { createStateDocUpdateAction } from "./dos/stateDocUpdate.js";
import type { DoctorPort } from "../ports/doctor.js";
import { createAhosDoctorAction } from "./config/ahosDoctor.js";
import type { InstructionsActionPorts } from "./config/canonicalInstructions.js";
import { createInstructionsGetAction } from "./config/instructionsGet.js";
import { createInstructionsMarkPastedAction } from "./config/instructionsMarkPasted.js";
import type { VocabularyReadPort } from "../ports/vocabulary.js";
import { createGraphExportRdfAction } from "./entities/graphExportRdf.js";
import type { SchemaIntrospectionPort } from "../ports/schema.js";
import { createStoreSchemaAction } from "./artifacts/storeSchema.js";
import type { BindingRepository } from "../ports/bindings.js";
import { createBindingCreateAction } from "./bindings/create.js";
import { createBindingDeleteAction } from "./bindings/delete.js";
import { createBindingListAction } from "./bindings/list.js";
import { createBindingUpdateAction } from "./bindings/update.js";
import type { McpPassthroughPort } from "../ports/mcpPassthrough.js";
import {
	createBrevoCallToolAction,
	createBrevoListToolsAction,
} from "./passthrough/brevo.js";
import {
	createDexCallToolAction,
	createDexListToolsAction,
} from "./passthrough/dex.js";
import {
	createMetaAdsCallToolAction,
	createMetaAdsListToolsAction,
} from "./passthrough/metaAds.js";
import { calendarConfigSchema } from "../domain/integrations.js";
import type { CalendarPort } from "../ports/calendar.js";
import { createCalendarDeleteEventAction } from "./calendar/deleteEvent.js";
import {
	createEventCreateAction,
	type EventCreatePorts,
} from "./calendar/eventCreate.js";
import { createCalendarGetEventAction } from "./calendar/getEvent.js";
import { createCalendarListEventsAction } from "./calendar/listEvents.js";
import { createCalendarRespondToEventAction } from "./calendar/respondToEvent.js";
import { createCalendarUpdateEventAction } from "./calendar/updateEvent.js";
import type { CapabilityActionPorts } from "./capabilities/shared.js";
import { createCapabilityGetAction } from "./capabilities/get.js";
import { createCapabilityRegisterAction } from "./capabilities/register.js";
import { createCapabilityResolveAction } from "./capabilities/resolve.js";
import type { PlanningPort } from "../ports/planning.js";
import { createPlanningEditAction } from "./planning/edit.js";
import { createPlanningReadAction } from "./planning/read.js";
import type { PostHogPort } from "../ports/posthog.js";
import { createPosthogConnectionsAction } from "./posthog/connections.js";
import { createPosthogProjectFilterAction } from "./posthog/projectFilter.js";
import { createPosthogQueryAction } from "./posthog/query.js";
import { createPosthogQueryDebugAction } from "./posthog/queryDebug.js";
import { createPosthogWriteAction } from "./posthog/write.js";
import type { RevenueCatPort } from "../ports/revenuecat.js";
import { createRevenueCatGetMetricsAction } from "./revenuecat/getMetrics.js";
import { createSheetsReadAction, type SheetsReadPort } from "./sheets/read.js";
import { createSheetsWriteAction, type SheetsWritePort } from "./sheets/write.js";
import type { BigQueryPort } from "../ports/bigquery.js";
import { createBigqueryQueryAction } from "./bigquery/query.js";
import {
	createGmailPriorityTriageAction,
	type GmailPriorityTriagePort,
} from "./google/gmailPriorityTriage.js";
import { createGmailTriageMetricsAction } from "./google/gmailTriageMetrics.js";
import type { GmailTriageMetricsPort } from "../ports/emailMetrics.js";
import {
	createGmailUnsubscribeBatchAction,
	type GmailUnsubscribeBatchPort,
} from "./google/gmailUnsubscribeBatch.js";
import {
	createGmailAttachmentToDriveAction,
	type GmailAttachmentToDrivePort,
} from "./google/gmailAttachmentToDrive.js";
import type { GmailPort } from "../ports/gmail.js";
import type { GmailReconcileStore } from "../ports/gmailReconcile.js";
import { createGmailDraftAction } from "./gmail/draft.js";
import { createGmailLabelsAction } from "./gmail/labels.js";
import { createGmailModifyAction } from "./gmail/modify.js";
import { createGmailReadAction } from "./gmail/read.js";
import { createGmailReconcileAction } from "./gmail/reconcile.js";
import { createGmailSearchAction } from "./gmail/search.js";
import { createGmailSendDraftAction } from "./gmail/sendDraft.js";
import type { LedgerReadPort } from "../ports/ledger.js";
import { createClientActionRecordAction } from "./ledger/clientActionRecord.js";
import { createLedgerQueryAction } from "./ledger/ledgerQuery.js";
import type { WhatsappPort } from "../ports/whatsapp.js";
import {
	createWhatsappIngestAction,
	createWhatsappListChatsAction,
	createWhatsappReadMessagesAction,
	createWhatsappStatusAction,
} from "./whatsapp/index.js";
import {
	createDriveHygieneHealAction,
	createWeeklyKpiSnapshotAction,
} from "./metrics/index.js";
import type { DrivePort, LocalFileReader } from "../ports/drive.js";
import type { DriveChangesPort, DriveWatchPorts } from "../ports/driveWatch.js";
import { createEntityDeriveSweepAction } from "./engine/deriveSweep.js";
import { createDriveWatchRenewAction } from "./engine/driveWatchRenew.js";
import { createDriveChangesListAction } from "./drive/changesList.js";
import { createDriveCommentGetAction, createDriveCommentListAction } from "./drive/commentRead.js";
import {
	createDriveCommentCreateAction,
	createDriveCommentDeleteAction,
	createDriveCommentReplyAction,
	createDriveCommentUpdateAction,
} from "./drive/commentWrite.js";
import {
	createDriveAboutAction,
	createDriveGetMetadataAction,
	createDriveListPermissionsAction,
} from "./drive/metadata.js";
import { createDriveReadFileAction } from "./drive/readFile.js";
import {
	createDriveListAction,
	createDriveSearchAction,
} from "./drive/list.js";
import {
	createDriveCopyAction,
	createDriveCreateFolderAction,
} from "./drive/createAndCopy.js";
import {
	createDriveDeleteAction,
	createDriveUnshareAction,
} from "./drive/deleteAndUnshare.js";
import { createDriveExportAction } from "./drive/export.js";
import {
	createDriveImportFileAction,
	type DriveImportFilePorts,
} from "./drive/importFile.js";
import {
	createIngestDriveAction,
	type IngestDrivePorts,
} from "./drive/ingest.js";
import { createDriveMoveAction } from "./drive/move.js";
import {
	createDriveRenameAction,
	createDriveTrashAction,
} from "./drive/renameAndTrash.js";
import {
	createDriveRevisionDeleteAction,
	createDriveRevisionGetAction,
	createDriveRevisionKeepAction,
	createDriveRevisionListAction,
} from "./drive/revisions.js";
import { createDriveShareAction } from "./drive/share.js";
import {
	createDriveUpdateContentAction,
	createDriveUploadFileAction,
} from "./drive/uploadFile.js";
import type { OneDrivePort } from "../ports/onedrive.js";
import type { DocsPort } from "../ports/docs.js";
import { createDocsAppendAction } from "./docs/append.js";
import { createDocsBatchUpdateAction } from "./docs/batchUpdate.js";
import { createDocsCommentsAction } from "./docs/comments.js";
import { createDocsGetAction } from "./docs/get.js";
import { createDocsFindTextAction } from "./docs/findText.js";
import { createDocsReplaceTextAction } from "./docs/replaceText.js";
import type { AppsScriptPort } from "../ports/appsscript.js";
import { createAppsscriptCreateDeploymentAction } from "./appsscript/createDeployment.js";
import { createAppsscriptCreateProjectAction } from "./appsscript/createProject.js";
import { createAppsscriptCreateVersionAction } from "./appsscript/createVersion.js";
import { createAppsscriptUpdateContentAction } from "./appsscript/updateContent.js";
import { createAppsscriptListProjectsAction } from "./appsscript/listProjects.js";
import { createAppsscriptGetProjectAction } from "./appsscript/getProject.js";
import { createAppsscriptGetContentAction } from "./appsscript/getContent.js";
import { createAppsscriptListVersionsAction } from "./appsscript/listVersions.js";
import { createAppsscriptListDeploymentsAction } from "./appsscript/listDeployments.js";
import { createAppsscriptRunFunctionAction } from "./appsscript/runFunction.js";
import type { SlackPort, SlackPostPort, SlackReadPort, SlackWritePort } from "../ports/slack.js";
import { createSlackPostAction } from "./slack/post.js";
import {
	createSlackReadChannelAction,
	createSlackReadThreadAction,
	createSlackSearchAction,
} from "./slack/slackRead.js";
import {
	createSlackMessageDeleteAction,
	createSlackMessageUpdateAction,
	createSlackReactionAddAction,
} from "./slack/write.js";
import {
	createDriveFolderCollisionAuditAction,
	createGdriveCopyToOnedriveAction,
	createOnedriveAuditVsGdriveAction,
	createOnedriveCopyToGdriveAction,
	createOnedriveCreateFolderAction,
	createOnedriveDeleteAction,
	createOnedriveGetMetadataAction,
	createOnedriveGetQuotaAction,
	createOnedriveListAction,
	createOnedriveMoveAction,
	createOnedriveReadFileAction,
	createOnedriveRenameAction,
	createOnedriveSearchAction,
	createOnedriveUploadFileAction,
} from "./onedrive/index.js";
import { z } from "zod";
import {
	actionResolver,
	executeApproved,
	rejectApproval,
	type ActionLookup,
	type ApprovedRunner,
	type CallableApprovedRunner,
	type ExecuteApprovedResult,
} from "./approvals.js";
import { defineAction } from "./defineAction.js";
import {
	getActionApprovalStore,
	type ApprovalInboxStore,
	type PendingApprovalInboxRow,
} from "./gate.js";
import { ActionRegistry } from "./registry.js";
import type { ActionContext, ActionDefinition } from "./types.js";

export const APPROVAL_ACTION_IDS: ReadonlySet<string> = new Set([
	"approval_list",
	"approval_approve",
	"approval_reject",
]);

export function createInboxActionResolver(
	lookup: ActionLookup,
): (actionId: string) => CallableApprovedRunner | undefined {
	const baseResolve = actionResolver(lookup);
	return (actionId: string): CallableApprovedRunner | undefined => {
		if (APPROVAL_ACTION_IDS.has(actionId)) return undefined;
		return baseResolve(actionId);
	};
}

export interface CreateApprovalActionsDeps {
	getStore: () => ApprovalInboxStore | undefined;
	resolve: (actionId: string) => ApprovedRunner | undefined;
}

const OWNER_ONLY_APPROVAL_EXPOSE = {
	mcp: false,
	http: true,
	ui_agent: false,
	worker: false,
	reason: "owner_only" as const,
	note: "releasing a parked call is a human act (ADR-104 the owner approval gate rule for outward calls)",
};

function requireOwnerWebInbox(
	ctx: ActionContext,
	getStore: () => ApprovalInboxStore | undefined,
): { userId: string; store: ApprovalInboxStore } {
	if (ctx.caller !== "ui" || !ctx.userId) {
		throw Object.assign(
			new Error("approval actions run only from the owner's web session"),
			{ status: 403 },
		);
	}
	const store = getStore();
	if (!store) {
		throw Object.assign(new Error("no approval store is configured"), {
			status: 503,
		});
	}
	return { userId: ctx.userId, store };
}

export type ApprovalActions = [
	ActionDefinition<any, any>,
	ActionDefinition<any, any>,
	ActionDefinition<any, any>,
] & {
	approval_list: ActionDefinition<any, { approvals: PendingApprovalInboxRow[] }>;
	approval_approve: ActionDefinition<any, ExecuteApprovedResult>;
	approval_reject: ActionDefinition<any, { status: "rejected"; decision_id: string }>;
	list: ActionDefinition<any, { approvals: PendingApprovalInboxRow[] }>;
	approve: ActionDefinition<any, ExecuteApprovedResult>;
	reject: ActionDefinition<any, { status: "rejected"; decision_id: string }>;
};

export function createApprovalActions({
	getStore,
	resolve,
}: CreateApprovalActionsDeps): ApprovalActions {
	const approval_list = defineAction({
		id: "approval_list",
		description:
			"List pending outward action calls parked for owner approval in the web inbox.",
		domain: "governance",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		expose: OWNER_ONLY_APPROVAL_EXPOSE,
		schema: z
			.object({
				limit: z.number().int().min(1).max(100).default(50),
			})
			.strict(),
		run: async (input, ctx) => {
			const { userId, store } = requireOwnerWebInbox(ctx, getStore);
			const approvals = await store.listPending(userId, input.limit ?? 50);
			return { approvals };
		},
	});

	const approval_approve = defineAction({
		id: "approval_approve",
		description:
			"Approve a pending outward action call from the owner's web inbox and execute it once.",
		domain: "governance",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		expose: OWNER_ONLY_APPROVAL_EXPOSE,
		schema: z
			.object({
				decision_id: z.string().uuid(),
			})
			.strict(),
		run: async (input, ctx) => {
			const { userId, store } = requireOwnerWebInbox(ctx, getStore);
			return executeApproved(input.decision_id, {
				store,
				resolve,
				approvedBy: { userId, via: "web_inbox" },
			});
		},
	});

	const approval_reject = defineAction({
		id: "approval_reject",
		description:
			"Reject a pending outward action call from the owner's web inbox without running it.",
		domain: "governance",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		expose: OWNER_ONLY_APPROVAL_EXPOSE,
		schema: z
			.object({
				decision_id: z.string().uuid(),
				notes: z.string().max(500).optional(),
			})
			.strict(),
		run: async (input, ctx) => {
			const { userId, store } = requireOwnerWebInbox(ctx, getStore);
			return rejectApproval(input.decision_id, {
				store,
				userId,
				notes: input.notes,
			});
		},
	});

	return Object.assign(
		[approval_list, approval_approve, approval_reject] as [
			ActionDefinition<any, any>,
			ActionDefinition<any, any>,
			ActionDefinition<any, any>,
		],
		{
			approval_list,
			approval_approve,
			approval_reject,
			list: approval_list,
			approve: approval_approve,
			reject: approval_reject,
		},
	);
}

function getDefaultApprovalInboxStore(): ApprovalInboxStore | undefined {
	const store = getActionApprovalStore();
	if (store && typeof (store as ApprovalInboxStore).listPending === "function") {
		return store as ApprovalInboxStore;
	}
	return undefined;
}

/**
 * Error thrown when an action invocation requires an adapter that is not wired in the current process.
 */
export class AdapterUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdapterUnavailableError";
	}
}

/**
 * Stand-in proxy for unavailable adapters.
 * Intercepts property/method access and rejects at invocation time with AdapterUnavailableError.
 */
export function createUnavailableAdapterProxy<T extends object = any>(family: string): T {
	const handler: ProxyHandler<any> = {
		get(_target, prop) {
			if (prop === "then") return undefined;
			if (typeof prop === "symbol") return undefined;
			return new Proxy(
				(() => {
					throw new AdapterUnavailableError(`${family} adapter is not wired in this process`);
				}) as any,
				handler,
			);
		},
		has(_target, _prop) {
			return true;
		},
		apply() {
			throw new AdapterUnavailableError(`${family} adapter is not wired in this process`);
		},
	};

	return new Proxy(
		(() => {
			throw new AdapterUnavailableError(`${family} adapter is not wired in this process`);
		}) as any,
		handler,
	);
}

/**
 * Adapter families configurable when building the process ActionRegistry.
 */
export interface ActionAdapters {
	notion?: NotionPort;
	github?: GithubIssueActionDependencies | GithubIssuesPort;
	githubPulls?: GithubReviewActionDependencies | GithubPullsActionDependencies | GithubPullsPort;
	githubRead?: GithubReadActionDependencies;
	githubActivity?: GithubActivityPort;
	linkedin?: LinkedinPostActionDependencies | LinkedinPort;
	derive?: EntityDerivePorts;
	synthesize?: EntitySynthesizePorts;
	graph?: GraphNodeLevelActionDependencies;
	graphEdges?: GraphEdgePort | EntityPathDependencies;
	review?: ReviewPort;
	reviewLesson?: ReviewLessonActionDependencies;
	tasks?: TasksPort;
	taskRepository?: TaskRepository;
	artifacts?: ArtifactsPort;
	artifactRepository?: ArtifactRepository;
	embedBackfill?: ArtifactEmbedBackfillPorts;
	extraction?: TextExtractionPort | ArtifactExtractTextPorts;
	storage?: StoragePort;

	externalLinks?: ExternalLinkRepository & DailyLogTwinLookup;
	/**
	 * Strict existing-pointer read for `external_link_create`'s `daily_log` guard (#2313).
	 * Kept apart from `externalLinks` because the shared `getExternalLinks` answers `[]`
	 * on a query error; this one must throw. Unset, the guard refuses `daily_log` writes.
	 */
	externalLinkCreate?: ExternalLinkCreateGuardPort;
	relationships?: RelationshipsPort;
	entities?: EntitiesPort;
	entityRepository?:
		| EntityRepository
		| EntityPromoteEdgeRepository
		| EntityRelateRepository
		| DocumentResolveEntitiesPort
		| EntityPromoteEdgeDeps
		| EntityRelateDeps
		| {
				entities:
					| EntityRepository
					| (EntityPromoteEdgeRepository & DocumentResolveEntitiesPort)
					| EntityRelateRepository;
				embedEntity?: ArtifactSyncDeps["embedEntity"];
				ownerId?: string | (() => string | undefined);
		  };
	entityPromoteEdge?: EntityPromoteEdgeRepository | EntityPromoteEdgeDeps;
	entityMerge?: EntityMergePort | EntityUnmergeDeps;
	links?: LinkRepository;
	graphRead?: GraphReadPort;
	people?: PeopleRepository | PeopleWriteDeps;
	jobs?: JobQueuePort;
	notionAutomation?: NotionAutomationPort;
	driveDiscover?: DriveDiscoverPort;
	config?: ConfigPreferencesRepository;
	decisionRepository?: DecisionRepository;
	instructions?: InstructionsActionPorts;
	doctor?: DoctorPort;
	vocabulary?: VocabularyReadPort;
	schema?: SchemaIntrospectionPort;
	bindings?: BindingRepository;
	brevo?: McpPassthroughPort;
	dex?: McpPassthroughPort;
	metaAds?: McpPassthroughPort;
	calendar?: CalendarPort;
	eventCreate?: Partial<EventCreatePorts>;
	capabilities?: CapabilityActionPorts;
	planning?: PlanningPort;
	posthog?: PostHogPort;
	revenuecat?: RevenueCatPort;
	sheets?: SheetsReadPort & SheetsWritePort;
	bigquery?: BigQueryPort;
	gmail?: GmailPort;
	ownerAddresses?: () => Promise<ReadonlySet<string>>;
	gmailPriorityTriage?: GmailPriorityTriagePort;
	gmailTriageMetrics?: GmailTriageMetricsPort;
	gmailUnsubscribeBatch?: GmailUnsubscribeBatchPort;
	gmailAttachmentToDrive?: GmailAttachmentToDrivePort;
	gmailReconcileStore?: GmailReconcileStore;
	ledger?: LedgerReadPort;
	cleanState?: CleanStatePort;
	whatsapp?: WhatsappPort;
	drive?: DrivePort;
	driveImport?: Partial<DriveImportFilePorts>;
	driveIngest?: Partial<IngestDrivePorts>;
	readLocalFile?: LocalFileReader;
	docs?: DocsPort;
	appsscript?: AppsScriptPort;
	driveWatch?: DriveWatchPorts;
	driveChanges?: DriveChangesPort;
	onedrive?: OneDrivePort;
	slack?:
		| (SlackReadPort & Partial<SlackPort>)
		| (SlackPort & Partial<SlackReadPort>)
		| (SlackPostPort & Partial<SlackReadPort> & Partial<SlackPort>)
		| (SlackWritePort & Partial<SlackReadPort> & Partial<SlackPort> & Partial<SlackPostPort>);
	slackIngest?: SlackPort;
	slackPost?: SlackPostPort;
	slackWrites?: SlackWritePort;
	discover?: IngestDiscoverDeps | DiscoverRepository;
	search?: SearchPort | KnowledgeSearchPorts;
	approvals?: Partial<CreateApprovalActionsDeps>;
}

/**
 * Builds and populates the single ActionRegistry for a process (ADR-101 §3, ADR-105 R2).
 * Unwired adapter families are filled with stand-in proxies that throw AdapterUnavailableError
 * upon execution, ensuring every process holds the exact same registered action IDs.
 */
export function buildRegistry(adapters?: ActionAdapters): ActionRegistry {
	const registry = new ActionRegistry();

	const notionAdapter = adapters?.notion ?? createUnavailableAdapterProxy<NotionPort>("notion");
	const githubAdapter = adapters?.github ?? createUnavailableAdapterProxy<GithubIssueActionDependencies>("github");
	const githubPullsAdapter =
		adapters?.githubPulls ?? createUnavailableAdapterProxy<GithubPullsActionDependencies>("githubPulls");
	const githubReadAdapter =
		adapters?.githubRead ?? createUnavailableAdapterProxy<GithubReadActionDependencies>("githubRead");
	const githubActivityAdapter =
		adapters?.githubActivity ?? createUnavailableAdapterProxy<GithubActivityPort>("githubActivity");
	const linkedinAdapter = adapters?.linkedin ?? createUnavailableAdapterProxy<LinkedinPostActionDependencies>("linkedin");
	const deriveAdapter = adapters?.derive ?? createUnavailableAdapterProxy<EntityDerivePorts>("derive");
	const synthesizeAdapter = adapters?.synthesize ?? createUnavailableAdapterProxy<EntitySynthesizePorts>("synthesize");
	const graphAdapter = adapters?.graph ?? createUnavailableAdapterProxy<GraphNodeLevelActionDependencies>("graph");
	const graphEdgesAdapter =
		adapters?.graphEdges ?? createUnavailableAdapterProxy<GraphEdgePort>("graphEdges");
	const reviewAdapter = adapters?.review ?? createUnavailableAdapterProxy<ReviewPort>("review");
	const reviewLessonAdapter =
		adapters?.reviewLesson ?? createUnavailableAdapterProxy<ReviewLessonActionDependencies>("reviewLesson");
	const tasksAdapter = adapters?.tasks ?? createUnavailableAdapterProxy<TasksPort>("tasks");
	const taskRepoAdapter =
		adapters?.taskRepository ?? createUnavailableAdapterProxy<TaskRepository>("taskRepository");
	const artifactsAdapter = adapters?.artifacts ?? createUnavailableAdapterProxy<ArtifactsPort>("artifacts");
	const artifactRepoAdapter =
		adapters?.artifactRepository ??
		createUnavailableAdapterProxy<ArtifactRepository>("artifactRepository");
	const embedBackfillAdapter: ArtifactEmbedBackfillPorts =
		adapters?.embedBackfill ??
		createUnavailableAdapterProxy<ArtifactEmbedBackfillPorts>("embedBackfill");

	const storageAdapter =
		adapters?.storage ?? createUnavailableAdapterProxy<StoragePort>("storage");
	const externalLinksAdapter =
		adapters?.externalLinks ??
		createUnavailableAdapterProxy<ExternalLinkRepository & DailyLogTwinLookup>("externalLinks");
	const relationshipsAdapter = adapters?.relationships ?? createUnavailableAdapterProxy<RelationshipsPort>("relationships");
	const entitiesAdapter = adapters?.entities ?? createUnavailableAdapterProxy<EntitiesPort>("entities");
	const entityPromoteEdgeRaw = adapters?.entityPromoteEdge ?? adapters?.entityRepository;
	const entityPromoteEdgeAdapter: EntityPromoteEdgeDeps =
		entityPromoteEdgeRaw && "entities" in entityPromoteEdgeRaw
			? (entityPromoteEdgeRaw as EntityPromoteEdgeDeps)
			: {
					entities:
						(entityPromoteEdgeRaw as EntityPromoteEdgeRepository | undefined) ??
						createUnavailableAdapterProxy<EntityPromoteEdgeRepository>("entityRepository"),
				};
	const rawEntityRepo =
		adapters?.entityRepository && "entities" in adapters.entityRepository
			? adapters.entityRepository.entities
			: adapters?.entityRepository;
	const documentResolveEntitiesAdapter: DocumentResolveEntitiesPort =
		(rawEntityRepo as DocumentResolveEntitiesPort | undefined) ??
		createUnavailableAdapterProxy<DocumentResolveEntitiesPort>("entityRepository");
	const entityRepoAdapter: EntityRepository =
		(rawEntityRepo as EntityRepository | undefined) ??
		createUnavailableAdapterProxy<EntityRepository>("entityRepository");
	const entityRelateAdapter: EntityRelateDeps =
		adapters?.entityRepository &&
		Object.prototype.hasOwnProperty.call(adapters.entityRepository, "entities")
			? (adapters.entityRepository as EntityRelateDeps)
			: {
					entities:
						(adapters?.entityRepository as EntityRelateRepository | undefined) ??
						createUnavailableAdapterProxy<EntityRelateRepository>("entityRepository"),
				};
	const entityMergeAdapter: EntityUnmergeDeps =
		adapters?.entityMerge && isEntityUnmergeDeps(adapters.entityMerge)
			? adapters.entityMerge
			: {
					merge:
						(adapters?.entityMerge as EntityMergePort | undefined) ??
						createUnavailableAdapterProxy<EntityMergePort>("entityMerge"),
				};
	const linksAdapter = adapters?.links ?? createUnavailableAdapterProxy<LinkRepository>("links");
	const graphReadAdapter = adapters?.graphRead ?? createUnavailableAdapterProxy<GraphReadPort>("graphRead");
	const peopleWriteAdapter: PeopleWriteDeps =
		adapters?.people && isPeopleWriteDeps(adapters.people)
			? adapters.people
			: {
					people:
						(adapters?.people as PeopleRepository | undefined) ??
						createUnavailableAdapterProxy<PeopleRepository>("people"),
				};
	const peopleAdapter = peopleWriteAdapter.people as PeopleRepository;
	const jobsAdapter = adapters?.jobs ?? createUnavailableAdapterProxy<JobQueuePort>("jobs");
	const notionAutomationAdapter =
		adapters?.notionAutomation ?? createUnavailableAdapterProxy<NotionAutomationPort>("notionAutomation");
	const driveDiscoverAdapter =
		adapters?.driveDiscover ?? createUnavailableAdapterProxy<DriveDiscoverPort>("driveDiscover");
	const configAdapter = adapters?.config ?? createUnavailableAdapterProxy<ConfigPreferencesRepository>("config");
	const doctorAdapter = adapters?.doctor ?? createUnavailableAdapterProxy<DoctorPort>("doctor");
	const vocabularyAdapter = adapters?.vocabulary ?? createUnavailableAdapterProxy<VocabularyReadPort>("vocabulary");
	const schemaAdapter = adapters?.schema ?? createUnavailableAdapterProxy<SchemaIntrospectionPort>("schema");
	const bindingsAdapter = adapters?.bindings ?? createUnavailableAdapterProxy<BindingRepository>("bindings");
	const brevoAdapter =
		adapters?.brevo ?? createUnavailableAdapterProxy<McpPassthroughPort>("brevo");
	const dexAdapter =
		adapters?.dex ?? createUnavailableAdapterProxy<McpPassthroughPort>("dex");
	const metaAdsAdapter =
		adapters?.metaAds ?? createUnavailableAdapterProxy<McpPassthroughPort>("metaAds");
	const calendarAdapter = adapters?.calendar ?? createUnavailableAdapterProxy<CalendarPort>("calendar");
	const capabilitiesAdapter =
		adapters?.capabilities ?? createUnavailableAdapterProxy<CapabilityActionPorts>("capabilities");
	const planningAdapter =
		adapters?.planning ?? createUnavailableAdapterProxy<PlanningPort>("planning");
	const posthogAdapter =
		adapters?.posthog ?? createUnavailableAdapterProxy<PostHogPort>("posthog");
	const revenuecatAdapter = adapters?.revenuecat ?? createUnavailableAdapterProxy<RevenueCatPort>("revenuecat");
	const sheetsAdapter =
		adapters?.sheets ?? createUnavailableAdapterProxy<SheetsReadPort & SheetsWritePort>("sheets");
	const bigqueryAdapter = adapters?.bigquery ?? createUnavailableAdapterProxy<BigQueryPort>("bigquery");
	const gmailAdapter = adapters?.gmail ?? createUnavailableAdapterProxy<GmailPort>("gmail");
	const gmailPriorityTriageAdapter =
		adapters?.gmailPriorityTriage ??
		createUnavailableAdapterProxy<GmailPriorityTriagePort>("gmailPriorityTriage");
	const gmailTriageMetricsAdapter =
		adapters?.gmailTriageMetrics ??
		createUnavailableAdapterProxy<GmailTriageMetricsPort>("gmailTriageMetrics");
	const gmailUnsubscribeBatchAdapter =
		adapters?.gmailUnsubscribeBatch ??
		adapters?.gmailPriorityTriage ??
		createUnavailableAdapterProxy<GmailUnsubscribeBatchPort>("gmailUnsubscribeBatch");
	const gmailAttachmentToDriveAdapter =
		adapters?.gmailAttachmentToDrive ??
		createUnavailableAdapterProxy<GmailAttachmentToDrivePort>("gmailAttachmentToDrive");
	const gmailReconcileStoreAdapter =
		adapters?.gmailReconcileStore ??
		createUnavailableAdapterProxy<GmailReconcileStore>("gmailReconcileStore");
	const ledgerAdapter = adapters?.ledger ?? createUnavailableAdapterProxy<LedgerReadPort>("ledger");
	const cleanStateAdapter = adapters?.cleanState ?? createUnavailableAdapterProxy<CleanStatePort>("cleanState");
	const whatsappAdapter = adapters?.whatsapp ?? createUnavailableAdapterProxy<WhatsappPort>("whatsapp");
	const driveAdapter = adapters?.drive ?? createUnavailableAdapterProxy<DrivePort>("drive");
	const docsAdapter = adapters?.docs ?? createUnavailableAdapterProxy<DocsPort>("docs");
	const appsscriptAdapter =
		adapters?.appsscript ?? createUnavailableAdapterProxy<AppsScriptPort>("appsscript");
	const driveWatchAdapter =
		adapters?.driveWatch ?? createUnavailableAdapterProxy<DriveWatchPorts>("driveWatch");
	const driveChangesAdapter: DriveChangesPort =
		adapters?.driveChanges ??
		(adapters?.driveWatch?.listChanges
			? {
					listChanges: adapters.driveWatch.listChanges.bind(adapters.driveWatch),
					getStartPageToken: adapters.driveWatch.getStartPageToken?.bind(adapters.driveWatch),
				}
			: createUnavailableAdapterProxy<DriveChangesPort>("driveChanges"));
	const onedriveAdapter = adapters?.onedrive ?? createUnavailableAdapterProxy<OneDrivePort>("onedrive");
	const onedriveBridgePorts = { onedrive: onedriveAdapter, drive: driveAdapter };
	const slackAdapter =
		(adapters?.slack as (SlackReadPort & SlackPort) | undefined) ??
		createUnavailableAdapterProxy<SlackReadPort & SlackPort>("slack");
	const slackIngestAdapter =
		adapters?.slackIngest ??
		(adapters?.slack && typeof (adapters.slack as SlackPort).viewer === "function"
			? (adapters.slack as SlackPort)
			: createUnavailableAdapterProxy<SlackPort>("slack"));
	const slackPostAdapter: SlackPostPort =
		adapters?.slackPost ??
		(adapters?.slack && typeof (adapters.slack as SlackPostPort).postMessage === "function"
			? (adapters.slack as SlackPostPort)
			: createUnavailableAdapterProxy<SlackPostPort>("slack"));
	const slackWritesAdapter: SlackWritePort =
		adapters?.slackWrites ??
		(adapters?.slack && typeof (adapters.slack as SlackWritePort).updateMessage === "function"
			? (adapters.slack as SlackWritePort)
			: createUnavailableAdapterProxy<SlackWritePort>("slackWrites"));
	const discoverAdapter: IngestDiscoverDeps =
		adapters?.discover &&
		("repo" in adapters.discover || "discover" in adapters.discover)
			? (adapters.discover as IngestDiscoverDeps)
			: {
					repo:
						(adapters?.discover as DiscoverRepository | undefined) ??
						createUnavailableAdapterProxy<DiscoverRepository>("discover"),
				};
	const searchPorts: KnowledgeSearchPorts =
		adapters?.search && "search" in adapters.search
			? {
					config: configAdapter,
					...adapters.search,
				}
			: {
					search:
						(adapters?.search as SearchPort | undefined) ??
						createUnavailableAdapterProxy<SearchPort>("search"),
					config: configAdapter,
				};

	const defaultToolCatalog = () =>
		registry
			.list()
			.filter((a) => a.expose?.mcp !== false)
			.map((a) => ({ name: a.id, description: a.description }));
	const instructionsPorts: InstructionsActionPorts = {
		config: configAdapter,
		toolCatalog: defaultToolCatalog,
		...adapters?.instructions,
	};

	const approvalActions = createApprovalActions({
		getStore: adapters?.approvals?.getStore ?? getDefaultApprovalInboxStore,
		resolve: adapters?.approvals?.resolve ?? createInboxActionResolver(registry),
	});

	registry.register(createAhosDoctorAction(doctorAdapter));
	registry.register(approvalActions.approval_approve);
	registry.register(approvalActions.approval_list);
	registry.register(approvalActions.approval_reject);
	registry.register(createAppsscriptCreateDeploymentAction(appsscriptAdapter));
	registry.register(createAppsscriptCreateProjectAction(appsscriptAdapter));
	registry.register(createAppsscriptCreateVersionAction(appsscriptAdapter));
	registry.register(createAppsscriptGetContentAction(appsscriptAdapter));
	registry.register(createAppsscriptGetProjectAction(appsscriptAdapter));
	registry.register(createAppsscriptListDeploymentsAction(appsscriptAdapter));
	registry.register(createAppsscriptListProjectsAction(appsscriptAdapter));
	registry.register(createAppsscriptListVersionsAction(appsscriptAdapter));
	registry.register(createAppsscriptRunFunctionAction(appsscriptAdapter));
	registry.register(createAppsscriptUpdateContentAction(appsscriptAdapter));
	registry.register(createArtifactDeleteAction(artifactRepoAdapter));
	registry.register(createArtifactEmbedBackfillAction(embedBackfillAdapter));
	const extractionPorts: ArtifactExtractTextPorts =
		adapters?.extraction && "extraction" in adapters.extraction
			? adapters.extraction
			: {
					artifacts: artifactRepoAdapter,
					storage: storageAdapter,
					extraction:
						(adapters?.extraction as TextExtractionPort | undefined) ??
						createUnavailableAdapterProxy<TextExtractionPort>("extraction"),
				};
	registry.register(createArtifactExtractTextAction(extractionPorts));
	registry.register(
		createArtifactGetAction({
			artifacts: artifactRepoAdapter,
			externalLinks: externalLinksAdapter,
			config: configAdapter,
		}),
	);

	registry.register(
		createArtifactGetFileAction({
			artifacts: artifactRepoAdapter,
			externalLinks: externalLinksAdapter,
			config: configAdapter,
			storage: storageAdapter,
		}),
	);
	registry.register(
		createArtifactSyncEntitiesAction({
			entities: entityRepoAdapter,
			links: linksAdapter,
			embedEntity:
				adapters?.entityRepository &&
				"embedEntity" in adapters.entityRepository &&
				typeof adapters.entityRepository.embedEntity === "function"
					? adapters.entityRepository.embedEntity
					: undefined,
		}),
	);
	registry.register(createArtifactUpdateAction(artifactRepoAdapter));
	registry.register(createBigqueryQueryAction(bigqueryAdapter));
	registry.register(createBindingCreateAction(bindingsAdapter));
	registry.register(createBindingDeleteAction(bindingsAdapter));
	registry.register(createBindingListAction(bindingsAdapter));
	registry.register(createBindingUpdateAction(bindingsAdapter));
	registry.register(createBrevoCallToolAction(brevoAdapter));
	registry.register(createBrevoListToolsAction(brevoAdapter));
	registry.register(
		createCalendarDeleteEventAction({
			calendar: calendarAdapter,
			ownerAddresses: adapters?.ownerAddresses,
		}),
	);
	registry.register(createCalendarGetEventAction(calendarAdapter));
	registry.register(createCalendarListEventsAction(calendarAdapter));
	registry.register(createCalendarRespondToEventAction(calendarAdapter));
	registry.register(createCalendarUpdateEventAction(calendarAdapter));
	registry.register(createCapabilityGetAction(capabilitiesAdapter));
	registry.register(createCapabilityRegisterAction(capabilitiesAdapter));
	registry.register(
		createCapabilityResolveAction({
			capabilities: capabilitiesAdapter,
			bindings: bindingsAdapter,
		}),
	);
	registry.register(createCaptureAction(artifactsAdapter));
	registry.register(createCleanStateCheckAction(cleanStateAdapter));
	registry.register(
		createClientActionRecordAction({
			isClientLocalAction: (id) => registry.get(id)?.expose?.reason === "client_local",
		}),
	);
	registry.register(
		createCommunicationCreateAction({
			notion: notionAdapter,
			externalLinks: externalLinksAdapter,
			config: configAdapter,
		}),
	);
	registry.register(createConfigCaptureGetAction(configAdapter));
	registry.register(createConfigPreferencesGetAction(configAdapter));
	registry.register(createConfigPreferencesUpdateAction(configAdapter));
	registry.register(createContactCreateAction(notionAdapter));
	registry.register(createCreateTaskAction(tasksAdapter));
	registry.register(
		createDailyLogCreateAction({
			notion: notionAdapter,
			config: configAdapter,
			externalLinks: externalLinksAdapter,
			// Used only under `write_twin: true` (#2258). The same three adapters capture,
			// external_link_create and artifact_delete are built on, so the server wires
			// nothing new; an unwired one rejects and the reply says `twin: MISSING`.
			twin: {
				capture: artifactsAdapter,
				links: externalLinksAdapter,
				artifacts: artifactRepoAdapter,
			},
		}),
	);
	registry.register(createDecisionReviewAction(reviewAdapter));
	registry.register(createDexCallToolAction(dexAdapter));
	registry.register(createDexListToolsAction(dexAdapter));
	registry.register(
		createDocsBatchUpdateAction({
			docs: docsAdapter,
			artifacts: artifactRepoAdapter,
		}),
	);
	registry.register(createDocsReplaceTextAction({ docs: docsAdapter, artifacts: artifactRepoAdapter }));
	registry.register(createDocsAppendAction({ docs: docsAdapter, artifacts: artifactRepoAdapter }));
	registry.register(createDocsCommentsAction(driveAdapter));
	registry.register(createDocsFindTextAction(docsAdapter));
	registry.register(createDocsGetAction(docsAdapter));
	registry.register(
		createDocumentDuplicatesAction(artifactsAdapter, {
			formatMcp: formatDocumentDuplicatesMcp,
		}),
	);
	registry.register(
		createDocumentResolveAction({
			artifacts: artifactRepoAdapter,
			entities: documentResolveEntitiesAdapter,
		}),
	);
	registry.register(
		createDosConfigDriftAction({
			notion: notionAdapter,
			config: configAdapter,
		}),
	);
	registry.register(createDosConfigGetAction(configAdapter));
	registry.register(createDosDailyLogQueueAction(externalLinksAdapter));
	registry.register(
		createDosEvidenceAggregateAction({
			externalLinks: externalLinksAdapter,
			config: configAdapter,
		}),
	);
	registry.register(createDosSynthesisCoverageAction(externalLinksAdapter));
	registry.register(createDriveAboutAction(driveAdapter));
	registry.register(createDriveChangesListAction(driveChangesAdapter));
	registry.register(createDriveCommentCreateAction(driveAdapter));
	registry.register(createDriveCommentDeleteAction(driveAdapter));
	registry.register(createDriveCommentGetAction(driveAdapter));
	registry.register(createDriveCommentListAction(driveAdapter));
	registry.register(createDriveCommentReplyAction(driveAdapter));
	registry.register(createDriveCommentUpdateAction(driveAdapter));
	registry.register(createDriveCopyAction(driveAdapter));
	registry.register(createDriveCreateFolderAction(driveAdapter));
	registry.register(createDriveDeleteAction(driveAdapter));
	registry.register(createDriveDiscoverSweepAction(driveDiscoverAdapter));
	registry.register(createDriveExportAction(driveAdapter));
	registry.register(createDriveFolderCollisionAuditAction(onedriveBridgePorts));
	registry.register(createDriveGetMetadataAction(driveAdapter));
	registry.register(createDriveHygieneHealAction(onedriveBridgePorts));
	registry.register(
		createDriveImportFileAction({
			drive: driveAdapter,
			artifacts: artifactRepoAdapter,
			storage: storageAdapter,
			...adapters?.driveImport,
		}),
	);
	registry.register(createDriveListAction(driveAdapter));
	registry.register(createDriveListPermissionsAction(driveAdapter));
	registry.register(createDriveMoveAction(driveAdapter));
	registry.register(createDriveReadFileAction(driveAdapter));
	registry.register(createDriveRenameAction(driveAdapter));
	registry.register(createDriveRevisionDeleteAction(driveAdapter));
	registry.register(createDriveRevisionGetAction(driveAdapter));
	registry.register(createDriveRevisionKeepAction(driveAdapter));
	registry.register(createDriveRevisionListAction(driveAdapter));
	registry.register(createDriveSearchAction(driveAdapter));
	registry.register(createDriveShareAction(driveAdapter));
	registry.register(createDriveTrashAction(driveAdapter));
	registry.register(createDriveUnshareAction(driveAdapter));
	registry.register(createDriveUpdateContentAction(driveAdapter));
	registry.register(
		createDriveUploadFileAction({
			drive: driveAdapter,
			readLocalFile: adapters?.readLocalFile ?? adapters?.drive?.readLocalFile,
		}),
	);
	registry.register(createDriveWatchRenewAction(driveWatchAdapter));
	registry.register(createEntityBulkDeleteAction(entitiesAdapter));
	registry.register(createEntityCreateAction(entitiesAdapter));
	registry.register(createEntityCrudAction(entitiesAdapter));
	registry.register(createEntityDeleteAction(entitiesAdapter));
	registry.register(createEntityDeriveAction(deriveAdapter));
	registry.register(createEntityDeriveNextAction(jobsAdapter));
	registry.register(createEntityDeriveSweepAction(deriveAdapter));
	registry.register(createEntityGetAction(entitiesAdapter));
	registry.register(createEntityNeighbourhoodAction(graphReadAdapter));
	registry.register(createEntityPathAction(graphEdgesAdapter));
	registry.register(createEntityPromoteEdgeAction(entityPromoteEdgeAdapter));
	registry.register(createEntityQueryAction(entitiesAdapter));
	registry.register(createEntityRelateAction(entityRelateAdapter));
	registry.register(createEntitySynthesizeAction(synthesizeAdapter));
	registry.register(createEntityUnmergeAction(entityMergeAdapter));
	registry.register(createEntityUpdateAction(entitiesAdapter));
	registry.register(createEntityUpsertAction(entitiesAdapter));
	registry.register(
		createEventCreateAction({
			calendar: calendarAdapter,
			artifacts: artifactRepoAdapter,
			storage: storageAdapter,
			externalLinks: externalLinksAdapter,
			resolveTargetCalendar: async () => {
				const cfg = await configAdapter.loadConfig("google_calendar", calendarConfigSchema);
				return cfg?.calendar_id ?? null;
			},
			...adapters?.eventCreate,
		}),
	);
	registry.register(
		createExternalLinkCreateAction(externalLinksAdapter, adapters?.externalLinkCreate),
	);
	registry.register(createGdriveCopyToOnedriveAction(onedriveBridgePorts));
	registry.register(createGithubBranchDeleteAction(githubPullsAdapter));
	registry.register(createGithubBranchGetAction(githubReadAdapter));
	registry.register(createGithubCommentCreateAction(githubAdapter));
	registry.register(createGithubDirListAction(githubReadAdapter));
	registry.register(createGithubFileGetAction(githubReadAdapter));
	registry.register(createGithubIssueCommentListAction(githubReadAdapter));
	registry.register(createGithubIssueAction(githubAdapter));
	registry.register(createGithubIssueGetAction(githubReadAdapter));
	registry.register(createGithubIssueSearchAction(githubReadAdapter));
	registry.register(createGithubIssueTimelineAction(githubReadAdapter));
	registry.register(createGithubJobLogGetAction(githubReadAdapter));
	registry.register(createGithubLabelAddAction(githubAdapter));
	registry.register(createGithubLabelRemoveAction(githubAdapter));
	registry.register(createGithubPrCloseAction(githubPullsAdapter));
	registry.register(createGithubPrCommitListAction(githubReadAdapter));
	registry.register(createGithubPrCreateAction(githubPullsAdapter));
	registry.register(createGithubPrDiffAction(githubReadAdapter));
	registry.register(createGithubPrFileListAction(githubReadAdapter));
	registry.register(createGithubPrGetAction(githubReadAdapter));
	registry.register(createGithubPrListAction(githubReadAdapter));
	registry.register(createGithubPrMergeabilityAction(githubReadAdapter));
	registry.register(createGithubPrReviewListAction(githubReadAdapter));
	registry.register(createGithubPrUpdateAction(githubPullsAdapter));
	registry.register(createGithubRepoGetAction(githubReadAdapter));
	registry.register(createGithubReviewCreateAction(githubPullsAdapter));
	registry.register(createGithubRunJobListAction(githubReadAdapter));
	registry.register(createGithubRunListAction(githubReadAdapter));
	registry.register(createGmailAttachmentToDriveAction(gmailAttachmentToDriveAdapter));
	registry.register(createGmailDraftAction(gmailAdapter));
	registry.register(createGmailLabelsAction(gmailAdapter));
	registry.register(createGmailModifyAction(gmailAdapter));
	registry.register(createGmailPriorityTriageAction(gmailPriorityTriageAdapter));
	registry.register(createGmailReadAction(gmailAdapter));
	registry.register(
		createGmailReconcileAction({
			gmail: gmailAdapter,
			notion: notionAdapter,
			store: gmailReconcileStoreAdapter,
		}),
	);
	registry.register(createGmailSearchAction(gmailAdapter));
	registry.register(
		createGmailSendDraftAction({
			gmail: gmailAdapter,
			capture: registry.get("capture")!,
			ownerAddresses: adapters?.ownerAddresses,
		}),
	);
	registry.register(createGmailTriageMetricsAction(gmailTriageMetricsAdapter));
	registry.register(createGmailUnsubscribeBatchAction(gmailUnsubscribeBatchAdapter));
	registry.register(createGraphExportRdfAction(vocabularyAdapter));
	registry.register(createGraphFilterAction());
	registry.register(createGraphNodeLevelAction(graphAdapter));
	registry.register(createHotTierCandidatesAction({ entities: entityRepoAdapter }));
	registry.register(createIngestDiscoverAction(discoverAdapter));
	registry.register(
		createIngestDriveAction({
			drive: driveAdapter,
			artifacts: artifactRepoAdapter,
			storage: storageAdapter,
			...adapters?.driveImport,
			...adapters?.driveIngest,
		}),
	);
	registry.register(
		createIngestGithubAction({
			github: githubActivityAdapter,
			artifacts: artifactRepoAdapter,
			capture: artifactsAdapter,
		}),
	);
	registry.register(
		createIngestMeetingNotesAction({
			gmail: gmailAdapter,
			drive: driveAdapter,
			config: configAdapter,
			entities: entityRepoAdapter,
			links: linksAdapter,
			artifacts: artifactRepoAdapter,
			storage: storageAdapter,
			capture: artifactsAdapter,
			ownerId: adapters?.driveImport?.ownerId,
			storageBucket: adapters?.driveImport?.storageBucket,
			embedArtifact: adapters?.driveImport?.embedArtifact,
			findArtifactByDriveFileId: adapters?.driveIngest?.findArtifactByDriveFileId,
		}),
	);
	registry.register(
		createIngestMeetingNotesDetectAction({
			gmail: gmailAdapter,
			config: configAdapter,
		}),
	);
	registry.register(
		createIngestSlackAction({
			slack: slackIngestAdapter,
			artifacts: artifactRepoAdapter,
			capture: artifactsAdapter,
		}),
	);
	registry.register(createInstructionsGetAction(instructionsPorts));
	registry.register(createInstructionsMarkPastedAction(instructionsPorts));
	registry.register(createIntegrationListAction(configAdapter));
	registry.register(createIntegrationSetAction(configAdapter));
	const jobHuntDeps: JobHuntDeps = {
		entities: entityRepoAdapter,
		artifacts: artifactRepoAdapter,
		tasks: taskRepoAdapter,
		links: adapters?.links ? linksAdapter : undefined,
		graphRead: adapters?.graphRead ? graphReadAdapter : undefined,
		people: adapters?.people ? peopleAdapter : undefined,
		embedEntity:
			adapters?.entityRepository &&
			"embedEntity" in adapters.entityRepository &&
			typeof adapters.entityRepository.embedEntity === "function"
				? adapters.entityRepository.embedEntity
				: undefined,
		ownerId:
			adapters?.entityRepository &&
			"ownerId" in adapters.entityRepository
				? adapters.entityRepository.ownerId
				: undefined,
	};
	registry.register(createJobApplicationUpsertAction(jobHuntDeps));
	const jobHuntGmailIngestDeps: JobHuntGmailIngestDeps = {
		...jobHuntDeps,
		gmail: gmailAdapter,
		ownerAddresses: adapters?.ownerAddresses,
		decisions: adapters?.decisionRepository,
		config: adapters?.config ? configAdapter : undefined,
		capture: adapters?.artifacts ? artifactsAdapter : undefined,
	};
	registry.register(createJobHuntGmailIngestAction(jobHuntGmailIngestDeps));
	registry.register(createJobListAction(jobsAdapter));
	registry.register(createJobPipelineReadAction(jobHuntDeps));
	registry.register(createKnowledgeSearchAction(searchPorts));
	registry.register(createLedgerQueryAction(ledgerAdapter));
	registry.register(createLinkCreateAction(linksAdapter));
	registry.register(createLinkDeleteAction(linksAdapter));
	registry.register(createLinkGetAction(linksAdapter));
	registry.register(createLinkQueryAction(linksAdapter));
	registry.register(createLinkUpsertAction(linksAdapter));
	registry.register(createLinkedinPostAction(linkedinAdapter));
	registry.register(createMcpResultProbeAction());
	registry.register(createMeetingCreateAction(notionAdapter));
	registry.register(createMetaAdsCallToolAction(metaAdsAdapter));
	registry.register(createMetaAdsListToolsAction(metaAdsAdapter));
	registry.register(createNotionBlockDeleteAction(notionAdapter));
	registry.register(createNotionCommentCreateAction(notionAdapter));
	registry.register(createNotionCommentListAction(notionAdapter));
	registry.register(createNotionCompletedAtStampAction(notionAutomationAdapter));
	registry.register(createNotionConfigGetAction(configAdapter));
	registry.register(createNotionDatabaseGetAction(notionAdapter));
	registry.register(createNotionDatabaseQueryAction(notionAdapter));
	registry.register(createNotionPageCreateAction(notionAdapter));
	registry.register(createNotionPageGetAction(notionAdapter));
	registry.register(createNotionPageUpdateAction(notionAdapter));
	registry.register(createNotionSearchAction(notionAdapter));
	registry.register(createNotionUserListAction(notionAdapter));
	registry.register(createOnedriveAuditVsGdriveAction(onedriveBridgePorts));
	registry.register(createOnedriveCopyToGdriveAction(onedriveBridgePorts));
	registry.register(createOnedriveCreateFolderAction(onedriveAdapter));
	registry.register(createOnedriveDeleteAction(onedriveAdapter));
	registry.register(createOnedriveGetMetadataAction(onedriveAdapter));
	registry.register(createOnedriveGetQuotaAction(onedriveAdapter));
	registry.register(createOnedriveListAction(onedriveAdapter));
	registry.register(createOnedriveMoveAction(onedriveAdapter));
	registry.register(createOnedriveReadFileAction(onedriveAdapter));
	registry.register(createOnedriveRenameAction(onedriveAdapter));
	registry.register(createOnedriveSearchAction(onedriveAdapter));
	registry.register(createOnedriveUploadFileAction(onedriveAdapter));
	registry.register(createPersonCreateAction(peopleWriteAdapter));
	registry.register(createPersonDeleteAction(peopleWriteAdapter));
	registry.register(createPersonGetAction(peopleAdapter));
	registry.register(createPersonMatchAction(peopleAdapter));
	registry.register(createPersonQueryAction(peopleAdapter));
	registry.register(createPersonSelfAction(peopleAdapter));
	registry.register(createPersonUpdateAction(peopleWriteAdapter));
	registry.register(createPersonUpsertAction(peopleWriteAdapter));
	registry.register(createPlanningEditAction(planningAdapter));
	registry.register(createPlanningReadAction(planningAdapter));
	registry.register(createPosthogConnectionsAction(posthogAdapter));
	registry.register(createPosthogProjectFilterAction(posthogAdapter));
	registry.register(createPosthogQueryAction(posthogAdapter));
	registry.register(createPosthogQueryDebugAction(posthogAdapter));
	registry.register(createPosthogWriteAction(posthogAdapter));
	registry.register(createRelationshipCrudAction(relationshipsAdapter));
	registry.register(createRevenueCatGetMetricsAction(revenuecatAdapter));
	registry.register(createReviewLessonRecordAction(reviewLessonAdapter));
	registry.register(createReviewListAction(reviewAdapter));
	registry.register(createReviewResolveAction(reviewAdapter));
	registry.register(createSheetsReadAction(sheetsAdapter));
	registry.register(createSheetsWriteAction(sheetsAdapter));
	registry.register(createSlackMessageDeleteAction(slackWritesAdapter));
	registry.register(createSlackMessageUpdateAction(slackWritesAdapter));
	registry.register(createSlackPostAction(slackPostAdapter));
	registry.register(createSlackReactionAddAction(slackWritesAdapter));
	registry.register(createSlackReadChannelAction(slackAdapter));
	registry.register(createSlackReadThreadAction(slackAdapter));
	registry.register(createSlackSearchAction(slackAdapter));
	registry.register(
		createStateDocUpdateAction({
			notion: notionAdapter,
			config: configAdapter,
		}),
	);
	registry.register(createStoreSchemaAction(schemaAdapter));
	registry.register(createTaskCrudAction(tasksAdapter));
	registry.register(createViewScreenAction());
	registry.register(
		createWhatsappIngestAction({
			whatsapp: whatsappAdapter,
			capture: artifactsAdapter,
			config: configAdapter,
		}),
	);
	registry.register(createWhatsappListChatsAction(whatsappAdapter));
	registry.register(createWhatsappReadMessagesAction(whatsappAdapter));
	registry.register(createWhatsappStatusAction(whatsappAdapter));
	registry.register(
		createWeeklyKpiSnapshotAction({
			onedrive: onedriveAdapter,
			drive: driveAdapter,
			cleanState: cleanStateAdapter,
			artifacts: artifactsAdapter,
			tasks: tasksAdapter,
			review: reviewAdapter,
			ledger: ledgerAdapter,
			doctor: doctorAdapter,
		}),
	);

	return registry;
}
