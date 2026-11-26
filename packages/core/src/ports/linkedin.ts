/**
 * Ports for LinkedIn Posts API interactions (ADR-101 §1, §4; #1632).
 * Types only. No external SDKs or environment dependencies.
 */

export type LinkedinVisibility = "PUBLIC" | "CONNECTIONS";

export interface LinkedinCreatePostParams {
	author: string;
	text: string;
	visibility: LinkedinVisibility;
	linkedinVersion: string;
	media?: {
		id: string;
		altText?: string;
	};
}

export interface LinkedinUploadImageParams {
	owner: string;
	imageBytes: Uint8Array;
	contentType?: string;
	linkedinVersion: string;
}

export interface LinkedinPort {
	createPost(params: LinkedinCreatePostParams): Promise<{ postUrn: string }>;
	uploadImage(params: LinkedinUploadImageParams): Promise<{ imageUrn: string }>;
	resolveAuthor(): Promise<string>;
}
