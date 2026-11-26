import { existsSync, readFileSync } from "node:fs";
import { type AhkmsCapability, fetchCapabilityRows } from "../skill-sync/ahkmsSource.js";
import { buildAudit } from "../skill-sync/audit.js";
import { hashBody } from "../skill-sync/hash.js";
import { type RepoSkillManifest, manifestPath, parseManifest } from "../skill-sync/repoManifest.js";
import { defaultRepoRoot } from "../skill-sync/repoSkills.js";
import { isWorkGithubRepo } from "../credentials.js";
import type { DoctorCheck } from "./report.js";
import {
	checkInstructionsFreshness,
	getCanonicalInstructionsHash,
	loadPastedInstructions,
	type PastedInstructionsRecord,
} from "../canonicalInstructions.js";
import {
	HOT_TIER_MAX_LINES,
	type HotTierRow,
	loadHotTier,
	renderHotTier,
} from "../hotTier.js";

// ahos_doctor, family 3: what travels (#1024, #1025).
//
// "Skills registered and un-drifted": the committed receipt (.claude/skill-registry.json,
// #689) against the live registry rows. This is the credentialed half the offline guard
// (scripts/check-skill-bodies.js) cannot do, and the same comparison
// `skill-sync repo status` makes — here from the deployed process, so it can run on a
// schedule or from dos Step 0 on a phone. The #1024 evidence: four skills carried
// `registered_at: null`, so their bodies did not travel, and nothing said so.
//
// "Claude custom instructions freshness" (#1025): checks whether the pasted copy of
// instructions in claude.ai matches the canonical instructions block.
//
// "Hot-tier line cap" (#1023, #1155): checks whether the hand-curated hot rows fit
// within the 100-line hard cap rendered into handshake instructions.
//
// The deployed image has no .claude/ tree, so the receipt is read from a local checkout
// when there is one and otherwise fetched from GitHub with the read-only ingest token.

const PUSH = "npm run skill-sync --workspace=@ahkms/mcp-server -- repo push";

/**
 * Hot-tier line cap check (#1023, #1155):
 * Checks whether the hand-curated hot rows fit within the 100-line hard cap rendered into
 * handshake instructions.
 */
export function classifyHotTier(
	rows: HotTierRow[],
	maxLines: number = HOT_TIER_MAX_LINES,
): DoctorCheck {
	const rendered = renderHotTier(rows, maxLines);
	const base = { family: "travels" as const, name: "hot tier line cap" };

	if (rendered.omitted > 0) {
		return {
			...base,
			status: "warn",
			detail: `${rows.length} hot rows (${rendered.lines} lines rendered): ${rendered.omitted} hot row${rendered.omitted === 1 ? "" : "s"} omitted to stay within the ${maxLines}-line cap`,
			fix: `unmark ${rendered.omitted} row${rendered.omitted === 1 ? "" : "s"} with entity_update or person_update ({ hot: false })`,
		};
	}

	return {
		...base,
		status: "ok",
		detail: `${rows.length} hot row${rows.length === 1 ? "" : "s"} (${rendered.lines} lines rendered, 0 omitted), fits under the ${maxLines}-line cap.`,
		fix: "",
	};
}

/**
 * Instruction-block freshness check (#1025):
 * Checks whether the pasted copy of custom instructions in claude.ai matches canonical.
 */
export function classifyInstructionTravel(
	pasted?: PastedInstructionsRecord | null,
	canonicalHash = getCanonicalInstructionsHash(),
	now = new Date(),
): DoctorCheck {
	const freshness = checkInstructionsFreshness(pasted?.sha256, pasted?.pasted_at, now, canonicalHash);
	return {
		family: "travels",
		name: "claude instructions freshness",
		status: freshness.status,
		detail: freshness.detail,
		fix: freshness.fix,
	};
}

/** PURE: receipts + registry rows → checks. Exercised directly by the tests. */
export function classifyTravel(
	manifest: RepoSkillManifest,
	caps: AhkmsCapability[],
	pastedInstructions?: PastedInstructionsRecord | null,
	hotRows?: HotTierRow[],
): DoctorCheck[] {
	const byName = new Map(caps.map((c) => [c.name.toLowerCase(), c]));
	const checks: DoctorCheck[] = [];
	let inSync = 0;

	for (const [name, entry] of Object.entries(manifest.skills).sort(([a], [b]) => a.localeCompare(b))) {
		if (!entry.register) continue;
		const cap = byName.get(name.toLowerCase());
		const base = { family: "travels" as const, name: `skill ${name}` };
		const fix = `from an up-to-date dev checkout: ${PUSH} ${name}`;

		if (!cap) {
			checks.push(
				entry.registered_at
					? { ...base, status: "fail", detail: `receipt says registered ${entry.registered_at}, but the registry has no row`, fix }
					: { ...base, status: "warn", detail: "push owed: enrolled for a kms-db body, never registered", fix },
			);
			continue;
		}
		if (cap.body === null || cap.body.trim() === "") {
			checks.push({ ...base, status: "fail", detail: `registry row (${cap.storageLocation}) serves no body; surfaces without the file improvise (#689)`, fix });
			continue;
		}
		if (hashBody(cap.body) === entry.body_sha256) {
			inSync += 1;
			continue;
		}
		const synced = cap.bodySyncedAt ? `, registry last synced ${cap.bodySyncedAt}` : "";
		checks.push(
			entry.registered_at
				? { ...base, status: "fail", detail: `registry body differs from the stamped receipt${synced}: an out-of-band edit or a lost push`, fix }
				: { ...base, status: "warn", detail: `push owed: registered_at is null and the registry still serves older bytes${synced}`, fix },
		);
	}

	checks.push({
		family: "travels",
		name: "repo skills in sync",
		status: "ok",
		detail: `${inSync} repo skill${inSync === 1 ? "" : "s"} served byte-for-byte as the receipt records.`,
		fix: "",
	});

	// Registry-only capabilities (no receipt to compare): the body audit's BROKEN rows.
	for (const row of buildAudit(caps).rows) {
		if (row.gap !== "broken" || manifest.skills[row.name]) continue;
		checks.push({
			family: "travels",
			name: `capability ${row.name}`,
			status: "fail",
			detail: `hosted (${row.storageLocation}) but capability_get returns no body`,
			fix: `re-register it with capability_register({ name: '${row.name}', storage_location: 'kms-db', body: <full source> })`,
		});
	}

	if (pastedInstructions !== undefined) {
		checks.push(classifyInstructionTravel(pastedInstructions));
	}

	if (hotRows !== undefined) {
		checks.push(classifyHotTier(hotRows));
	}

	return checks;
}

const REPO = () => process.env.AHOS_REPO ?? "anguspersonal/ahOS";
const REF = () => process.env.AHOS_REPO_REF ?? "dev";

/** The receipt text: local checkout first, else GitHub contents with the ingest/personal token. */
async function loadManifestText(): Promise<{ text: string; source: string }> {
	const local = manifestPath(defaultRepoRoot());
	if (existsSync(local)) return { text: readFileSync(local, "utf8"), source: local };

	const repo = REPO();
	const token = isWorkGithubRepo(repo)
		? process.env.GITHUB_WORK_ACCESS_TOKEN
		: (process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN_INGEST);
	if (!token)
		throw new Error(
			"no local checkout and GITHUB_PERSONAL_ACCESS_TOKEN (or legacy GITHUB_TOKEN_INGEST) is not set, so the receipt cannot be fetched",
		);
	const res = await fetch(
		`https://api.github.com/repos/${repo}/contents/.claude/skill-registry.json?ref=${encodeURIComponent(REF())}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github.raw+json",
				"User-Agent": "ahos-doctor",
			},
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!res.ok) throw new Error(`GitHub contents ${res.status} for ${repo}@${REF()}; the token may lack Contents: read`);
	return { text: await res.text(), source: `${repo}@${REF()}` };
}

export async function checkTravels(): Promise<DoctorCheck[]> {
	let caps: AhkmsCapability[];
	try {
		caps = await fetchCapabilityRows();
	} catch (err) {
		return [
			{
				family: "travels",
				name: "capability registry",
				status: "fail",
				detail: `could not read the registry: ${err instanceof Error ? err.message : String(err)}`,
				fix: "check the MCP server's SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and the entities table",
			},
		];
	}

	let pasted: PastedInstructionsRecord | null = null;
	try {
		pasted = await loadPastedInstructions();
	} catch {
		// degrade gracefully if DB read fails
	}

	let hotRows: HotTierRow[] = [];
	try {
		hotRows = await loadHotTier();
	} catch {
		// degrade gracefully if DB read fails
	}

	let manifest: RepoSkillManifest;
	let source: string;
	try {
		const loaded = await loadManifestText();
		manifest = parseManifest(loaded.text);
		source = loaded.source;
	} catch (err) {
		// Still audit what the registry alone can prove.
		return [
			{
				family: "travels",
				name: "skill receipts",
				status: "warn",
				detail: `receipt comparison not run: ${err instanceof Error ? err.message : String(err)}`,
				fix: `give GITHUB_TOKEN_INGEST Contents: read on ${REPO()}, or run \`npm run skill-sync --workspace=@ahkms/mcp-server -- repo status\` from a checkout`,
			},
			...classifyTravel({ version: 1, skills: {} }, caps, pasted, hotRows).filter((c) => c.name !== "repo skills in sync"),
		];
	}

	return classifyTravel(manifest, caps, pasted, hotRows).map((c) =>
		c.name === "repo skills in sync" ? { ...c, detail: `${c.detail} (receipt: ${source})` } : c,
	);
}
