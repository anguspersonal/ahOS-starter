import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../doctor/credentialChecks.js", () => ({ checkCredentials: vi.fn() }));
vi.mock("../doctor/wiringChecks.js", () => ({ checkWiring: vi.fn() }));
vi.mock("../doctor/travelChecks.js", () => ({ checkTravels: vi.fn() }));
vi.mock("../doctor/outcomeChecks.js", () => ({ checkOutcomes: vi.fn() }));

import {
	createAhosDoctorAction,
	DOCTOR_FAMILIES,
	executeAction,
	type AhosDoctorInput,
	type DoctorCheck,
	type DoctorFamily,
	type DoctorPort,
} from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import actionManifest from "@ahkms/core/action-manifest.json" with { type: "json" };
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { checkCredentials } from "../doctor/credentialChecks.js";
import { createDoctorPort } from "../doctor/index.js";
import { checkOutcomes } from "../doctor/outcomeChecks.js";
import { checkTravels } from "../doctor/travelChecks.js";
import { checkWiring } from "../doctor/wiringChecks.js";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";


async function connectClient() {
	const server = createServer();
	const client = new Client({ name: "ahos-doctor-action-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

const run = async (args: AhosDoctorInput = {}) => {
	const action = serverRegistry().get("ahos_doctor")!;
	return (await toMcpTool(action).handler(args)).content[0].text;
};

beforeEach(() => {
	vi.mocked(checkCredentials).mockReset().mockResolvedValue([
		{ family: "credentials", name: "notion_work", status: "ok", detail: "fine", fix: "" },
	]);
	vi.mocked(checkWiring).mockReset().mockResolvedValue([
		{ family: "wiring", name: "surface_role_map github", status: "warn", detail: "unmapped", fix: "add it" },
	]);
	vi.mocked(checkTravels).mockReset().mockResolvedValue([
		{ family: "travels", name: "skill dos", status: "fail", detail: "stale", fix: "push" },
	]);
	vi.mocked(checkOutcomes).mockReset().mockResolvedValue([
		{ family: "outcomes", name: "dos sweep closed work", status: "ok", detail: "closed", fix: "" },
	]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ahos_doctor", () => {
	it("runs every family by default and ends on the verdict", async () => {
		const text = await run();
		expect(text).toContain("## credentials");
		expect(text).toContain("## wiring");
		expect(text).toContain("## travels");
		expect(text).toContain("## outcomes");
		expect(text.trim().split("\n").at(-1)).toBe("verdict: FAIL — 1 fail, 1 warn, 2 ok.");
	});

	it("runs only the families asked for", async () => {
		const text = await run({ families: ["credentials"] });
		expect(checkWiring).not.toHaveBeenCalled();
		expect(checkTravels).not.toHaveBeenCalled();
		expect(text).toContain("verdict: OK");
	});

	it("turns a family that throws into a failed check instead of losing the whole report", async () => {
		vi.mocked(checkWiring).mockRejectedValue(new Error("supabase down"));
		const text = await run();
		expect(text).toContain("[FAIL] wiring: could not run: supabase down");
		expect(text).toContain("## credentials");
	});
});

describe("ahos_doctor action migration (#1602)", () => {
	it("case 1: contract parity (R11) — inputSchema.properties, required, annotations, and description match dev", async () => {
		const client = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "ahos_doctor");
		expect(tool).toBeDefined();

		const props = (tool!.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; items?: { enum?: string[] } }
		>;
		expect(Object.keys(props)).toEqual(["families"]);
		expect(props.families.type).toBe("array");
		expect(props.families.items?.enum).toEqual([...DOCTOR_FAMILIES]);
		expect(tool!.inputSchema.required ?? []).toEqual([]);

		expect(tool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(tool!.description).toBe(
			"Is ahOS correctly set up, and what is missing? One read-only pass over credentials (set under " +
				"which name, authenticates, right account), wiring (integration rows, dos pointers, " +
				"surface_role_map, Notion options), what travels (registered skills match the repo) and " +
				"outcomes (did the dos sweep close the days it should have). Each " +
				"finding carries its exact fix; nothing is changed. Full notes: docs/guides/tools/ahos_doctor.md",
		);
	});

	it("case 2: exposure — ahos_doctor is in action-manifest.json with mcp/http/ui_agent/worker true and cli/a2a false", () => {
		expect(actionManifest.actions.ahos_doctor).toBeDefined();
		expect(actionManifest.actions.ahos_doctor.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("case 3: registration path — ahos_doctor is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const ids = buildRegistry({}).list().map((a) => a.id);
		expect(ids).toContain("ahos_doctor");

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("ahos_doctor");
	});

	it("case 4: a family that rejects becomes one fail check naming that family while the other families still render", async () => {
		const port = createDoctorPort({
			credentials: async () => [
				{ family: "credentials", name: "notion_work", status: "ok", detail: "fine", fix: "" },
			],
			wiring: async () => {
				throw new Error("supabase down");
			},
			travels: async () => [
				{ family: "travels", name: "skill dos", status: "ok", detail: "fresh", fix: "" },
			],
			outcomes: async () => [
				{ family: "outcomes", name: "dos sweep closed work", status: "ok", detail: "closed", fix: "" },
			],
		});

		const output = await executeAction(createAhosDoctorAction(port), {});
		expect(output.report).toContain("[FAIL] wiring: could not run: supabase down");
		expect(output.report).toContain("## credentials");
		expect(output.report).toContain("## travels");
	});

	it("case 5: omitting families runs every family the port reports, including the ledger checks", async () => {
		const called: string[] = [];
		const port: DoctorPort = {
			families: ["credentials", "wiring", "travels", "ledger" as DoctorFamily],
			run: async (family): Promise<DoctorCheck[]> => {
				called.push(family);
				return [{ family, name: `${family} check`, status: "ok", detail: "ok", fix: "" }];
			},
		};

		const output = await executeAction(createAhosDoctorAction(port), {});
		expect(called).toEqual(["credentials", "wiring", "travels", "ledger"]);
		expect(output.report).toContain("## ledger");
	});
});
