import { executeAction } from "../actions/adapters/direct.js";
import { getCurrentUserId } from "../identity.js";
import { captureAction, type CaptureInput, type CaptureResult } from "../tools/capture.js";

/**
 * Dispatch a webhook-originated capture through the registered `capture` action
 * (ADR-100) rather than calling `captureCore` directly, so it gets schema validation,
 * `ActionContext` tagged `caller: "http"`, and uniform `[audit:action]` logging.
 *
 * Identity: `getCurrentUserId()` is the single owner (`KMS_USER_ID`, a required boot var
 * of this same Railway process), passed explicitly so the capture never depends on
 * ambient state.
 */
export function dispatchCapture(route: string): (input: CaptureInput) => Promise<CaptureResult> {
	return async (input) => {
		return await executeAction(captureAction, input, {
			context: {
				caller: "http",
				userId: getCurrentUserId(),
				metadata: { route },
			},
		});
	};
}
