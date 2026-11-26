/**
 * End-to-end smoke test for the MCP server tools against a real Supabase.
 *
 * Calls the tool handlers directly (not via stdio), so it exercises the same
 * logic the MCP server runs but without the JSON-RPC plumbing in the way.
 *
 * Requires the same env as the server (see ../.env.example). At minimum:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KMS_USER_ID
 * Optional:
 *   ANTHROPIC_API_KEY - if set, also exercises extract_text on the captured note.
 *   GOOGLE_REFRESH_TOKEN_PERSONAL + SMOKE_DRIVE_FILE_ID - if both set, also exercises the
 *     Discover & Index enrich path: discover a real Drive file as a pointer, then
 *     enrich_next pulls + extracts it.
 *   OPENAI_API_KEY    - if set, also exercises the T8 semantic / hybrid-search stage.
 *
 * Run from repo root:
 *   node --env-file=packages/mcp-server/.env --import tsx packages/mcp-server/scripts/smoke.ts
 *
 * Stages: capture → search (FTS) → get_artifact → (optional) extract_text
 *         → (optional, OPENAI_API_KEY) semantic search (T8) → cleanup.
 * Exits non-zero on any failure. All test artifacts are deleted in the cleanup
 * step so nothing pollutes your store.
 */
import { captureHandler } from "../src/tools/capture.js";
import { getArtifactHandler } from "../src/tools/getArtifact.js";
import { extractTextHandler } from "../src/tools/extract.js";
import { toMcpTool } from "../src/actions/index.js";
import { serverRegistry } from "../src/actions/serverRegistry.js";
import { discoverHandler } from "../src/tools/discover.js";
import { enrichNextHandler } from "../src/tools/enrichNext.js";
import { upsertEntityHandler } from "../src/tools/upsertEntity.js";
import { linkArtifactEntityHandler } from "../src/tools/linkArtifactEntity.js";
import { supabase } from "../src/supabase.js";
import { env } from "../src/env.js";
import { getCurrentUserId } from "../src/identity.js";

const searchHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("knowledge_search")!).handler(args);
const relateEntitiesHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_relate")!).handler(args);
const entityNeighbourhoodHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_neighbourhood")!).handler(args);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function log(stage: string, msg: string): void {
	process.stdout.write(`[${stage}] ${msg}\n`);
}

function fail(stage: string, err: unknown): never {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[${stage}] FAIL: ${msg}\n`);
	process.exit(1);
}

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content.map((c) => c.text).join("\n");
}

async function deleteArtifact(id: string, path: string | undefined): Promise<void> {
	const { error } = await supabase
		.from("artifacts")
		.delete()
		.eq("id", id)
		.eq("user_id", getCurrentUserId());
	log("cleanup", error ? `delete row FAILED: ${error.message}` : `deleted row ${id}`);
	if (path) {
		const { error: sErr } = await supabase.storage.from(env.storageBucket).remove([path]);
		log("cleanup", sErr ? `delete storage FAILED: ${sErr.message}` : `deleted storage ${path}`);
	}
}

async function main(): Promise<void> {
	const marker = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	let artifactId: string | undefined;
	let storagePath: string | undefined;
	let aliceId: string | undefined;
	let bobId: string | undefined;
	let semanticArtifactId: string | undefined;
	let semanticStoragePath: string | undefined;

	try {
		// 0. capture config - read-only; confirms the persisted user-specific context loads.
		log("config", "reading persisted capture context");
		const cfg = await toMcpTool(serverRegistry().get("config_capture_get")!).handler({});
		log("config", textOf(cfg).split("\n").slice(0, 4).join(" | "));

		// 1. capture
		log("capture", `creating note with marker "${marker}"`);
		const cap = await captureHandler({
			text: `Smoke test note. Unique marker: ${marker}. Created by packages/mcp-server/scripts/smoke.ts.`,
			title: `Smoke test ${marker}`,
			tags: ["smoke-test"],
		});
		const capText = textOf(cap);
		log("capture", capText.split("\n")[0]);
		const idMatch = capText.match(UUID);
		const pathMatch = capText.match(/Stored at: \S+/);
		if (!idMatch) fail("capture", "no artifact id in response");
		artifactId = idMatch[0];
		if (pathMatch) storagePath = pathMatch[0].replace(/^Stored at: \S+?\//, "");

		// 2. search (FTS) - requires migration 044 applied
		log("search", "searching for marker (FTS)");
		const search = await searchHandler({ query: marker, limit: 5 });
		const searchText = textOf(search);
		if (!searchText.includes(artifactId)) {
			fail("search", `marker not found in results - is migration 044 applied?\n  ${searchText}`);
		}
		log("search", "marker found in results ✓");

		// 3. get_artifact
		log("get", `fetching artifact ${artifactId}`);
		const got = await getArtifactHandler({ id: artifactId });
		const gotText = textOf(got);
		if (!gotText.includes(marker)) {
			fail("get", `marker not in fetched plain_text:\n  ${gotText}`);
		}
		log("get", "marker present in fetched content ✓");

		// 4. graph - upsert two people, relate them, link one to the artifact, query.
		//    Requires migration 049 (metadata column + dropped relationship_type CHECK).
		log("graph", "upserting two people");
		const alice = await upsertEntityHandler({
			entity_type: "people",
			title: `Alice ${marker}`,
			properties: { profession: "marketing" },
			tags: ["smoke-test"],
		});
		const bob = await upsertEntityHandler({
			entity_type: "people",
			title: `Bob ${marker}`,
			properties: { profession: "engineering" },
			tags: ["smoke-test"],
		});
		aliceId = textOf(alice).match(UUID)?.[0];
		bobId = textOf(bob).match(UUID)?.[0];
		if (!aliceId || !bobId) fail("graph", "no entity ids returned from upsert_entity");

		log("graph", "relating Alice -[works_with]-> Bob");
		const rel = await relateEntitiesHandler({
			from_entity_id: aliceId,
			to_entity_id: bobId,
			relationship_type: "works_with",
			confidence: 90,
			metadata: { context: "smoke" },
		});
		if (!textOf(rel).toLowerCase().includes("edge")) {
			fail("graph", `unexpected relate result: ${textOf(rel)}`);
		}

		log("graph", "linking Alice to the captured artifact (provenance)");
		await linkArtifactEntityHandler({
			artifact_id: artifactId,
			entity_id: aliceId,
			link_type: "primary",
		});

		log("graph", "querying neighbourhood: people whose profession is marketing");
		const nb = await entityNeighbourhoodHandler({
			entity_type: "people",
			properties_match: { profession: "marketing" },
			hops: 1,
		});
		const nbText = textOf(nb);
		if (!nbText.includes(aliceId)) fail("graph", `Alice not in neighbourhood:\n${nbText}`);
		if (!nbText.includes("works_with")) fail("graph", `works_with edge missing:\n${nbText}`);
		if (!nbText.includes(artifactId)) fail("graph", `provenance link missing:\n${nbText}`);
		log("graph", "marketing person, works_with edge, and provenance all present ✓");

		// 5. extract_text (optional - text artifact, no Anthropic call needed)
		if (env.anthropicApiKey) {
			log("extract", "running extract_text on a text artifact (no API call expected)");
			const ex = await extractTextHandler({ artifact_id: artifactId });
			log("extract", textOf(ex));
		} else {
			log("extract", "skipped (ANTHROPIC_API_KEY not set)");
		}

		// 5. T8 semantic smoke - keyword-free paraphrase retrieval
		// Content and paraphrase are chosen to share ZERO stem overlap so the FTS arm
		// produces no matches; only the vector/semantic arm can find the artifact.
		// Skipped when OPENAI_API_KEY is absent (hybrid search degrades to FTS-only).
		if (env.openaiApiKey) {
			const SEMANTIC_CONTENT =
				"Flex workspace subscribers get two bonus hot-desk hours gifted to a companion each billing cycle. " +
				"The complimentary hours reset on the first of the month and cannot be rolled over.";
			// No stems from SEMANTIC_CONTENT appear in this query ("cowork" ≠ "workspace",
			// "guest" ≠ "companion", "free" ≠ "complimentary", "receive" ≠ "gift", etc.).
			const PARAPHRASE =
				"do I receive any free extra time I can give a guest at my coworking membership?";

			log("semantic", "capturing note with flex-membership language (T8)");
			const sCap = await captureHandler({
				text: SEMANTIC_CONTENT,
				title: "Flex membership guest hours policy",
				tags: ["smoke-test"],
			});
			const sCapText = textOf(sCap);
			const sIdMatch = sCapText.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
			);
			const sPathMatch = sCapText.match(/Stored at: \S+/);
			if (!sIdMatch) fail("semantic", "no artifact id in semantic capture response");
			semanticArtifactId = sIdMatch[0];
			if (sPathMatch) semanticStoragePath = sPathMatch[0].replace(/^Stored at: \S+?\//, "");

			log("semantic", `searching with zero-keyword paraphrase: "${PARAPHRASE}"`);
			const sSearch = await searchHandler({ query: PARAPHRASE, limit: 10 });
			const sSearchText = textOf(sSearch);
			if (!sSearchText.includes(semanticArtifactId)) {
				fail(
					"semantic",
					`T8 FAIL - artifact not in top-10 results for paraphrase.\n` +
						`  This indicates hybrid/vector search is not working. Check that:\n` +
						`  1. Migration 051 is applied (artifacts.embedding column + hybrid_search_artifacts RPC)\n` +
						`  2. embedAndStore runs at capture time (captureHandler calls embedAndStore)\n` +
						`  Results: ${sSearchText}`,
				);
			}
			log("semantic", "T8 PASS - artifact found via keyword-free paraphrase ✓");
		} else {
			log("semantic", "skipped (OPENAI_API_KEY not set - hybrid search disabled)");
		}

		log("done", "ALL STAGES PASSED ✓");
	} catch (err) {
		fail("error", err);
	} finally {
		if (artifactId) {
			const { error: linkErr } = await supabase
				.from("artifact_entity_links")
				.delete()
				.eq("artifact_id", artifactId);
			if (linkErr) log("cleanup", `delete artifact link FAILED: ${linkErr.message}`);
			await deleteArtifact(artifactId, storagePath);
		}
		if (semanticArtifactId) await deleteArtifact(semanticArtifactId, semanticStoragePath);

		const eids = [aliceId, bobId].filter(Boolean) as string[];
		if (eids.length > 0) {
			// Clear links and edges first so FK constraints do not block entity deletion (#1215)
			await supabase.from("artifact_entity_links").delete().in("entity_id", eids);
			await supabase.from("entity_relationships").delete().in("from_entity_id", eids);
			await supabase.from("entity_relationships").delete().in("to_entity_id", eids);

			for (const eid of eids) {
				const { error } = await supabase
					.from("entities")
					.delete()
					.eq("id", eid)
					.eq("user_id", getCurrentUserId());
				if (error) {
					log("cleanup", `delete entity FAILED: ${error.message}, falling back to soft-archive`);
					await supabase
						.from("entities")
						.update({
							archived: true,
							archived_at: new Date().toISOString(),
							description: "Archived smoke test entity (#1215)",
						})
						.eq("id", eid)
						.eq("user_id", getCurrentUserId());
				} else {
					log("cleanup", `deleted entity ${eid}`);
				}
			}
		}

		// Assert no smoke-* rows survive the run
		const { data: leftover } = await supabase
			.from("entities")
			.select("id, title")
			.ilike("title", `%${marker}%`)
			.eq("user_id", getCurrentUserId())
			.eq("archived", false);
		if (leftover && leftover.length > 0) {
			fail("cleanup", `${leftover.length} unarchived smoke entity rows survived run: ${JSON.stringify(leftover)}`);
		}
	}
}

main();
