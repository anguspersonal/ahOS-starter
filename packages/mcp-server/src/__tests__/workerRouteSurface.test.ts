import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	HTTP_ROUTE_EXEMPTION_REASONS,
	type HttpRouteExemptionReason,
} from "../actions/httpRouteExemptions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_APP_JS_PATH = path.resolve(__dirname, "../../../worker/app.js");
const WORKER_ROUTE_SURFACE_PATH = path.resolve(
	__dirname,
	"../../../worker/route-surface.json",
);

export interface WorkerRouteExemption {
	reason: HttpRouteExemptionReason | string;
	note: string;
}

export interface WorkerRouteSurface {
	exemptions: Record<string, WorkerRouteExemption>;
	pending_migration: Record<string, string>;
}

/**
 * Scan packages/worker/app.js source text to collect mounted routes.
 * Collects the first argument of every app.(get|post|put|patch|delete|all|use) call
 * that is a string literal, plus "static" for app.use(express.static(...)).
 * Pathless middleware (cors, express.json, requestLogger, errorHandler, the 404 handler)
 * is not a route; a path mounted twice (/api/pdf for express.raw and the router) counts once.
 */
export function collectWorkerRoutes(content: string): Set<string> {
	const routes = new Set<string>();
	const appCallRegex =
		/\bapp\.(?:get|post|put|patch|delete|all|use)\s*\(\s*(?:(['"])(.*?)\1|(express\.static)\s*\()/g;
	let match: RegExpExecArray | null;
	while ((match = appCallRegex.exec(content)) !== null) {
		if (match[3] === "express.static") {
			routes.add("static");
		} else if (match[2] !== undefined) {
			routes.add(match[2]);
		}
	}
	return routes;
}

/**
 * Verify a collected worker route set against a route-surface declaration.
 * Returns a list of human-readable failure messages (empty when valid).
 */
export function verifyWorkerRouteSurface(
	collectedRoutes: Set<string>,
	surface: WorkerRouteSurface,
): string[] {
	const errors: string[] = [];
	const exemptionKeys = new Set(Object.keys(surface.exemptions ?? {}));
	const pendingKeys = new Set(Object.keys(surface.pending_migration ?? {}));

	for (const key of exemptionKeys) {
		if (pendingKeys.has(key)) {
			errors.push(
				`Route "${key}" appears in both exemptions and pending_migration; it must be in exactly one.`,
			);
		}
	}

	const declaredKeys = new Set([...exemptionKeys, ...pendingKeys]);

	for (const route of collectedRoutes) {
		if (!declaredKeys.has(route)) {
			errors.push(
				`Unlisted worker route "${route}": write it as a core action served on /api/actions (ADR-105); an exemption needs review:architect`,
			);
		}
	}

	for (const declared of declaredKeys) {
		if (!collectedRoutes.has(declared)) {
			errors.push(
				`Stale route "${declared}" in packages/worker/route-surface.json is not mounted in packages/worker/app.js.`,
			);
		}
	}

	for (const [route, entry] of Object.entries(surface.exemptions ?? {})) {
		if (!(HTTP_ROUTE_EXEMPTION_REASONS as readonly string[]).includes(entry.reason)) {
			errors.push(
				`Exemption reason "${entry.reason}" for worker route "${route}" is not in HTTP_ROUTE_EXEMPTION_REASONS.`,
			);
		}
		if (!entry.note || entry.note.trim().length === 0) {
			errors.push(`Exemption note for worker route "${route}" must not be empty.`);
		}
	}

	for (const [route, issueRef] of Object.entries(surface.pending_migration ?? {})) {
		if (!/^#\d+$/.test(issueRef)) {
			errors.push(
				`pending_migration entry for worker route "${route}" must name an issue (#NNNN), got "${issueRef}".`,
			);
		}
	}

	return errors;
}

describe("worker route surface (#1513, ADR-105)", () => {
	it("collects every route mounted in packages/worker/app.js (5 exempted routes) and ignores pathless middleware", () => {
		const appJs = fs.readFileSync(WORKER_APP_JS_PATH, "utf-8");
		const collected = collectWorkerRoutes(appJs);

		expect(collected.size).toBe(5);
		expect(Array.from(collected).sort()).toEqual(
			[
				"/",
				"/api/pdf",
				"/api/upload",
				"/health",
				"static",
			].sort(),
		);
	});

	it("matches packages/worker/route-surface.json with valid exemption reasons and an empty pending_migration map", () => {
		const appJs = fs.readFileSync(WORKER_APP_JS_PATH, "utf-8");
		const surface = JSON.parse(
			fs.readFileSync(WORKER_ROUTE_SURFACE_PATH, "utf-8"),
		) as WorkerRouteSurface;

		const collected = collectWorkerRoutes(appJs);
		const errors = verifyWorkerRouteSurface(collected, surface);
		expect(errors).toEqual([]);
		expect(surface.pending_migration).toEqual({});
	});

	it("fails with the ADR-105 remediation message when a new route is mounted", () => {
		const appJs =
			fs.readFileSync(WORKER_APP_JS_PATH, "utf-8") +
			"\napp.post('/api/unregistered', (req, res) => res.json({}));\n";
		const surface = JSON.parse(
			fs.readFileSync(WORKER_ROUTE_SURFACE_PATH, "utf-8"),
		) as WorkerRouteSurface;

		const collected = collectWorkerRoutes(appJs);
		const errors = verifyWorkerRouteSurface(collected, surface);
		expect(errors).toEqual([
			expect.stringContaining(
				"write it as a core action served on /api/actions (ADR-105); an exemption needs review:architect",
			),
		]);
	});

	it("fails when a declared route is stale, overlaps, or has an invalid reason or issue ref", () => {
		const collected = new Set(["/health", "static"]);
		const surface: WorkerRouteSurface = {
			exemptions: {
				"/health": { reason: "invalid_reason", note: "" },
				"static": { reason: "public_unauthenticated", note: "ok" },
				"/stale": { reason: "health", note: "stale" },
			},
			pending_migration: {
				"static": "1542",
			},
		};

		const errors = verifyWorkerRouteSurface(collected, surface);
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('appears in both exemptions and pending_migration'),
				expect.stringContaining('Stale route "/stale"'),
				expect.stringContaining('Exemption reason "invalid_reason"'),
				expect.stringContaining('Exemption note for worker route "/health" must not be empty'),
				expect.stringContaining('must name an issue (#NNNN)'),
			]),
		);
	});
});
