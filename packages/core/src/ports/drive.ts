import type { Domain } from "../domain/domains.js";

export class DriveApiError extends Error {
	readonly status: number;
	readonly reason?: string;
	readonly googleStatus?: string;
	constructor(message: string, status: number, reason?: string, googleStatus?: string) {
		super(message);
		this.name = "DriveApiError";
		this.status = status;
		this.reason = reason;
		this.googleStatus = googleStatus;
	}
}

export interface DriveFileOwner { displayName?: string | null; emailAddress?: string | null; me?: boolean | null }
export interface DriveFile {
	id?: string | null; name?: string | null; mimeType?: string | null; size?: string | null; version?: string | null;
	modifiedTime?: string | null; createdTime?: string | null; owners?: DriveFileOwner[] | null;
	parents?: string[] | null; webViewLink?: string | null; trashed?: boolean | null;
	shared?: boolean | null; iconLink?: string | null;
	md5Checksum?: string | null; sha256Checksum?: string | null;
}
export interface DriveFileList { files: DriveFile[]; nextPageToken?: string | null; incompleteSearch?: boolean | null }
export interface DrivePermission {
	id?: string | null; type?: string | null; role?: string | null;
	emailAddress?: string | null; domain?: string | null; displayName?: string | null;
}
export interface DrivePermissionList { permissions: DrivePermission[]; nextPageToken?: string | null }
export interface DriveStorageQuota {
	limit?: string | null; usage?: string | null; usageInDrive?: string | null; usageInDriveTrash?: string | null;
}
export interface DriveAbout { user?: DriveFileOwner | null; storageQuota?: DriveStorageQuota | null }
export interface GetDriveAboutParams { domain: Domain; fields?: string }
export interface GetDriveFileParams { domain: Domain; fileId: string; fields?: string }
export interface ListDriveFilesParams {
	domain: Domain; q?: string; pageSize?: number; pageToken?: string; orderBy?: string; fields?: string;
}
export interface ListDrivePermissionsParams {
	domain: Domain; fileId: string; pageSize?: number; pageToken?: string; fields?: string;
}
export interface UpdateDriveFileContentParams {
	domain: Domain; fileId: string; mimeType: string; body: Uint8Array | string;
	keepRevisionForever?: boolean; boundary?: string; fields?: string;
}
export interface LocalFileReadResult {
	bytes: Uint8Array;
	name: string;
}
export type LocalFileReader = (path: string) => Promise<LocalFileReadResult>;
export interface UploadDriveFileOptions {
	name: string;
	folderId?: string;
	parents?: string[];
	targetMimeType?: string;
	mimeType: string;
	data?: Uint8Array | string;
	body?: Uint8Array | string;
	boundary?: string;
	fields?: string;
}
export interface UploadDriveFileParams extends UploadDriveFileOptions {
	domain: Domain;
}
export interface DownloadDriveFileParams {
	domain: Domain;
	fileId: string;
	maxBytes?: number;
}
export interface DownloadDriveFileWithMimeParams {
	domain: Domain;
	fileId: string;
	mimeType: string | null | undefined;
	maxBytes?: number;
}
export interface DownloadedDriveFile {
	bytes: Uint8Array;
	mimeType: string;
	extension: string | null;
}
export interface ExportDriveFileParams {
	domain: Domain;
	fileId: string;
	mimeType: string;
	maxBytes?: number;
}
export interface CountDocumentTabsParams {
	domain: Domain;
	fileId: string;
}
export interface TrashDriveFileParams {
	domain: Domain;
	fileId: string;
	fields?: string;
}
export interface DeleteDriveFileParams {
	domain: Domain;
	fileId: string;
}
export interface DeleteDrivePermissionParams {
	domain: Domain;
	fileId: string;
	permissionId: string;
}
export type DrivePermissionRole =
	| "reader"
	| "commenter"
	| "writer"
	| "fileOrganizer"
	| "organizer"
	| "owner";
export type DrivePermissionType = "user" | "group" | "domain" | "anyone";
export interface CreateDrivePermissionParams {
	domain: Domain;
	fileId: string;
	role: DrivePermissionRole;
	type: DrivePermissionType;
	emailAddress?: string;
	granteeDomain?: string;
	sendNotificationEmail?: boolean;
	transferOwnership?: boolean;
	fields?: string;
}
export interface UpdateDriveFilePatch {
	name?: string;
	trashed?: boolean;
	addParents?: string;
	removeParents?: string;
	fields?: string;
}
export interface UpdateDriveFileParams extends UpdateDriveFilePatch {
	domain: Domain;
	fileId: string;
}
export interface DriveFileMedia {
	mimeType: string;
	body: Uint8Array | string;
}
export interface CreateDriveFileMetadata {
	name: string;
	mimeType?: string;
	parents?: string[];
	media?: DriveFileMedia;
	boundary?: string;
	fields?: string;
}
export interface CreateDriveFileParams extends CreateDriveFileMetadata {
	domain: Domain;
}
export interface CopyDriveFileOptions {
	name?: string;
	parents?: string[];
	fields?: string;
}
export interface CopyDriveFileParams extends CopyDriveFileOptions {
	domain: Domain;
	fileId: string;
}
export interface DriveRevision {
	id?: string | null; modifiedTime?: string | null; lastModifyingUser?: DriveFileOwner | null;
	keepForever?: boolean | null; size?: string | null; md5Checksum?: string | null;
	mimeType?: string | null; originalFilename?: string | null; exportLinks?: Record<string, string> | null;
}
export interface DriveRevisionList { revisions: DriveRevision[]; nextPageToken?: string | null }
export interface ListDriveRevisionsParams { domain: Domain; fileId: string; pageSize?: number; pageToken?: string; fields?: string }
export interface GetDriveRevisionParams { domain: Domain; fileId: string; revisionId: string; fields?: string }
export interface DownloadDriveRevisionParams { domain: Domain; fileId: string; revisionId: string; exportUrl?: string; maxBytes?: number }
export interface UpdateDriveRevisionParams { domain: Domain; fileId: string; revisionId: string; keepForever: boolean; fields?: string }
export interface DeleteDriveRevisionParams { domain: Domain; fileId: string; revisionId: string }
export interface DriveQuotedFileContent { mimeType?: string | null; value?: string | null }
export interface DriveCommentReply {
	id?: string | null; content?: string | null; author?: DriveFileOwner | null;
	createdTime?: string | null; modifiedTime?: string | null; action?: string | null; deleted?: boolean | null;
}
export interface DriveComment {
	id?: string | null; content?: string | null; author?: DriveFileOwner | null;
	createdTime?: string | null; modifiedTime?: string | null; resolved?: boolean | null;
	deleted?: boolean | null; quotedFileContent?: DriveQuotedFileContent | null; replies?: DriveCommentReply[] | null;
}
export interface DriveCommentList { comments: DriveComment[]; nextPageToken?: string | null }
export interface DriveReplyList { replies: DriveCommentReply[]; nextPageToken?: string | null }
export interface ListDriveCommentsParams {
	domain: Domain; fileId: string; pageSize?: number; pageToken?: string; includeDeleted?: boolean; fields?: string;
}
export interface GetDriveCommentParams {
	domain: Domain; fileId: string; commentId: string; includeDeleted?: boolean; fields?: string;
}
export interface ListDriveRepliesParams {
	domain: Domain; fileId: string; commentId: string; pageSize?: number; pageToken?: string; includeDeleted?: boolean; fields?: string;
}
export interface CreateDriveCommentParams {
	domain: Domain; fileId: string; content: string; quotedFileContent?: DriveQuotedFileContent; fields?: string;
}
export interface CreateDriveReplyParams {
	domain: Domain; fileId: string; commentId: string; content?: string; action?: string; fields?: string;
}
export interface UpdateDriveCommentParams {
	domain: Domain; fileId: string; commentId: string; content: string; fields?: string;
}
export interface DeleteDriveCommentParams {
	domain: Domain; fileId: string; commentId: string;
}

export interface DrivePort {
	getAbout?(params: GetDriveAboutParams): Promise<DriveAbout>;
	getFile(params: GetDriveFileParams): Promise<DriveFile>;
	listFiles(params: ListDriveFilesParams): Promise<DriveFileList>;
	listPermissions(params: ListDrivePermissionsParams): Promise<DrivePermission[]>;
	listPermissionsPage?(params: ListDrivePermissionsParams): Promise<DrivePermissionList>;
	updateFileContent?(params: UpdateDriveFileContentParams): Promise<DriveFile>;
	createFile(
		domainOrParams: Domain | CreateDriveFileParams,
		metadata?: CreateDriveFileMetadata,
	): Promise<DriveFile>;
	copyFile(
		domainOrParams: Domain | CopyDriveFileParams,
		fileId?: string,
		options?: CopyDriveFileOptions,
	): Promise<DriveFile>;
	uploadFile(
		domainOrParams: Domain | UploadDriveFileParams,
		options?: UploadDriveFileOptions,
	): Promise<DriveFile>;
	readLocalFile?: LocalFileReader;
	downloadFile(domain: Domain, fileId: string, mimeType?: string | null): Promise<DownloadedDriveFile>;
	downloadFile(params: DownloadDriveFileWithMimeParams): Promise<DownloadedDriveFile>;
	downloadFile(params: DownloadDriveFileParams): Promise<Uint8Array>;
	downloadFile(
		domainOrParams: Domain | DownloadDriveFileParams | DownloadDriveFileWithMimeParams,
		fileId?: string,
		mimeType?: string | null,
	): Promise<DownloadedDriveFile | Uint8Array>;
	exportFile(
		domainOrParams: Domain | ExportDriveFileParams,
		fileId?: string,
		mimeType?: string,
	): Promise<Uint8Array>;
	countDocumentTabs?(
		domainOrParams: Domain | CountDocumentTabsParams,
		fileId?: string,
	): Promise<number>;
	updateFile(
		domainOrParams: Domain | UpdateDriveFileParams,
		fileId?: string,
		patch?: UpdateDriveFilePatch,
	): Promise<DriveFile>;
	trashFile(params: TrashDriveFileParams): Promise<DriveFile>;
	deleteFile?(
		domainOrParams: Domain | DeleteDriveFileParams,
		fileId?: string,
	): Promise<void>;
	deletePermission?(
		domainOrParams: Domain | DeleteDrivePermissionParams,
		fileId?: string,
		permissionId?: string,
	): Promise<void>;
	createPermission?(params: CreateDrivePermissionParams): Promise<DrivePermission>;
	listRevisions(params: ListDriveRevisionsParams): Promise<DriveRevisionList>;
	getRevision(params: GetDriveRevisionParams): Promise<DriveRevision>;
	downloadRevision(params: DownloadDriveRevisionParams): Promise<Uint8Array>;
	updateRevision(params: UpdateDriveRevisionParams): Promise<DriveRevision>;
	deleteRevision(params: DeleteDriveRevisionParams): Promise<void>;
	listComments?(params: ListDriveCommentsParams): Promise<DriveCommentList>;
	getComment?(params: GetDriveCommentParams): Promise<DriveComment>;
	listReplies?(params: ListDriveRepliesParams): Promise<DriveReplyList>;
	createComment?(params: CreateDriveCommentParams): Promise<DriveComment>;
	createReply?(params: CreateDriveReplyParams): Promise<DriveCommentReply>;
	updateComment?(params: UpdateDriveCommentParams): Promise<DriveComment>;
	deleteComment?(params: DeleteDriveCommentParams): Promise<void>;
}

export const ABOUT_FIELDS = "user(displayName,emailAddress), storageQuota(limit,usage,usageInDrive,usageInDriveTrash)";
export const FILE_FIELDS = "id, name, mimeType, size, version, modifiedTime, createdTime, owners(displayName,emailAddress), parents, webViewLink, trashed, shared, iconLink, md5Checksum, sha256Checksum";
export const LIST_FIELDS = `nextPageToken, incompleteSearch, files(${FILE_FIELDS})`;
export const PERMISSION_FIELDS = "nextPageToken, permissions(id, type, role, emailAddress, domain, displayName)";
export const PERMISSION_CREATE_FIELDS = "id, role, type, emailAddress, domain";
export const REVISION_FIELDS = "id, modifiedTime, lastModifyingUser(displayName,emailAddress), keepForever, size, md5Checksum, mimeType, originalFilename, exportLinks";
export const REVISION_LIST_FIELDS = `nextPageToken, revisions(${REVISION_FIELDS})`;
export const REPLY_FIELDS = "id,content,author(displayName,emailAddress,me),createdTime,modifiedTime,action,deleted";
export const REPLY_LIST_FIELDS = `nextPageToken,replies(${REPLY_FIELDS})`;
export const COMMENT_FIELDS = `id,content,author(displayName,emailAddress,me),createdTime,modifiedTime,resolved,deleted,quotedFileContent,replies(${REPLY_FIELDS})`;
export const COMMENT_LIST_FIELDS = `nextPageToken,comments(${COMMENT_FIELDS})`;
export const COMMENT_CREATE_FIELDS = "id,content,author(displayName,emailAddress),createdTime,resolved,quotedFileContent";
export const REPLY_CREATE_FIELDS = "id,content,author(displayName,emailAddress),createdTime,action";
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const DRIVE_MULTIPART_BOUNDARY = "ahkms_drive_multipart_boundary";
export const GOOGLE_EXPORT: Record<string, { mimeType: string; extension: string }> = {
	"application/vnd.google-apps.document": { mimeType: "text/markdown", extension: "md" },
	"application/vnd.google-apps.spreadsheet": { mimeType: "text/markdown", extension: "md" },
	"application/vnd.google-apps.presentation": { mimeType: "application/pdf", extension: "pdf" },
	"application/vnd.google-apps.drawing": { mimeType: "image/png", extension: "png" },
};

export const isGoogleDoc = (mimeType: string | null | undefined): boolean => (mimeType ?? "").startsWith("application/vnd.google-apps.");
export const isFolder = (mimeType: string | null | undefined): boolean => mimeType === "application/vnd.google-apps.folder";

export function formatFile(f: DriveFile): string {
	const bits: string[] = [f.mimeType ?? "?"];
	if (f.size) bits.push(`${f.size} bytes`);
	if (f.modifiedTime) bits.push(`modified ${f.modifiedTime}`);
	if (f.trashed) bits.push("TRASHED");
	if (f.owners?.[0]?.emailAddress) bits.push(`owner ${f.owners[0].emailAddress}`);
	return `• [${f.id}] ${f.name ?? "(unnamed)"} (${bits.join(", ")})`;
}
export const formatList = (files: DriveFile[]): string =>
	files.length === 0 ? "No files." : `${files.length} file(s):\n${files.map(formatFile).join("\n")}`;
