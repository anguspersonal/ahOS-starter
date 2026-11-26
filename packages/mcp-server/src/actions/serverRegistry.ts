import { createCoreArtifactsPort } from "@ahkms/core";
import {
	buildRegistry,
	createCoreEntitiesPort,
	createCoreRelationshipsPort,
	createCoreReviewPort,
	createInboxActionResolver,
	type ActionAdapters,
	type ActionRegistry,
	type CallableApprovedRunner,
	type GenericSupabaseClient,
} from "@ahkms/core/actions";
import {
	createGithubActivityAdapter,
	createLinkedinAdapter,
	createOctokitGithubIssuesAdapter,
	createOctokitGithubPullsAdapter,
	createOctokitGithubReadAdapter,
	createOneDriveAdapter,
	createPlanningAdapter,
	createSupabaseGraphEdgeAdapter,
	createSupabaseConfigRepository,
	type ConfigSupabaseClient,
	createSupabaseBindingRepository,
	type BindingsSupabaseClient,
	createSynthesizePorts,
	type SynthesizeSupabaseClient,
	createSupabaseVocabularyReadAdapter,
	createSupabaseSchemaIntrospectionAdapter,
	createRevenueCatAdapter,
	createSupabaseLedgerReadAdapter,
	type LedgerReadSupabaseClient,
	createSupabaseCapabilityRepository,
	type CapabilitySupabaseClient,
	createSupabaseCleanStateAdapter,
	createSupabaseArtifactRepository,
	type ArtifactSupabaseClient,
	createSupabaseStorageAdapter,
	type StorageSupabaseClient,
	createSupabaseDiscoverRepository,
	type DiscoverSupabaseClient,
	createWhatsappAdapter,
	getMessageAttachment,
	createSupabaseEmailMetricsStore,
	type EmailMetricsSupabaseClient,
	createSupabaseGmailReconcileStore,
	type GmailReconcileSupabaseClient,
	createSlackAdapter,
	createSlackPostAdapter,
	createSlackWriteAdapter,
	createSupabaseJobQueue,
	type JobsSupabaseClient,
	createGoogleDriveWatchAdapter,
	createSupabaseEntityMergeAdapter,
	type EntityMergeSupabaseClient,
	createSupabaseEmbeddingStore,
	createSupabaseEntityRepository,
	createSupabaseLinkRepository,
	type EntitiesSupabaseClient,
	type LinksSupabaseClient,
	createSupabaseGraphReadAdapter,
	type GraphReadSupabaseClient,
	createSupabasePeopleRepository,
	type PeopleSupabaseClient,
	createSupabaseSearchAdapter,
	type SearchSupabaseClient,
	createAnthropicTextExtractionAdapter,
	createBrevoPassthroughAdapter,
	createDexPassthroughAdapter,
	createMetaAdsPassthroughAdapter,
	createSupabaseTaskRepository,
	type TasksSupabaseClient,
} from "@ahkms/core/adapters";
import { notionAdapter } from "../tools/searchNotion.js";
import { dailyLogTargetIds, getStateDocPageId } from "../notionDomain.js";
import { resolveDailyLogPortTarget } from "../dailyLogTarget.js";
import { resolveRecordTarget } from "../notionRecordTarget.js";
import { DOMAIN_LEGACY_SCOPE, type Domain } from "../domains.js";
import { getCredential, getGithubCredential, hasCredential } from "../credentials.js";
import { env } from "../env.js";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { embedBatchWithRetry } from "../embeddings.js";
import {
	getExcludedExtensions,
	getExcludedFolders,
	getExcludedMimeTypes,
} from "../tools/discoverExclusions.js";
import { externalLinks } from "../links.js";
import { DAILY_LOG_LINK_KIND } from "../vocab.js";
import { decisionRepository } from "./governance.js";
import { serverArtifactsDeps } from "../tools/capture.js";
import { serverTasksPort } from "../tools/createTask.js";
import { loadDosConfig } from "../dosConfig.js";
import { handleNotionPagePropertiesUpdated } from "../automations/completedAtStamp.js";
import { gmailPriorityTriagePort } from "../automations/gmailWorkflow.js";
import { runDriveDiscoverCadence } from "../schedule/driveDiscoverCadence.js";
import { sheetsPort } from "../google/sheetsPort.js";
import { bigqueryPort } from "../google/bigqueryPort.js";
import { drivePort } from "../google/drivePort.js";
import { readLocalFile } from "../google/localFile.js";
import { docsPort } from "../google/docsPort.js";
import { appsscriptPort } from "../google/appsscriptPort.js";
import { calendarPort } from "../google/calendarPort.js";
import { gmailPort } from "../google/gmailPort.js";
import { getGmailAccessToken, ownerAddresses } from "../google/gmail.js";
import { GOOGLE_ACCOUNT_PROVIDER, type GoogleAccount } from "../google/accounts.js";
import { doctorPort } from "../doctor/index.js";
import { posthogPort } from "../posthog/port.js";
import { hashBody } from "../skill-sync/hash.js";
import { defaultWhatsappSyncHook } from "../whatsapp/baileysSync.js";
import { getConfiguredApprovalStore } from "./approvals.js";
import * as embeddings from "../embeddings.js";
import { findArtifactByDriveFileId } from "../tools/drive/shared.js";

function resolveCurrentUserId(): string | undefined {
	try {
		return getCurrentUserId();
	} catch {
		return undefined;
	}
}

/**
 * Builds the set of adapters wired into mcp-server actions.
 * Front-door entry points (stdio and Streamable HTTP) use these adapters.
 * derive stays unwired (ADR-101 §4).
 * All credential resolution is lazy to avoid premature network access at startup.
 */
export function serverAdapters(): ActionAdapters {
	notionAdapter.getStateDocPageId = (workspace) => getStateDocPageId(workspace as Domain);
	notionAdapter.getDailyLogTargetIds = (workspace) => dailyLogTargetIds(workspace as Domain);
	(notionAdapter as NonNullable<ActionAdapters["notion"]>).resolveRecordTarget = async (kind, domain) => {
		const target = await resolveRecordTarget(kind, domain);
		return { dataSourceId: target.dataSourceId, databaseId: target.databaseId, workspace: domain };
	};
	(notionAdapter as NonNullable<ActionAdapters["notion"]>).resolveDailyLogTarget = async (domain) => {
		const target = await resolveDailyLogPortTarget(domain);
		return { databaseId: target.databaseId, dataSourceId: target.dataSourceId, workspace: domain };
	};
	const githubReadPort = createOctokitGithubReadAdapter(async (repo) =>
		getGithubCredential("github", repo),
	);
	return {
		notion: notionAdapter,
		github: {
			port: createOctokitGithubIssuesAdapter(async (repo) =>
				getGithubCredential("github_issues", repo),
			),
			supabase: supabase as unknown as GenericSupabaseClient,
			getUserId: getCurrentUserId,
		},
		githubRead: {
			port: githubReadPort,
			supabase: supabase as unknown as GenericSupabaseClient,
			getUserId: getCurrentUserId,
		},
		githubPulls: {
			port: createOctokitGithubPullsAdapter(async (repo) =>
				getGithubCredential("github_pulls", repo),
			),
			readPort: githubReadPort,
			supabase: supabase as unknown as GenericSupabaseClient,
			getUserId: getCurrentUserId,
		},
		githubActivity: createGithubActivityAdapter((repo) =>
			getGithubCredential("github", repo),
		),
		linkedin: {
			port: createLinkedinAdapter(async () => getCredential("linkedin")),
			supabase: supabase as unknown as GenericSupabaseClient,
			getUserId: getCurrentUserId,
		},
		synthesize: createSynthesizePorts(
			supabase as unknown as SynthesizeSupabaseClient,
			async () => ({
				geminiApiKey: (await hasCredential("gemini")) ? await getCredential("gemini") : undefined,
				anthropicApiKey: process.env.ANTHROPIC_API_KEY,
			}),
		),
		graph: {
			supabase: supabase as unknown as GenericSupabaseClient,
			getUserId: getCurrentUserId,
		},
		graphEdges: {
			port: createSupabaseGraphEdgeAdapter(supabase as unknown as GenericSupabaseClient),
			getUserId: resolveCurrentUserId,
		},
		decisionRepository,
		review: createCoreReviewPort({
			decisions: decisionRepository,
			entities: createSupabaseEntityRepository({
				client: supabase as unknown as EntitiesSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			merge: createSupabaseEntityMergeAdapter({
				client: supabase as unknown as EntityMergeSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			embedding: () => {
				try {
					return typeof embeddings.embed === "function" &&
						Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
						? {
								embed: (text: string) => embeddings.embed(text),
								embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
							}
						: null;
				} catch {
					return null;
				}
			},
			embeddingStore: createSupabaseEmbeddingStore(supabase),
			resolveUserId: getCurrentUserId,
		}),
		reviewLesson: {
			supabase: supabase as unknown as GenericSupabaseClient,
			getUserId: getCurrentUserId,
		},
		tasks: serverTasksPort(),
		taskRepository: createSupabaseTaskRepository(supabase as unknown as TasksSupabaseClient),
		artifacts: createCoreArtifactsPort(serverArtifactsDeps),
		artifactRepository: createSupabaseArtifactRepository({
			client: supabase as unknown as ArtifactSupabaseClient,
			ownerId: getCurrentUserId,
			embedArtifact: (id, fields) => embeddings.embedAndStore("artifacts", id, fields),
		}),
		embedBackfill: {
			store: createSupabaseEmbeddingStore({
				client: supabase,
				ownerId: resolveCurrentUserId,
			}),
			embeddings: () => {
				try {
					return typeof embeddings.embed === "function" &&
						Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
						? {
								embed: (text: string) => embeddings.embed(text),
								embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
							}
						: null;
				} catch {
					return null;
				}
			},
			userId: resolveCurrentUserId,
		},
		storage: createSupabaseStorageAdapter({
			client: supabase as unknown as StorageSupabaseClient,
			supabaseUrl: () => env.supabaseUrl,
		}),
		extraction: {
			artifacts: createSupabaseArtifactRepository({
				client: supabase as unknown as ArtifactSupabaseClient,
				ownerId: getCurrentUserId,
				embedArtifact: (id, fields) => embeddings.embedAndStore("artifacts", id, fields),
			}),
			storage: createSupabaseStorageAdapter({
				client: supabase as unknown as StorageSupabaseClient,
				supabaseUrl: () => env.supabaseUrl,
			}),
			extraction: createAnthropicTextExtractionAdapter({
				apiKey: () => env.anthropicApiKey,
				model: () => env.extractModel,
				geminiApiKey: async () =>
					(await hasCredential("gemini")) ? await getCredential("gemini") : env.geminiApiKey,
				geminiModel: () => env.geminiExtractModel,
				provider: () =>
					process.env.KMS_EXTRACT_PROVIDER === "anthropic" ? "anthropic" : undefined,
			}),
			embedArtifact: (id, fields) => embeddings.embedAndStore("artifacts", id, fields),
		},
		externalLinks: {
			...externalLinks,
			async hasDailyLogTwin(pageIds: string[]): Promise<boolean> {
				if (pageIds.length === 0) return false;
				const { data, error } = await supabase
					.from("artifact_external_links")
					.select("external_id")
					.eq("user_id", getCurrentUserId())
					.eq("kind", DAILY_LOG_LINK_KIND)
					.in("external_id", pageIds);
				if (error) {
					console.error(`checkTwinPresent: artifact_external_links query failed: ${error.message}`);
					return false;
				}
				return (data?.length ?? 0) > 0;
			},
		},
		externalLinkCreate: {
			// Strict on purpose (#2313): the shared getExternalLinks answers [] on a query
			// error, which the daily_log guard would read as "no pointers" and write a second.
			async getDailyLogPointers(artifactId: string) {
				const { data, error } = await supabase
					.from("artifact_external_links")
					.select("provider, external_id")
					.eq("user_id", getCurrentUserId())
					.eq("artifact_id", artifactId)
					.eq("kind", DAILY_LOG_LINK_KIND);
				if (error) {
					throw new Error(`artifact_external_links query failed: ${error.message}`);
				}
				if (!data) {
					throw new Error("artifact_external_links query returned no result");
				}
				return data as Array<{ provider: string; external_id: string }>;
			},
		},
		relationships: createCoreRelationshipsPort({
			entities: createSupabaseEntityRepository({
				client: supabase as unknown as EntitiesSupabaseClient,
				ownerId: resolveCurrentUserId,
			}),
		}),
		entities: createCoreEntitiesPort({
			repo: createSupabaseEntityRepository({
				client: supabase as unknown as EntitiesSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			embedding: () => {
				try {
					return typeof embeddings.embed === "function" &&
						Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
						? {
								embed: (text: string) => embeddings.embed(text),
								embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
							}
						: null;
				} catch {
					return null;
				}
			},
			embeddingStore: createSupabaseEmbeddingStore(supabase),
			embedEntity: (id, fields) => embeddings.embedAndStore("entities", id, fields),
			loadDosConfig,
		}),
		entityRepository: {
			entities: createSupabaseEntityRepository({
				client: supabase as unknown as EntitiesSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			embedEntity: (id, fields) => embeddings.embedAndStore("entities", id, fields),
			ownerId: getCurrentUserId,
		},
		entityMerge: {
			merge: createSupabaseEntityMergeAdapter({
				client: supabase as unknown as EntityMergeSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			embeddings: () => {
				try {
					return typeof embeddings.embed === "function" &&
						Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
						? {
								embed: (text: string) => embeddings.embed(text),
								embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
							}
						: null;
				} catch {
					return null;
				}
			},
			embeddingStore: createSupabaseEmbeddingStore(supabase),
			ownerId: getCurrentUserId,
		},
		links: createSupabaseLinkRepository({
			client: supabase as unknown as LinksSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		graphRead: createSupabaseGraphReadAdapter({
			client: supabase as unknown as GraphReadSupabaseClient,
		}),
		people: {
			people: createSupabasePeopleRepository({
				client: supabase as unknown as PeopleSupabaseClient,
				ownerId: resolveCurrentUserId,
			}),
			embeddings: () => {
				try {
					return typeof embeddings.embed === "function" &&
						Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
						? {
								embed: (text: string) => embeddings.embed(text),
								embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
							}
						: null;
				} catch {
					return null;
				}
			},
			embeddingStore: createSupabaseEmbeddingStore(supabase),
			embedEntity: (id, fields) => embeddings.embedAndStore("entities", id, fields),
		},
		jobs: createSupabaseJobQueue(supabase as unknown as JobsSupabaseClient),
		notionAutomation: {
			handlePagePropertiesUpdated: handleNotionPagePropertiesUpdated,
		},
		driveDiscover: {
			runDiscoverSweep: runDriveDiscoverCadence,
		},
		config: {
			...createSupabaseConfigRepository({
				client: supabase as unknown as ConfigSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			async updatePreferencesRow(patch: Record<string, unknown>) {
				const { data, error } = await supabase
					.from("user_preferences")
					.update(patch)
					.eq("user_id", getCurrentUserId())
					.select("*")
					.single();
				if (error) {
					throw new Error(`Failed to update user_preferences: ${error.message}`);
				}
				return data as Record<string, unknown>;
			},
		},
		instructions: {
			config: createSupabaseConfigRepository({
				client: supabase as unknown as ConfigSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			bodyHash: hashBody,
		},
		doctor: doctorPort,
		vocabulary: createSupabaseVocabularyReadAdapter(supabase as any),
		schema: createSupabaseSchemaIntrospectionAdapter({
			supabaseUrl: () => env.supabaseUrl,
			serviceRoleKey: () => env.supabaseServiceRoleKey,
		}),
		bindings: createSupabaseBindingRepository({
			client: supabase as unknown as BindingsSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		brevo: createBrevoPassthroughAdapter({
			apiKey: () => env.brevoMcpApiKey,
			url: () => process.env.BREVO_MCP_URL,
		}),
		dex: createDexPassthroughAdapter({
			apiKey: () => env.dexApiKey,
		}),
		metaAds: createMetaAdsPassthroughAdapter({
			accessToken: () => getCredential("meta_ads"),
			config: createSupabaseConfigRepository({
				client: supabase as unknown as ConfigSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			apiVersion: () => process.env.META_ADS_API_VERSION,
		}),
		planning: createPlanningAdapter({
			baseUrl: () => env.workPlanningBaseUrl,
			getToken: () => getCredential("work_planning"),
		}),
		posthog: posthogPort,
		revenuecat: createRevenueCatAdapter(() => getCredential("revenuecat")),
		sheets: sheetsPort,
		bigquery: bigqueryPort,
		gmail: gmailPort,
		ownerAddresses,
		gmailPriorityTriage: gmailPriorityTriagePort,
		gmailTriageMetrics: createSupabaseEmailMetricsStore(
			supabase as unknown as EmailMetricsSupabaseClient,
			resolveCurrentUserId,
		),
		gmailUnsubscribeBatch: gmailPriorityTriagePort,
		gmailAttachmentToDrive: {
			getAttachment: async ({ domain, messageId, attachmentId, filename }) => {
				const account = DOMAIN_LEGACY_SCOPE[domain] as GoogleAccount;
				return getMessageAttachment(
					{ label: account, accessToken: () => getGmailAccessToken(account) },
					messageId,
					{ attachmentId, filename },
				);
			},
			uploadToDrive: async ({ domain, name, folderId, mimeType, data }) =>
				drivePort.uploadFile({ domain, name, folderId, mimeType, data }),
		},
		gmailReconcileStore: createSupabaseGmailReconcileStore(
			supabase as unknown as GmailReconcileSupabaseClient,
			resolveCurrentUserId,
		),
		ledger: createSupabaseLedgerReadAdapter(supabase as unknown as LedgerReadSupabaseClient),
		capabilities: {
			repo: createSupabaseCapabilityRepository({
				client: supabase as unknown as CapabilitySupabaseClient,
				ownerId: getCurrentUserId,
			}),
			bodyHash: hashBody,
		},
		cleanState: createSupabaseCleanStateAdapter({
			supabase: supabase as any,
		}),
		whatsapp: createWhatsappAdapter({
			configRepo: createSupabaseConfigRepository({
				client: supabase as unknown as ConfigSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			syncHook: defaultWhatsappSyncHook,
		}),
		drive: drivePort,
		driveImport: {
			ownerId: getCurrentUserId,
			storageBucket: () => env.storageBucket,
			embedArtifact: (id, fields) =>
				embeddings.embedAndStore("artifacts", id, {
					title: fields.title ?? undefined,
					description: fields.description ?? undefined,
					plain_text: fields.plain_text ?? undefined,
				}),
		},
		driveIngest: {
			findArtifactByDriveFileId,
		},
		readLocalFile,
		driveChanges: createGoogleDriveWatchAdapter({
			clientId: env.googleClientId ?? "",
			clientSecret: env.googleClientSecret ?? "",
			refreshTokens: {},
			getRefreshToken: async (account) =>
				getCredential(GOOGLE_ACCOUNT_PROVIDER[account as GoogleAccount]),
		}),
		docs: docsPort,
		appsscript: appsscriptPort,
		calendar: calendarPort,
		onedrive: createOneDriveAdapter({
			clientId: env.microsoftClientId ?? "",
			clientSecret: env.microsoftClientSecret,
			refreshToken: () => getCredential("microsoft_personal"),
		}),
		slack: {
			...createSlackAdapter(() => getCredential("slack")),
			...createSlackPostAdapter(() => getCredential("slack_bot")),
			...createSlackWriteAdapter({
				userToken: () => getCredential("slack"),
				botToken: () => getCredential("slack_bot"),
			}),
		},
		discover: {
			repo: createSupabaseDiscoverRepository({
				client: supabase as unknown as DiscoverSupabaseClient,
				ownerId: getCurrentUserId,
			}),
			embeddings: {
				isConfigured: () =>
					Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim()),
				embedBatch: (texts) => embedBatchWithRetry(texts),
			},
			exclusionLists: () => ({
				folders: getExcludedFolders(),
				extensions: getExcludedExtensions(),
				mimeTypes: getExcludedMimeTypes(),
			}),
		},
		search: {
			search: createSupabaseSearchAdapter({
				client: supabase as unknown as SearchSupabaseClient,
				ownerId: getCurrentUserId,
				onWarning: (msg) => process.stderr.write(`${msg}\n`),
			}),
			embeddings: () => {
				try {
					return typeof embeddings.embed === "function" &&
						Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
						? {
								embed: (text: string) => embeddings.embed(text),
								embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
							}
						: null;
				} catch {
					return null;
				}
			},
			onWarning: (msg) => process.stderr.write(`${msg}\n`),
		},
		approvals: {
			getStore: getConfiguredApprovalStore,
			resolve: (actionId) => createInboxActionResolver(serverRegistry())(actionId),
		},
	};
}

let cachedRegistry: ActionRegistry | null = null;

/**
 * Returns the memoized singleton ActionRegistry built for the server process (ADR-101 §3, ADR-105 R2).
 * Lazily instantiated on first access so files that never call it build nothing.
 */
export function serverRegistry(): ActionRegistry {
	if (!cachedRegistry) {
		cachedRegistry = buildRegistry(serverAdapters());
	}
	return cachedRegistry;
}

export function inboxActionResolver(
	actionId: string,
): CallableApprovedRunner | undefined {
	return createInboxActionResolver(serverRegistry())(actionId);
}
