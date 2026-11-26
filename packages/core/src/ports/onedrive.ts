/**
 * Isomorphic Microsoft OneDrive port for `@ahkms/core` (issue #2043).
 *
 * All binary payloads are represented as `Uint8Array` and all types are free of
 * `node:*` imports so `@ahkms/core` remains strictly isomorphic.
 */

export type OneDriveConflictBehavior = "fail" | "replace" | "rename";

export type OneDriveQuotaState =
	| "normal"
	| "nearing"
	| "critical"
	| "exceeded";

export interface OneDriveHashes {
	quickXorHash?: string;
	sha1Hash?: string;
	sha256Hash?: string;
}

export interface OneDriveQuota {
	id?: string;
	driveType?: string;
	owner?: {
		user?: {
			id?: string;
			displayName?: string;
			email?: string;
		};
	};
	total: number;
	used: number;
	remaining: number;
	deleted: number;
	state: OneDriveQuotaState;
}

export interface OneDriveItem {
	id: string;
	name: string;
	size?: number;
	createdDateTime?: string;
	lastModifiedDateTime?: string;
	webUrl?: string;
	eTag?: string;
	"@microsoft.graph.downloadUrl"?: string;
	parentReference?: {
		driveId?: string;
		id?: string;
		path?: string;
	};
	folder?: {
		childCount?: number;
	};
	file?: {
		mimeType?: string;
		hashes?: OneDriveHashes;
	};
	deleted?: {
		state?: string;
	};
}

export interface OneDriveItemList {
	items: OneDriveItem[];
	nextCursor?: string;
}

export interface OneDriveBatchDeleteFailure {
	itemId: string;
	status: number;
	error?: string;
}

export interface OneDriveBatchDeleteResult {
	deletedItemIds: string[];
	failed: OneDriveBatchDeleteFailure[];
}

export class OneDriveApiError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(
		message: string,
		opts: { status: number; code?: string; cause?: unknown },
	) {
		super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = "OneDriveApiError";
		this.status = opts.status;
		this.code = opts.code;
	}
}

export interface OneDrivePort {
	getQuota(): Promise<OneDriveQuota>;
	listChildren(params: {
		folderId?: string;
		path?: string;
		pageSize?: number;
		cursor?: string;
		orderBy?: string;
	}): Promise<OneDriveItemList>;
	searchItems(params: {
		query: string;
		folderId?: string;
		pageSize?: number;
		cursor?: string;
	}): Promise<OneDriveItemList>;
	getItemMetadata(params: {
		itemId?: string;
		path?: string;
	}): Promise<OneDriveItem>;
	downloadItemBytes(params: {
		itemId: string;
		maxBytes?: number;
	}): Promise<{ item: OneDriveItem; bytes: Uint8Array; mimeType: string }>;
	createFolder(params: {
		name: string;
		parentId?: string;
		conflictBehavior?: OneDriveConflictBehavior;
	}): Promise<OneDriveItem>;
	uploadFile(params: {
		name: string;
		parentId?: string;
		mimeType?: string;
		data: Uint8Array;
		conflictBehavior?: OneDriveConflictBehavior;
	}): Promise<OneDriveItem>;
	readLocalFile?(
		localPath: string,
	): Promise<{ bytes: Uint8Array; fileName: string }>;
	updateItem(params: {
		itemId: string;
		name?: string;
		newParentId?: string;
		conflictBehavior?: OneDriveConflictBehavior;
	}): Promise<OneDriveItem>;
	deleteItems(params: {
		itemIds: string[];
	}): Promise<OneDriveBatchDeleteResult>;
}
