/**
 * @ahkms/core/engine/cadences - driveWatchCadence.ts
 *
 * Automated Google Drive changes.watch registration and renewal cadence
 * for /webhooks/drive (ADR-048, ADR-101, Issue #1348).
 *
 * Checks active push notification channels across configured Google accounts.
 * If a channel is missing or expiring within the renewal window (default 24h),
 * registers a new channel, persists its credentials in database storage, and
 * stops the retiring channel via channels.stop.
 *
 * Polling discover cadence remains the active safety net.
 */

import type { CadenceDefinition } from "../runner.js";
import type { ActionLookup } from "../../actions/approvals.js";
import {
	createDriveWatchRenewAction,
	DEFAULT_RENEWAL_WINDOW_MS,
} from "../../actions/engine/driveWatchRenew.js";
import type { ActionAuditSink } from "../../actions/types.js";
import type { DriveWatchPorts } from "../../ports/driveWatch.js";
import { actionCadence } from "./actionCadence.js";

export { DEFAULT_RENEWAL_WINDOW_MS };
export const DEFAULT_DRIVE_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface DriveWatchCadenceOptions {
	ports?: DriveWatchPorts;
	registry?: ActionLookup;
	webhookBaseUrl: string;
	webhookToken: string;
	renewalWindowMs?: number;
	intervalMs?: number;
	enabled?: () => boolean;
	auditSink?: ActionAuditSink;
}

export function createDriveWatchCadence(options: DriveWatchCadenceOptions): CadenceDefinition {
	const renewalWindowMs = options.renewalWindowMs ?? DEFAULT_RENEWAL_WINDOW_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_DRIVE_WATCH_INTERVAL_MS;
	const action = options.ports ? createDriveWatchRenewAction(options.ports) : undefined;

	return actionCadence({
		name: "drive-watch",
		intervalMs,
		actionId: "drive_watch_renew",
		registry: options.registry,
		action,
		input: {
			webhookBaseUrl: options.webhookBaseUrl,
			webhookToken: options.webhookToken,
			renewalWindowMs,
		},
		enabled: options.enabled ?? (() => true),
		auditSink: options.auditSink,
	});
}

