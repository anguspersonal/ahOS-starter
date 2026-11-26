import {
	createSlackAdapter,
	dayAfter,
	dayBefore,
	parseChannelMessage,
	parseMatch,
	toSlackTimestamp,
	type ChannelMessageWire,
	type SearchMatchWire,
	type SlackAdapter,
	type SlackAdapterOptions,
	type SlackChannelMessage,
	type SlackMessage,
	type SlackPort,
	type SlackReadChannelInput,
	type SlackReadChannelOutput,
	type SlackReadPort,
	type SlackReadThreadInput,
	type SlackReadThreadOutput,
	type SlackSearchInput,
	type SlackSearchOptions,
	type SlackSearchOutput,
	type SlackTokenFn,
	type SlackViewer,
} from "@ahkms/core/adapters";
import { getCredential } from "../credentials.js";

export {
	createSlackAdapter,
	dayAfter,
	dayBefore,
	parseChannelMessage,
	parseMatch,
	toSlackTimestamp,
	type ChannelMessageWire,
	type SearchMatchWire,
	type SlackAdapter,
	type SlackAdapterOptions,
	type SlackChannelMessage,
	type SlackMessage,
	type SlackPort,
	type SlackReadChannelInput,
	type SlackReadChannelOutput,
	type SlackReadPort,
	type SlackReadThreadInput,
	type SlackReadThreadOutput,
	type SlackSearchInput,
	type SlackSearchOptions,
	type SlackSearchOutput,
	type SlackTokenFn,
	type SlackViewer,
};

const defaultSlackAdapter = createSlackAdapter(() => getCredential("slack"));

export async function resolveSlackChannelId(channel: string): Promise<string> {
	return defaultSlackAdapter.resolveSlackChannelId(channel);
}

export async function readSlackChannel(
	input: SlackReadChannelInput,
): Promise<SlackReadChannelOutput> {
	return defaultSlackAdapter.readChannel(input);
}

export async function readSlackThread(
	input: SlackReadThreadInput,
): Promise<SlackReadThreadOutput> {
	return defaultSlackAdapter.readThread(input);
}

export async function searchSlackMessages(
	input: SlackSearchInput,
): Promise<SlackSearchOutput> {
	return defaultSlackAdapter.searchMessages(input);
}

export async function searchMyMessages(
	opts: SlackSearchOptions,
): Promise<SlackMessage[]> {
	return defaultSlackAdapter.searchMyMessages(opts);
}

export async function getSlackViewer(): Promise<SlackViewer> {
	return defaultSlackAdapter.viewer();
}

export const slackReadPort: SlackReadPort & SlackPort = defaultSlackAdapter;
