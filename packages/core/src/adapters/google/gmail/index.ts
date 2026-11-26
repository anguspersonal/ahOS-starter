import { DOMAIN_LEGACY_SCOPE, type Domain } from "../../../domain/domains.js";
import {
	DRAFT_FIELDS, DRAFT_METADATA_FIELDS, envelopeRecipients, LIST_LABELS_FIELDS, LIST_MESSAGES_FIELDS, MESSAGE_FIELDS, PROFILE_FIELDS, SEARCH_METADATA_HEADERS, THREAD_FIELDS,
	type GmailCreateDraftParams, type GmailEnsureLabelParams, type GmailGetDraftParams,
	type GmailGetMessageParams, type GmailGetProfileParams, type GmailGetReplyContextParams,
	type GmailGetThreadParams, type GmailListLabelsParams, type GmailMessage, type GmailModifyLabelsParams, type GmailPort,
	type GmailSearchMessagesParams, type GmailSearchPageParams, type GmailSendDraftParams, type GmailUpdateDraftParams,
} from "../../../ports/gmail.js";
import { createGoogleTokenSource, type GoogleTokenSourceConfig } from "../tokenSource.js";
import {
	type GmailAuth, createDraft, ensureLabel, getDraft, getMessage,
	getProfile, getReplyContext, getThread, listLabels, modifyLabels, searchMessages, searchMessagesPage, sendDraft, updateDraft,
} from "./client.js";

export type GoogleGmailAdapterConfig = GoogleTokenSourceConfig;

export function createGoogleGmailAdapter(config: GoogleGmailAdapterConfig): GmailPort {
	const tokenSource = createGoogleTokenSource(config);
	const authFor = (domain: Domain, getFields?: string): GmailAuth => {
		const fetchFn = config.fetchFn ?? fetch;
		return {
			label: DOMAIN_LEGACY_SCOPE[domain],
			accessToken: () => tokenSource.accessToken(domain),
			fetchFn: getFields
				? (input, init) => {
						const url = String(input);
						const sep = url.includes("?") ? "&" : "?";
						return (init?.method ?? "GET") === "GET" && !url.includes("fields=")
							? fetchFn(`${url}${sep}fields=${encodeURI(getFields)}`, init)
							: fetchFn(input, init);
					}
				: config.fetchFn,
		};
	};
	return {
		searchMessages: ({ domain, query, maxResults = 10, fields = LIST_MESSAGES_FIELDS, messageFields = MESSAGE_FIELDS }: GmailSearchMessagesParams) =>
			searchMessages(authFor(domain), query, maxResults, { fields, messageFields }),
		searchMessagesPage: ({
			domain,
			query,
			maxResults = 10,
			cursor,
			format = "metadata",
			metadataHeaders = SEARCH_METADATA_HEADERS,
			fields = LIST_MESSAGES_FIELDS,
			messageFields = MESSAGE_FIELDS,
		}: GmailSearchPageParams) =>
			searchMessagesPage(authFor(domain), query, maxResults, {
				cursor,
				format,
				metadataHeaders,
				fields,
				messageFields,
			}),
		getMessage: ({ domain, messageId, fields = MESSAGE_FIELDS, format, metadataHeaders }: GmailGetMessageParams) =>
			getMessage(authFor(domain), messageId, { fields, format, metadataHeaders }),
		getThread: ({ domain, threadId, fields = THREAD_FIELDS }: GmailGetThreadParams) =>
			getThread(authFor(domain), threadId, { fields }),
		getProfile: ({ domain, fields = PROFILE_FIELDS }: GmailGetProfileParams) =>
			getProfile(authFor(domain), { fields }),
		listLabels: ({ domain, fields = LIST_LABELS_FIELDS }: GmailListLabelsParams) =>
			listLabels(authFor(domain, fields)),
		ensureLabel: ({ domain, name, fields = LIST_LABELS_FIELDS }: GmailEnsureLabelParams) =>
			ensureLabel(authFor(domain, fields), name),
		getReplyContext: ({ domain, messageId, fields = MESSAGE_FIELDS }: GmailGetReplyContextParams) =>
			getReplyContext(authFor(domain, fields), messageId),
		createDraft: ({ domain, raw, threadId }: GmailCreateDraftParams) =>
			createDraft(authFor(domain), raw, threadId),
		updateDraft: ({ domain, draftId, raw, threadId }: GmailUpdateDraftParams) =>
			updateDraft(authFor(domain), draftId, raw, threadId),
		getDraft: async ({
			domain,
			draftId,
			format = "full",
			fields = format === "metadata" ? DRAFT_METADATA_FIELDS : DRAFT_FIELDS,
		}: GmailGetDraftParams) => {
			let rawMessage: GmailMessage | undefined;
			const baseAuth = authFor(domain, fields);
			const baseFetch = baseAuth.fetchFn ?? fetch;
			const parsed = await getDraft(
				{
					...baseAuth,
					fetchFn: async (input, init) => {
						const nextInput =
							format === "metadata"
								? String(input).replace("format=full", "format=metadata")
								: input;
						const res = await baseFetch(nextInput, init);
						if (res.ok) {
							const wire = (await (
								typeof res.clone === "function" ? res.clone() : res
							).json()) as { message?: GmailMessage };
							rawMessage = wire.message;
						}
						return res;
					},
				},
				draftId,
			);
			return rawMessage ? { ...parsed, ...envelopeRecipients(rawMessage) } : parsed;
		},
		sendDraft: ({ domain, draftId }: GmailSendDraftParams) =>
			sendDraft(authFor(domain), draftId),
		modifyLabels: ({ domain, target, addLabelIds, removeLabelIds }: GmailModifyLabelsParams) =>
			modifyLabels(authFor(domain), target, { addLabelIds, removeLabelIds }),
	};
}
