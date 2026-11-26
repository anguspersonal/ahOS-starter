import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashBody } from "./hash.js";

// A controllable ahkms map, injected via the mock below (no env / no network).
type Cap = { name: string; kind: string; storageLocation: string; body: string | null; bodySyncedAt: string | null };
const caps = new Map<string, Cap>();
vi.mock("./ahkmsSource.js", () => ({
	fetchSkillCapabilities: () => Promise.resolve(caps),
}));

const { initBases } = await import("./init.js");
const { getBaseHash, readSyncState, setBase } = await import("./syncState.js");

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-init-"));
	caps.clear();
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function skill(name: string, body: string): void {
	mkdirSync(join(home, name), { recursive: true });
	writeFileSync(join(home, name, "SKILL.md"), body, "utf8");
}
function cap(name: string, body: string | null): void {
	caps.set(name.toLowerCase(), { name, kind: "skill", storageLocation: "kms-db", body, bodySyncedAt: null });
}

describe("initBases", () => {
	it("bases a skill whose local == ahkms", async () => {
		skill("qa", "same body\n");
		cap("qa", "same body\n");
		const [r] = await initBases(home);
		expect(r.outcome).toBe("based");
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("same body\n"));
	});

	it("leaves a divergent skill unbased (never guesses a winner)", async () => {
		skill("d", "local\n");
		cap("d", "ahkms\n");
		const [r] = await initBases(home);
		expect(r.outcome).toBe("unbased");
		expect(getBaseHash(readSyncState(home), "d")).toBeNull();
	});

	it("leaves a skill with no ahkms body unbased", async () => {
		skill("i", "local\n");
		cap("i", null); // indexed — no kms-db body to base against
		const [r] = await initBases(home);
		expect(r.outcome).toBe("unbased");
	});

	it("skips an already-based skill without reclobbering its base", async () => {
		skill("b", "x\n");
		cap("b", "x\n");
		setBase(home, "b", "pre-existing", "2026-07-15T00:00:00Z");
		const [r] = await initBases(home);
		expect(r.outcome).toBe("skipped");
		expect(getBaseHash(readSyncState(home), "b")).toBe("pre-existing");
	});
});
