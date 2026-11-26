/**
 * CLI entry point for the `get_dos_coverage_days` parity check (#2264, ADR-119).
 * All logic lives in src/dosCoverageParity.ts (unit-tested there); this wrapper wires
 * the real client and prints the report.
 *
 * READ-ONLY: selects on `artifacts` and `artifact_external_links`, `rpc` calls to the
 * function, and today's `getSynthesisCoverage`. It writes nothing.
 *
 * Run it after migration 158 is pushed and before any reader switches (#2310, #2312):
 *
 *   npm --workspace @ahkms/mcp-server run dos-coverage-parity
 *
 * It checks the 92-day coverage window and the full streak history (`p_from` NULL),
 * unscoped and for each domain's provider. It exits non-zero when the function and the
 * TypeScript oracle differ anywhere, when a difference from the live read is
 * `unexplained`, or when the function is missing.
 */
import { MAX_COVERAGE_DAYS } from "@ahkms/core";
import { DOMAINS, DOMAIN_PROVIDER, type Domain } from "../src/domains.js";
import {
	CoverageFunctionMissingError,
	formatParityReport,
	runDosCoverageParity,
	type ParityClient,
	type ParityScope,
} from "../src/dosCoverageParity.js";
import { getCurrentUserId } from "../src/identity.js";
import { getSynthesisCoverage } from "../src/links.js";
import { supabase } from "../src/supabase.js";

const scopes: ParityScope[] = [
	{ label: "unscoped", domain: undefined, provider: null },
	...DOMAINS.map((domain) => ({
		label: `${domain} (${DOMAIN_PROVIDER[domain]})`,
		domain,
		provider: DOMAIN_PROVIDER[domain],
	})),
];

try {
	const report = await runDosCoverageParity({
		client: supabase as unknown as ParityClient,
		userId: getCurrentUserId(),
		today: new Date().toISOString().slice(0, 10),
		windowDays: MAX_COVERAGE_DAYS,
		scopes,
		liveCoverage: (from, to, domain) => getSynthesisCoverage(from, to, domain as Domain | undefined),
		log: (line) => console.log(`[dos-coverage-parity] ${line}`),
	});
	for (const line of formatParityReport(report)) console.log(line);
	process.exit(report.ok ? 0 : 1);
} catch (err) {
	console.error(
		err instanceof CoverageFunctionMissingError
			? err.message
			: `[dos-coverage-parity] failed: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
}
