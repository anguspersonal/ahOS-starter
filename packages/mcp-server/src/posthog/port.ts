import { createPostHogAdapter } from "@ahkms/core/adapters";
import type { PostHogPort } from "@ahkms/core";
import { getCredential } from "../credentials.js";
import { configRepository } from "../integrations.js";

export const posthogPort: PostHogPort = createPostHogAdapter({
	getCredential: (ref, opts) => getCredential(ref, opts),
	config: configRepository,
});

export const getIdentity: PostHogPort["getIdentity"] = (target) =>
	posthogPort.getIdentity(target);
export const listProjects: PostHogPort["listProjects"] = (target) =>
	posthogPort.listProjects(target);
export const getProject: PostHogPort["getProject"] = (target, projectId) =>
	posthogPort.getProject(target, projectId);
export const runQuery: PostHogPort["runQuery"] = (target, projectId, query) =>
	posthogPort.runQuery(target, projectId, query);
export const writeCall: PostHogPort["writeCall"] = (target, path, method, body) =>
	posthogPort.writeCall(target, path, method, body);
export const getRaw: PostHogPort["getRaw"] = (target, path) =>
	posthogPort.getRaw(target, path);
