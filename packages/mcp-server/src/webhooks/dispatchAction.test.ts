import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import {
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
} from "@ahkms/core";

const { handleNotionPagePropertiesUpdatedMock, runDriveDiscoverCadenceMock } =
	vi.hoisted(() => ({
		handleNotionPagePropertiesUpdatedMock: vi.fn(async () => "stamped" as const),
		runDriveDiscoverCadenceMock: vi.fn(async () => undefined),
	}));

vi.mock("../automations/completedAtStamp.js", () => ({
	handleNotionPagePropertiesUpdated: handleNotionPagePropertiesUpdatedMock,
}));

vi.mock("../schedule/driveDiscoverCadence.js", () => ({
	runDriveDiscoverCadence: runDriveDiscoverCadenceMock,
}));

vi.mock("../identity.js", () => ({
	getCurrentUserId: () => "00000000-0000-0000-0000-000000000001",
}));

import { notionWebhookRouter } from "./notionWebhook.js";
import { driveWebhookRouter } from "./driveWebhook.js";
import { LoginRateLimiter } from "../auth/loginRateLimiter.js";

const NOTION_TOKEN = "secret_notion_verification_token";
const DRIVE_TOKEN = "secret_drive_webhook_token";

function signNotion(body: string, token: string = NOTION_TOKEN): string {
	return `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
}

const NOTION_EVENT = {
	type: "page.properties_updated",
	timestamp: "2026-10-15T12:00:00.000Z",
	entity: { id: "page-1", type: "page" },
	data: { updated_properties: ["XGe%40"] },
};

const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

describe("Webhook registry action dispatch (ADR-104 L1, ADR-105 L4, #1524)", () => {
	let auditRecords: ActionAuditRecord[];

	beforeEach(() => {
		auditRecords = [];
		setDefaultAuditSink((record) => {
			auditRecords.push(record);
		});
		handleNotionPagePropertiesUpdatedMock.mockClear();
		runDriveDiscoverCadenceMock.mockClear();
	});

	afterEach(() => {
		setDefaultAuditSink(stderrAuditSink);
		vi.restoreAllMocks();
	});

	it("Notion receiver: signed page.properties_updated delivery dispatches notion_completed_at_stamp and produces one audit record; unsigned produces zero", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		app.use(
			"/webhooks/notion",
			notionWebhookRouter({ verificationToken: NOTION_TOKEN }),
		);

		const body = JSON.stringify(NOTION_EVENT);

		// Unsigned delivery -> 401, zero audit records, zero port calls
		const unsignedRes = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.send(body);
		await flushImmediate();

		expect(unsignedRes.status).toBe(401);
		expect(auditRecords).toHaveLength(0);
		expect(handleNotionPagePropertiesUpdatedMock).not.toHaveBeenCalled();

		// Signed delivery -> 200, one audit record with actionId: "notion_completed_at_stamp", caller: "http", outcome: "success"
		const signedRes = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.set("X-Notion-Signature", signNotion(body))
			.send(body);
		await flushImmediate();
		await flushImmediate();

		expect(signedRes.status).toBe(200);
		await vi.waitFor(() => expect(handleNotionPagePropertiesUpdatedMock).toHaveBeenCalledTimes(1));
		expect(handleNotionPagePropertiesUpdatedMock).toHaveBeenCalledWith(NOTION_EVENT);
		await vi.waitFor(() => expect(auditRecords).toHaveLength(1));
		expect(auditRecords[0]).toMatchObject({
			actionId: "notion_completed_at_stamp",
			caller: "http",
			outcome: "success",
			userId: "00000000-0000-0000-0000-000000000001",
		});
	});

	it("Drive receiver: burst of valid notifications coalesces into one sweep and one drive_discover_sweep audit record", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const app = express();
		app.use(
			"/webhooks/drive",
			driveWebhookRouter({
				webhookToken: DRIVE_TOKEN,
				debounceMs: 25,
				rateLimiter: new LoginRateLimiter(),
			}),
		);

		const sendNotification = () =>
			request(app)
				.post("/webhooks/drive")
				.set("X-Goog-Channel-ID", "channel-xyz")
				.set("X-Goog-Resource-ID", "res-12345")
				.set("X-Goog-Resource-State", "change")
				.set("X-Goog-Channel-Token", DRIVE_TOKEN);

		const responses = await Promise.all(
			Array.from({ length: 5 }, () => sendNotification()),
		);
		expect(responses.every((r) => r.status === 200)).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 75));

		await vi.waitFor(() => expect(runDriveDiscoverCadenceMock).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(auditRecords).toHaveLength(1));
		expect(auditRecords[0]).toMatchObject({
			actionId: "drive_discover_sweep",
			caller: "http",
			outcome: "success",
			userId: "00000000-0000-0000-0000-000000000001",
		});
	});
});
