import { describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../buildRegistry.js";
import { executeAction } from "../adapters/direct.js";
import type {
	DriveDiscoverPort,
	NotionAutomationPort,
	NotionPagePropertiesUpdatedEvent,
} from "../../ports/webhookWork.js";

describe("webhook actions (ADR-104 L1, ADR-105 L4, #1524)", () => {
	it("registers notion_completed_at_stamp and drive_discover_sweep in buildRegistry as worker-only app_internal actions", () => {
		const registry = buildRegistry({});

		const notionAction = registry.get("notion_completed_at_stamp");
		expect(notionAction).toBeDefined();
		expect(notionAction!.expose).toEqual({
			mcp: false,
			http: false,
			ui_agent: false,
			worker: true,
			cli: false,
			a2a: false,
			reason: "app_internal",
			note: expect.any(String),
		});
		expect(notionAction!.expose.note!.length).toBeGreaterThan(0);

		const driveAction = registry.get("drive_discover_sweep");
		expect(driveAction).toBeDefined();
		expect(driveAction!.expose).toEqual({
			mcp: false,
			http: false,
			ui_agent: false,
			worker: true,
			cli: false,
			a2a: false,
			reason: "app_internal",
			note: expect.any(String),
		});
		expect(driveAction!.expose.note!.length).toBeGreaterThan(0);
	});

	it("notion_completed_at_stamp runs its NotionAutomationPort once with the parsed event input", async () => {
		const handlePagePropertiesUpdated = vi.fn(async () => "stamped" as const);
		const notionAutomation: NotionAutomationPort = {
			handlePagePropertiesUpdated,
		};

		const registry = buildRegistry({ notionAutomation });
		const action = registry.get("notion_completed_at_stamp")!;

		const event: NotionPagePropertiesUpdatedEvent = {
			type: "page.properties_updated",
			timestamp: "2026-10-15T12:00:00.000Z",
			entity: { id: "page-123", type: "page" },
			data: { updated_properties: ["XGe%40"] },
		};

		const outcome = await executeAction(action, event);
		expect(outcome).toBe("stamped");
		expect(handlePagePropertiesUpdated).toHaveBeenCalledTimes(1);
		expect(handlePagePropertiesUpdated).toHaveBeenCalledWith(event);
	});

	it("drive_discover_sweep runs its DriveDiscoverPort once with the parsed input", async () => {
		const runDiscoverSweep = vi.fn(async () => undefined);
		const driveDiscover: DriveDiscoverPort = {
			runDiscoverSweep,
		};

		const registry = buildRegistry({ driveDiscover });
		const action = registry.get("drive_discover_sweep")!;

		await executeAction(action, {});
		expect(runDiscoverSweep).toHaveBeenCalledTimes(1);
	});

	it("drive_discover_sweep forwards channelId to DriveDiscoverPort when provided", async () => {
		const runDiscoverSweep = vi.fn(async () => undefined);
		const driveDiscover: DriveDiscoverPort = {
			runDiscoverSweep,
		};

		const registry = buildRegistry({ driveDiscover });
		const action = registry.get("drive_discover_sweep")!;

		await executeAction(action, { channelId: "chan-work-1" });
		expect(runDiscoverSweep).toHaveBeenCalledTimes(1);
		expect(runDiscoverSweep).toHaveBeenCalledWith({ channelId: "chan-work-1" });
	});
});
