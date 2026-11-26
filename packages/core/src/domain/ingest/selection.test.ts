import { describe, it, expect } from "vitest";
import {
	connectorOf,
	channelsForConnector,
	DISCOVERED_PREFIX,
	DRIVE_FOLDER_MIME,
	isDriveConnector,
	isEnrichablePointer,
	NOT_A_FOLDER_FILTER,
} from "./selection.js";

describe("isEnrichablePointer (#1228)", () => {
	it("never queues a Drive folder, whatever the Drive connector spelling", () => {
		for (const connector of ["gdrive", "gdrive_work", "google_drive", "drive"]) {
			expect(isEnrichablePointer(connector, DRIVE_FOLDER_MIME)).toBe(false);
		}
	});

	it("queues a Drive or OneDrive document, and a pointer whose mimeType was never recorded", () => {
		expect(isEnrichablePointer("gdrive", "application/pdf")).toBe(true);
		expect(isEnrichablePointer("gdrive", undefined)).toBe(true);
		expect(isEnrichablePointer("gdrive", null)).toBe(true);
		expect(
			isEnrichablePointer(
				"onedrive",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			),
		).toBe(true);
		expect(isEnrichablePointer("onedrive", undefined)).toBe(true);
	});

	it("still refuses a connector with no reader", () => {
		expect(isEnrichablePointer("notion", "application/pdf")).toBe(false);
	});

	it("matches the folder mimeType google/drive.ts isFolder() uses", () => {
		expect(DRIVE_FOLDER_MIME).toBe("application/vnd.google-apps.folder");
	});
});

describe("isDriveConnector", () => {
	it("is true for every Drive spelling and false otherwise", () => {
		for (const c of ["gdrive", "gdrive_work", "google_drive", "drive"]) {
			expect(isDriveConnector(c)).toBe(true);
		}
		for (const c of ["onedrive", "notion", "url", "toString", ""]) {
			expect(isDriveConnector(c)).toBe(false);
		}
	});
});

describe("NOT_A_FOLDER_FILTER (#1228)", () => {
	it("keeps rows with no recorded mimeType (the is.null arm) and drops only folders", () => {
		expect(NOT_A_FOLDER_FILTER.split(",")).toEqual([
			"processing_metadata->discovery->>mime_type.is.null",
			`processing_metadata->discovery->>mime_type.neq.${DRIVE_FOLDER_MIME}`,
		]);
	});

	it("carries no PostgREST logic-tree delimiter inside a value", () => {
		// Inside or=(...), an unquoted value ends at ',' or ')'. The folder mimeType has
		// neither, so it needs no quoting — pinned so a future value that does fails here.
		expect(DRIVE_FOLDER_MIME).not.toMatch(/[,()]/);
	});
});

describe("connectorOf", () => {
	it("prefers the connector recorded in discovery metadata", () => {
		expect(
			connectorOf({
				source_channel: "discovered_gdrive",
				processing_metadata: { discovery: { connector: "notion" } },
			}),
		).toBe("notion");
	});

	it("falls back to parsing the discovered_<connector> channel", () => {
		expect(
			connectorOf({ source_channel: "discovered_gdrive", processing_metadata: null }),
		).toBe("gdrive");
	});

	it("returns null when neither metadata nor channel yields a connector", () => {
		expect(connectorOf({ source_channel: "user-uploads", processing_metadata: {} })).toBeNull();
		expect(connectorOf({ source_channel: null, processing_metadata: null })).toBeNull();
	});

	it("ignores a non-string connector in metadata and falls back to the channel", () => {
		expect(
			connectorOf({
				source_channel: "discovered_gdrive",
				processing_metadata: { discovery: { connector: 123 as unknown as string } },
			}),
		).toBe("gdrive");
	});
});

describe("channelsForConnector", () => {
	const supported = ["gdrive", "google_drive", "drive"];

	it("targets a single channel when a connector is given", () => {
		expect(channelsForConnector("gdrive", supported)).toEqual(["discovered_gdrive"]);
	});

	it("targets a single channel even for an unsupported connector (caller decides)", () => {
		expect(channelsForConnector("notion", supported)).toEqual(["discovered_notion"]);
	});

	it("scopes to every supported connector when none is given", () => {
		expect(channelsForConnector(undefined, supported)).toEqual([
			"discovered_gdrive",
			"discovered_google_drive",
			"discovered_drive",
		]);
	});

	it("uses the shared DISCOVERED_PREFIX", () => {
		expect(channelsForConnector("x", [])[0]).toBe(`${DISCOVERED_PREFIX}x`);
	});
});
