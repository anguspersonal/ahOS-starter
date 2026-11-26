import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./driveDiscoverCadence.js", () => ({ runDriveDiscoverCadence: vi.fn() }));
vi.mock("./notionDiscoverCadence.js", () => ({ runNotionDiscoverCadence: vi.fn() }));
vi.mock("./gmailAttachmentDiscoverCadence.js", () => ({ runGmailAttachmentDiscoverCadence: vi.fn() }));

import { runDriveDiscoverCadence } from "./driveDiscoverCadence.js";
import { runNotionDiscoverCadence } from "./notionDiscoverCadence.js";
import { runGmailAttachmentDiscoverCadence } from "./gmailAttachmentDiscoverCadence.js";
import { runDiscoverCadence } from "./discoverCadence.js";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runDiscoverCadence", () => {
	it("runs the Drive, Notion and Gmail attachment connectors, each once", async () => {
		vi.mocked(runDriveDiscoverCadence).mockResolvedValue(undefined);
		vi.mocked(runNotionDiscoverCadence).mockResolvedValue(undefined);
		vi.mocked(runGmailAttachmentDiscoverCadence).mockResolvedValue(undefined);

		await runDiscoverCadence();

		expect(runDriveDiscoverCadence).toHaveBeenCalledTimes(1);
		expect(runNotionDiscoverCadence).toHaveBeenCalledTimes(1);
		expect(runGmailAttachmentDiscoverCadence).toHaveBeenCalledTimes(1);
	});

	it("runs Drive, then Notion, then Gmail attachments", async () => {
		const order: string[] = [];
		vi.mocked(runDriveDiscoverCadence).mockImplementation(async () => {
			order.push("drive");
		});
		vi.mocked(runNotionDiscoverCadence).mockImplementation(async () => {
			order.push("notion");
		});
		// Last on purpose (#1210): its first runs drain a mailbox backlog, and that must
		// never delay the two connectors that are already live.
		vi.mocked(runGmailAttachmentDiscoverCadence).mockImplementation(async () => {
			order.push("gmail_attachment");
		});

		await runDiscoverCadence();

		expect(order).toEqual(["drive", "notion", "gmail_attachment"]);
	});
});
