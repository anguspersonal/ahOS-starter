/**
 * @ahkms/core/adapters
 *
 * External adapters and persistence drivers satisfying core ports (ADR-101 #1321).
 * Note: Adapters are imported only by composition roots (front-door startup,
 * engine main.ts) and tests.
 */

export * from "./supabase/client.js";
export * from "./supabase/scheduler.js";
export * from "./supabase/jobs.js";
export * from "./derive/index.js";
export * from "./synthesize/index.js";
export * from "./github/index.js";
export * from "./github/reads.js";
export * from "./github/pulls.js";
export * from "./github/activity.js";
export * from "./linkedin/index.js";
export * from "./notion/index.js";
export * from "./supabase/driveWatch.js";
export * from "./google/driveWatchAdapter.js";
export * from "./google/drive/index.js";
export * from "./google/docs/reader.js";
export * from "./google/docs/adapter.js";
export * from "./google/calendar/index.js";
export * from "./google/appsscript.js";
export * from "./google/bigquery.js";
export * from "./google/gmail/client.js";
export * from "./google/gmail/index.js";
export * from "./google/tokenSource.js";
export * from "./microsoft/tokenSource.js";
export * from "./microsoft/onedrive/index.js";
export * from "./sheets/client.js";
export * from "./sheets/index.js";
export * from "./supabase/actionLedger.js";
export * from "./supabase/ledgerRead.js";
export * from "./supabase/actionApprovals.js";
export * from "./supabase/approvalExpiry.js";
export * from "./supabase/gmailReconcileStore.js";
export * from "./email/llmEmailReasoner.js";
export * from "./google/decisionJudge.js";
export * from "./jev/decisionJudge.js";
export * from "./supabase/emailMetricsStore.js";
export * from "./enrich/index.js";
export * from "./chat/geminiChatAdapter.js";
export * from "./supabase/capabilities.js";
export * from "./supabase/externalLinks.js";
export * from "./supabase/tasks.js";
export * from "./supabase/config.js";
export * from "./supabase/decisions.js";
export * from "./supabase/vocabulary.js";
export * from "./supabase/graphEdges.js";
export * from "./supabase/schema.js";
export * from "./supabase/bindings.js";
export * from "./planning/index.js";
export * from "./revenuecat/index.js";
export * from "./openai/embeddings.js";
export * from "./google/embeddings.js";
export * from "./supabase/embeddingStore.js";
export * from "./posthog/index.js";
export * from "./supabase/cleanState.js";
export * from "./supabase/artifacts.js";
export * from "./supabase/storage.js";
export * from "./supabase/search.js";
export * from "./supabase/discover.js";
export * from "./supabase/enrich.js";
export * from "./whatsapp/index.js";
export * from "./slack/index.js";
export * from "./slack/post.js";
export * from "./slack/writes.js";
export * from "./slack/approvalCard.js";
export * from "./supabase/entities.js";
export * from "./supabase/entityMerge.js";
export * from "./supabase/entityMergeFallback.js";
export * from "./supabase/graphRead.js";
export * from "./supabase/people.js";
export * from "./anthropic/extraction.js";
export * from "./passthrough/brevo.js";
export * from "./passthrough/dex.js";
export * from "./passthrough/metaAds.js";
export type { JobQueuePort, PendingJobRow } from "../ports/jobQueue.js";
