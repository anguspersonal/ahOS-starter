/**
 * Webhook work ports (ADR-100, ADR-101, ADR-104 L1, ADR-105 L4).
 *
 * Abstracts the domain work triggered by inbound webhook deliveries after
 * HTTP signature/token verification and debounce coalescing have passed.
 */

/**
 * The slice of a Notion `page.properties_updated` webhook event consumed by
 * the `completed_at_stamp` automation rule.
 */
export interface NotionPagePropertiesUpdatedEvent {
	type?: string;
	timestamp?: string;
	entity?: {
		id?: string;
		type?: string;
	};
	data?: {
		updated_properties?: string[];
	};
}

/**
 * Outcome returned when evaluating a Notion `page.properties_updated` webhook event.
 */
export type NotionCompletedAtOutcome =
	| "unconfigured"
	| "ignored-no-page"
	| "ignored-other-data-source"
	| "ignored-status-unchanged"
	| "stamped"
	| "cleared"
	| "noop";

/**
 * Port for the Notion `completed_at_stamp` webhook automation rule.
 */
export interface NotionAutomationPort {
	handlePagePropertiesUpdated(
		event: NotionPagePropertiesUpdatedEvent,
	): Promise<NotionCompletedAtOutcome>;
}

export interface DriveDiscoverSweepOptions {
	channelId?: string;
}

/**
 * Port for reactive Google Drive discovery sweeps triggered by Drive push notifications.
 */
export interface DriveDiscoverPort {
	runDiscoverSweep(options?: DriveDiscoverSweepOptions): Promise<void>;
}
