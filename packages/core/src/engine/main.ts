/**
 * @ahkms/core/engine - main.ts
 *
 * Executable composition root for the engine process (ADR-101 #1321).
 * Deployed on Railway with start command:
 *   node packages/core/dist/engine/main.js
 *
 * Wires adapters, boots the EngineRunner, serves health endpoints,
 * and coordinates clean shutdown.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { loadLegacyWorkerApp } from "./legacyWorkerApp.js";
import { EngineLock } from "./lock.js";
import { EngineRunLog } from "./runLog.js";
import { EngineRunner } from "./runner.js";
import {
	createSupabaseAdminClient,
	type SupabaseClient,
} from "../adapters/supabase/client.js";
import {
	createSupabaseSchedulerLockPort,
	createSupabaseSchedulerRunLogPort,
} from "../adapters/supabase/scheduler.js";
import { createSupabaseJobPorts } from "../adapters/supabase/jobs.js";
import { createSupabaseArtifactRepository, type ArtifactSupabaseClient } from "../adapters/supabase/artifacts.js";
import {
	createSupabaseEntityRepository,
	createSupabaseLinkRepository,
	type EntitiesSupabaseClient,
	type LinksSupabaseClient,
} from "../adapters/supabase/entities.js";
import { createSupabaseGraphReadAdapter, type GraphReadSupabaseClient } from "../adapters/supabase/graphRead.js";
import { createSupabasePeopleRepository, type PeopleSupabaseClient } from "../adapters/supabase/people.js";
import { createSupabaseTaskRepository, type TasksSupabaseClient } from "../adapters/supabase/tasks.js";
import { createDerivePorts } from "../adapters/derive/index.js";
import { createSynthesizePorts } from "../adapters/synthesize/index.js";
import { buildRegistry } from "../actions/buildRegistry.js";
import { actionCadence } from "./cadences/actionCadence.js";
import { createApprovalExpiryCadence } from "./cadences/approvalExpiryCadence.js";
import { createJobRunnerCadence } from "./jobs/jobRunner.js";
import { createSupabaseDriveWatchPersistence } from "../adapters/supabase/driveWatch.js";
import { createSupabaseActionApprovalStore } from "../adapters/supabase/actionApprovals.js";
import { createSupabaseApprovalExpiryPort } from "../adapters/supabase/approvalExpiry.js";
import { createSupabaseActionLedgerSink } from "../adapters/supabase/actionLedger.js";
import {
	createSlackApprovalCardNotifier,
	resolveSlackOwnerUserId,
} from "../adapters/slack/approvalCard.js";
import { setDefaultAuditSink, stderrAuditSink } from "../actions/adapters/direct.js";
import { withApprovalNotifier } from "../actions/approvalNotify.js";
import { setActionApprovalStore } from "../actions/gate.js";
import {
	setActionScope,
	type ActionScope,
} from "../actions/scope.js";
import type { ActionAuditSink, ActionContext } from "../actions/types.js";
import { createGoogleDriveWatchAdapter } from "../adapters/google/driveWatchAdapter.js";
import type { DriveWatchPorts } from "../ports/driveWatch.js";

const PORT = Number(process.env.PORT) || 3001;

/**
 * Installs a Node AsyncLocalStorage-backed ActionScope for the engine process
 * so each job execution and nested action call shares a trace scope (#1468).
 */
export function configureEngineActionScope(): ActionScope {
	const storage = new AsyncLocalStorage<ActionContext>();
	const scope: ActionScope = {
		current: () => storage.getStore(),
		run: (ctx, fn) => storage.run(ctx, fn),
	};
	setActionScope(scope);
	return scope;
}

export const configureActionScope = configureEngineActionScope;

async function bootEngine(): Promise<void> {
	console.log("[ahOS Engine] Starting engine process (ADR-101)...");
	configureEngineActionScope();

	const supabaseUrl = process.env.SUPABASE_URL;
	const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

	let lockPort: any;
	let runLogPort: any;
	let supabase: SupabaseClient | null = null;

	if (supabaseUrl && supabaseKey) {
		supabase = createSupabaseAdminClient(supabaseUrl, supabaseKey);
		lockPort = createSupabaseSchedulerLockPort(supabase);
		runLogPort = createSupabaseSchedulerRunLogPort(supabase);
		console.log("[ahOS Engine] Supabase persistence ports connected.");
	} else {
		console.warn("[ahOS Engine] WARNING: SUPABASE_URL / key not provided. Using in-memory fallback ports.");
		const inMemoryLocks = new Set<string>();
		lockPort = {
			async tryAcquire(cadence: string) {
				if (inMemoryLocks.has(cadence)) return false;
				inMemoryLocks.add(cadence);
				return true;
			},
			async release(cadence: string) {
				inMemoryLocks.delete(cadence);
			},
		};
		runLogPort = {
			async record(entry: any) {
				console.log("[ahOS Engine in-memory runLog]", entry.cadence, entry.counts);
			},
		};
	}

	const lock = new EngineLock(lockPort);
	const runLog = new EngineRunLog(runLogPort);
	const runner = new EngineRunner(lock, runLog);

	// Register core background cadences (ADR-101 #1321, #1306). The composition
	// root is the only place that reads configuration and wires adapters.
	if (supabase) {
		const baseStore = createSupabaseActionApprovalStore(supabase);
		const slackToken = process.env.SLACK_TOKEN_BOT_OAUTH ?? process.env.SLACK_BOT_TOKEN;
		const sb = supabase;
		setActionApprovalStore(
			slackToken
				? withApprovalNotifier(baseStore, createSlackApprovalCardNotifier({
						botToken: slackToken,
						ownerUserId: (uid) => resolveSlackOwnerUserId(sb, uid ?? process.env.KMS_USER_ID),
						webUrl: process.env.AHOS_WEB_URL,
					}))
				: baseStore,
		);
		const approvalExpiry = createApprovalExpiryCadence({
			port: createSupabaseApprovalExpiryPort(supabase),
		});
		runner.registerCadence(
			actionCadence({
				name: approvalExpiry.name,
				intervalMs: approvalExpiry.intervalMs,
				actionId: "approval_expiry",
				registry: (id) =>
					id === "approval_expiry"
						? ({
								id,
								schema: { parse: (v: unknown) => v },
								expose: { worker: true },
								run: () => approvalExpiry.run(),
							} as any)
						: undefined,
				enabled: approvalExpiry.enabled,
			}),
		);
		const ledgerSink = createSupabaseActionLedgerSink(supabase);
		const auditSink: ActionAuditSink = async (record) => {
			await stderrAuditSink(record);
			await ledgerSink(record);
		};
		setDefaultAuditSink(auditSink);
		const ownerUserId = process.env.KMS_USER_ID;
		const deriveEnabled = process.env.KMS_DERIVE_ENABLED === "true";
		if (deriveEnabled && !ownerUserId) {
			console.error("[ahOS Engine] KMS_DERIVE_ENABLED=true but KMS_USER_ID is unset; derive cadence not registered.");
		}

		let derivePorts: ReturnType<typeof createDerivePorts> | null = null;
		let synthesizePorts: ReturnType<typeof createSynthesizePorts> | null = null;
		try {
			const llmConfig = {
				geminiApiKey: process.env.GEMINI_API_KEY,
				anthropicApiKey: process.env.ANTHROPIC_API_KEY,
				defaultProvider: (process.env.KMS_DERIVE_PROVIDER === "anthropic" ? "anthropic" : "gemini") as "anthropic" | "gemini",
				geminiModel: process.env.KMS_DERIVE_GEMINI_MODEL,
				anthropicModel: process.env.KMS_DERIVE_ANTHROPIC_MODEL,
			};
			derivePorts = createDerivePorts(supabase, llmConfig);
			synthesizePorts = createSynthesizePorts(supabase, llmConfig);
		} catch (err) {
			console.error("[ahOS Engine] Derive ports unavailable; derive and jobs cadences not registered:", err);
		}

		const driveWebhookToken = process.env.DRIVE_WEBHOOK_TOKEN;
		const webhookBaseUrl = (process.env.MCP_PUBLIC_URL || process.env.DRIVE_WEBHOOK_URL || "")
			.trim()
			.replace(/\/+$/, "");

		let driveWatchPorts: DriveWatchPorts | undefined;
		if (ownerUserId && driveWebhookToken && webhookBaseUrl) {
			const driveWatchPersistence = createSupabaseDriveWatchPersistence(supabase, ownerUserId);
			const driveWatchAdapter = createGoogleDriveWatchAdapter({
				clientId: process.env.GOOGLE_CLIENT_ID,
				clientSecret: process.env.GOOGLE_CLIENT_SECRET,
				refreshTokens: {
					personal:
						process.env.GOOGLE_REFRESH_TOKEN_PERSONAL || process.env.GOOGLE_REFRESH_TOKEN,
					work: process.env.GOOGLE_REFRESH_TOKEN_WORK,
				},
			});

			driveWatchPorts = {
				getStoredChannel: (account) => driveWatchPersistence.getStoredChannel(account),
				saveChannel: (chan) => driveWatchPersistence.saveChannel(chan),
				registerWatch: (params) => driveWatchAdapter.registerWatch(params),
				stopWatch: (params) => driveWatchAdapter.stopWatch(params),
				listAccounts: () => driveWatchAdapter.listAccounts(),
			};
		}

		const registry = buildRegistry({
			...(derivePorts ? { derive: derivePorts } : {}),
			...(synthesizePorts ? { synthesize: synthesizePorts } : {}),
			...(driveWatchPorts ? { driveWatch: driveWatchPorts } : {}),
			entityRepository: {
				entities: createSupabaseEntityRepository({
					client: supabase as unknown as EntitiesSupabaseClient,
					ownerId: () => ownerUserId,
				}),
				ownerId: () => ownerUserId,
			},
			artifactRepository: createSupabaseArtifactRepository({
				client: supabase as unknown as ArtifactSupabaseClient,
				ownerId: () => ownerUserId ?? "",
			}),
			taskRepository: createSupabaseTaskRepository(
				supabase as unknown as TasksSupabaseClient,
			),
			links: createSupabaseLinkRepository({
				client: supabase as unknown as LinksSupabaseClient,
				ownerId: () => ownerUserId,
			}),
			graphRead: createSupabaseGraphReadAdapter({
				client: supabase as unknown as GraphReadSupabaseClient,
			}),
			people: createSupabasePeopleRepository({
				client: supabase as unknown as PeopleSupabaseClient,
				ownerId: () => ownerUserId,
			}),
		});

		if (derivePorts && synthesizePorts) {
			if (ownerUserId) {
				runner.registerCadence(
					actionCadence({
						name: "derive",
						intervalMs: (Number(process.env.KMS_DERIVE_INTERVAL_MINUTES) || 60) * 60 * 1000,
						actionId: "entity_derive_sweep",
						registry,
						input: {
							user_ids: [ownerUserId],
							limit: Number(process.env.KMS_DERIVE_BATCH_LIMIT) || 5,
							force: false,
						},
						enabled: () => deriveEnabled,
						auditSink,
					}),
				);
			}
			runner.registerCadence(
				createJobRunnerCadence({
					ports: createSupabaseJobPorts(supabase),
					registry,
					runnerOptions: { auditSink },
				}),
			);
		}

		if (driveWatchPorts && driveWebhookToken && webhookBaseUrl) {
			runner.registerCadence(
				actionCadence({
					name: "drive-watch",
					intervalMs: (Number(process.env.KMS_DRIVE_WATCH_INTERVAL_HOURS) || 6) * 60 * 60 * 1000,
					actionId: "drive_watch_renew",
					registry,
					input: {
						webhookBaseUrl,
						webhookToken: driveWebhookToken,
						renewalWindowMs:
							(Number(process.env.KMS_DRIVE_WATCH_RENEWAL_WINDOW_HOURS) || 24) * 60 * 60 * 1000,
					},
					enabled: () => process.env.KMS_DRIVE_WATCH_ENABLED !== "false",
					auditSink,
				}),
			);
			console.log("[ahOS Engine] Drive changes.watch renewal cadence registered.");
		}
	} else {
		console.warn("[ahOS Engine] No Supabase client; derive and jobs cadences not registered.");
	}

	// Transitional compatibility with legacy worker app (ADR-101 Step 2-5):
	// Load packages/worker/app.js in the same process before runner.start().
	// An app.js that exists on disk and fails to load throws and ends the boot.
	const { loaded: legacyWorkerLoaded } = loadLegacyWorkerApp();

	// Start engine runner
	runner.start();
	console.log("[ahOS Engine] Engine runner started successfully. Active cadences:", runner.getCadences().length);

	// If legacy Express app was not loaded (e.g. standalone engine deployment),
	// bind an HTTP health check listener on PORT so Railway uptime monitors succeed.
	let server: http.Server | null = null;
	if (!legacyWorkerLoaded) {
		server = http.createServer((req, res) => {
			if (req.url === "/health" || req.url === "/") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						status: "ok",
						service: "engine",
						uptime: process.uptime(),
						timestamp: new Date().toISOString(),
					}),
				);
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not Found" }));
		});

		server.listen(PORT, () => {
			console.log(`[ahOS Engine] Health listener active on http://0.0.0.0:${PORT}`);
		});
	}

	// Graceful shutdown
	const shutdown = async (signal: string) => {
		console.log(`[ahOS Engine] Received ${signal}. Shutting down engine...`);
		await runner.stop();
		if (server) {
			server.close();
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (!process.env.VITEST) {
	bootEngine().catch((err) => {
		console.error("[ahOS Engine] Boot failed:", err);
		process.exit(1);
	});
}
