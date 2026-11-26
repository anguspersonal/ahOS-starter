import {
	type ActionExposure,
	type ActionExposureInput,
	type ActionSurface,
	type ExposureOptOutReason,
	EXPOSURE_OPT_OUT_REASONS,
} from "./types.js";

export const DEFAULT_ACTION_EXPOSURE: ActionExposure = Object.freeze({
	mcp: true,
	http: true,
	ui_agent: true,
	worker: true,
	cli: false,
	a2a: false,
});

const DEFAULT_ON_SURFACES: readonly ActionSurface[] = ["mcp", "http", "ui_agent", "worker"];

export function normaliseExposure(id: string, input?: ActionExposureInput): ActionExposure {
	if (input?.cli === true) {
		throw new Error(`Action "${id}" cannot expose cli until #1455 reopens`);
	}
	if (input?.a2a === true) {
		throw new Error(`Action "${id}" cannot expose a2a until #1456 reopens`);
	}

	const turnedOffSurfaces = DEFAULT_ON_SURFACES.filter((surface) => input?.[surface] === false);

	if (turnedOffSurfaces.length > 0) {
		if (!input?.reason) {
			throw new Error(
				`Action "${id}" turns off ${turnedOffSurfaces[0]} without expose.reason (one of: ${EXPOSURE_OPT_OUT_REASONS.join(", ")})`,
			);
		}
		if (!EXPOSURE_OPT_OUT_REASONS.includes(input.reason as ExposureOptOutReason)) {
			throw new Error(
				`Action "${id}" has invalid expose.reason "${input.reason}" (one of: ${EXPOSURE_OPT_OUT_REASONS.join(", ")})`,
			);
		}
		if (!input.note || typeof input.note !== "string" || input.note.trim().length === 0) {
			throw new Error(
				`Action "${id}" specifies expose.reason "${input.reason}" without a non-empty expose.note`,
			);
		}
	} else if (input?.reason !== undefined) {
		throw new Error(
			`Action "${id}" specifies expose.reason but every surface is still on (reason given but nothing is turned off)`,
		);
	}

	const normalised: ActionExposure = {
		mcp: input?.mcp ?? true,
		http: input?.http ?? true,
		ui_agent: input?.ui_agent ?? true,
		worker: input?.worker ?? true,
		cli: false,
		a2a: false,
	};
	if (input?.reason) normalised.reason = input.reason;
	if (input?.note) normalised.note = input.note;
	return normalised;
}

export function exposureOf(action?: { expose?: ActionExposure } | null): ActionExposure {
	return action?.expose ? action.expose : { ...DEFAULT_ACTION_EXPOSURE };
}
