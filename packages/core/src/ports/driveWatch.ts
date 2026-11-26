/**
 * @ahkms/core/ports - driveWatch.ts
 *
 * Port interface for Google Drive changes.watch push notification channel
 * registration, renewal, and persistence (ADR-048, ADR-101, Issue #1348).
 */

export interface StoredDriveWatchChannel {
	id: string;
	resourceId: string;
	expiration: string;
	address: string;
	account: string;
	updatedAt: string;
	pageToken?: string;
}

export interface RawDriveChangeFile {
	id?: string | null;
	name?: string | null;
	mimeType?: string | null;
	trashed?: boolean | null;
	size?: string | null;
	parents?: string[] | null;
	modifiedTime?: string | null;
	createdTime?: string | null;
	owners?: Array<{ displayName?: string | null; emailAddress?: string | null }> | null;
	webViewLink?: string | null;
	md5Checksum?: string | null;
}

export interface RawDriveChange {
	fileId?: string | null;
	removed?: boolean | null;
	time?: string | null;
	file?: RawDriveChangeFile | null;
}

export type DriveChangesPageResult =
	| {
			expired: true;
	  }
	| {
			expired?: false;
			changes: RawDriveChange[];
			nextPageToken?: string | null;
			newStartPageToken?: string | null;
	  };

export interface ListDriveChangesParams {
	account: string;
	pageToken: string;
	pageSize?: number;
	includeRemoved?: boolean;
	includeItemsFromAllDrives?: boolean;
}

export interface DriveChangesPort {
	listChanges(params: ListDriveChangesParams): Promise<DriveChangesPageResult>;
	getStartPageToken?(account: string): Promise<string>;
}

export interface DriveWatchPorts {
	/**
	 * Retrieve the active stored Drive watch channel for a specific account.
	 * Returns null if no channel is stored for this account.
	 */
	getStoredChannel(account: string): Promise<StoredDriveWatchChannel | null>;

	/**
	 * Persist the active Drive watch channel for a specific account.
	 */
	saveChannel(channel: StoredDriveWatchChannel): Promise<void>;

	/**
	 * Register a changes.watch notification channel on Google Drive for the given account.
	 * Returns the channel registration details (id, resourceId, expiration, pageToken).
	 */
	registerWatch(params: {
		account: string;
		channelId: string;
		address: string;
		token: string;
	}): Promise<{ id: string; resourceId: string; expiration: string; pageToken?: string }>;

	/**
	 * Stop receiving push notifications for a retiring channel on Google Drive.
	 * Safe against already-expired or non-existent channels.
	 */
	stopWatch(params: {
		account: string;
		channelId: string;
		resourceId: string;
	}): Promise<void>;

	/**
	 * List all Google account identifiers configured for Drive watch.
	 */
	listAccounts(): Promise<string[]>;

	/**
	 * Optional change-feed listing and start-token methods.
	 */
	listChanges?: DriveChangesPort["listChanges"];
	getStartPageToken?: DriveChangesPort["getStartPageToken"];
}
