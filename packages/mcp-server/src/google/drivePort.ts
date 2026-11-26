import type { DrivePort } from "@ahkms/core";
import { createGoogleDriveAdapter } from "@ahkms/core/adapters";
import { googleAuthConfig } from "./googleAuth.js";
import { readLocalFile } from "./localFile.js";

/** Shared DrivePort composition for drive_* tools (ADR-101 §1, ADR-045, #1586). */
export const drivePort: DrivePort = {
	...createGoogleDriveAdapter(googleAuthConfig),
	readLocalFile,
};
