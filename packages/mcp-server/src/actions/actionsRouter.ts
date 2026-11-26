import { Router, json, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import {
	executeAction,
	isPendingApproval,
	ApprovalDeniedError,
	type ActionCaller,
	type ActionRegistry,
} from "@ahkms/core";
import { serverRegistry } from "./serverRegistry.js";
import { supabase as defaultSupabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";

export interface ActionRateLimiterInterface {
	isRateLimited(key: string, now?: number): { limited: boolean; retryAfterSec?: number };
}

/**
 * ADR-096 Rate Limiter for Action execution endpoint.
 * Prevents runaway request spikes and denial of service.
 */
export class ActionRateLimiter implements ActionRateLimiterInterface {
	private readonly windowMs: number;
	private readonly maxRequests: number;
	private readonly requests = new Map<string, { count: number; windowStart: number }>();

	constructor(maxRequests = 120, windowMs = 60_000) {
		this.maxRequests = maxRequests;
		this.windowMs = windowMs;
	}

	isRateLimited(key: string, now = Date.now()): { limited: boolean; retryAfterSec?: number } {
		// Prune expired entries to prevent unbounded memory growth
		for (const [k, entry] of this.requests.entries()) {
			if (now - entry.windowStart >= this.windowMs) {
				this.requests.delete(k);
			}
		}

		const entry = this.requests.get(key);
		if (!entry) {
			this.requests.set(key, { count: 1, windowStart: now });
			return { limited: false };
		}
		if (entry.count >= this.maxRequests) {
			const retryAfterSec = Math.ceil((entry.windowStart + this.windowMs - now) / 1000);
			return { limited: true, retryAfterSec: Math.max(1, retryAfterSec) };
		}
		entry.count++;
		return { limited: false };
	}
}

export interface ActionsRouterOptions {
	registry?: ActionRegistry;
	supabaseClient?: any;
	rateLimiter?: ActionRateLimiterInterface;
	ipRateLimiter?: ActionRateLimiterInterface;
	allowedOrigins?: (string | RegExp)[];
	ownerUserId?: string;
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins?: (string | RegExp)[]): boolean {
	if (!origin) return true; // non-browser or same-origin
	if (allowedOrigins && allowedOrigins.length > 0) {
		return allowedOrigins.some((rule) => (typeof rule === "string" ? rule === origin : rule.test(origin)));
	}

	// Dev localhost origins (only allowed when NODE_ENV !== "production")
	if (process.env.NODE_ENV !== "production") {
		if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
			return true;
		}
	}

	// Exact string match against WEB_ORIGIN list (comma-separated) and nothing else
	const webOrigin = process.env.WEB_ORIGIN;
	if (webOrigin) {
		const configuredOrigins = webOrigin
			.split(",")
			.map((o) => o.trim())
			.filter(Boolean);
		if (configuredOrigins.includes(origin)) {
			return true;
		}
	}

	return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function actionsRouter(options: ActionsRouterOptions = {}): Router {
	const router = Router();
	const registry = options.registry || serverRegistry();
	const supabaseClient = options.supabaseClient || defaultSupabase;
	const userRateLimiter = options.rateLimiter || new ActionRateLimiter(120, 60_000);
	const ipRateLimiter = options.ipRateLimiter || new ActionRateLimiter(120, 60_000);
	const ownerUserId = options.ownerUserId ?? getCurrentUserId();

	const actionsCors = cors({
		origin: (origin, callback) => {
			if (isOriginAllowed(origin, options.allowedOrigins)) {
				callback(null, true);
			} else {
				callback(new Error(`Origin ${origin} not allowed by CORS`));
			}
		},
		methods: ["POST", "OPTIONS"],
		allowedHeaders: [
			"Content-Type",
			"Authorization",
			"X-Request-Id",
			"X-Action-Caller",
			"X-Action-Trace-Id",
			"X-Parent-Request-Id",
		],
		exposedHeaders: ["Retry-After"],
	});

	router.use(actionsCors);
	router.use(json({ limit: "1mb" }));

	router.post("/:id", async (req: Request, res: Response, _next: NextFunction) => {
		try {
			// 1. Pre-auth per-IP rate limiting
			const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
			const ipCheck = ipRateLimiter.isRateLimited(clientIp);
			if (ipCheck.limited) {
				res.status(429)
					.set("Retry-After", String(ipCheck.retryAfterSec || 60))
					.json({ message: "Rate limit exceeded. Too many requests from this IP." });
				return;
			}

			// 2. Authenticate via Supabase Bearer token
			const authHeader = req.header("authorization") || "";
			const match = authHeader.match(/^Bearer\s+(.+)$/i);
			if (!match) {
				res.status(401).json({ message: "Missing or invalid authorization header" });
				return;
			}

			const token = match[1].trim();
			const { data, error: authError } = await supabaseClient.auth.getUser(token);
			if (authError || !data?.user) {
				res.status(401).json({ message: "Invalid or expired access token" });
				return;
			}
			const user = data.user;

			// 3. Owner gate (ADR-100 / ADR-045)
			if (!ownerUserId) {
				res.status(503).json({ message: "Owner identity not configured" });
				return;
			}
			if (user.id !== ownerUserId) {
				res.status(403).json({ message: "Forbidden: caller is not the owner" });
				return;
			}

			// 4. Post-auth per-user rate limiting
			const userCheck = userRateLimiter.isRateLimited(user.id);
			if (userCheck.limited) {
				res.status(429)
					.set("Retry-After", String(userCheck.retryAfterSec || 60))
					.json({ message: "Rate limit exceeded. Too many action requests." });
				return;
			}

			// 5. Derive caller from X-Action-Caller (accepts absent, "ui", or "ui_agent" only)
			const callerHeader = req.header("x-action-caller");
			let caller: Extract<ActionCaller, "ui" | "ui_agent">;
			if (callerHeader === undefined || callerHeader === "ui") {
				caller = "ui";
			} else if (callerHeader === "ui_agent") {
				caller = "ui_agent";
			} else {
				res.status(400).json({ message: "unknown X-Action-Caller" });
				return;
			}

			// 6. Resolve action from CAR
			// Express 5 types a route param as string | string[]; this route has one :id segment.
			const rawId = req.params.id;
			const actionId = Array.isArray(rawId) ? rawId[0] : rawId;
			let action = registry.get(actionId);
			if (!action) {
				const today = new Date().toISOString().slice(0, 10);
				for (const candidate of registry.list()) {
					if (candidate.formerIds) {
						const former = candidate.formerIds.find((f) => f.id === actionId);
						if (former) {
							if (former.until >= today) {
								action = candidate;
							}
							break;
						}
					}
				}
			}

			if (!action || !action.expose?.http) {
				res.status(404).json({ message: `Action "${actionId}" not found in ActionRegistry` });
				return;
			}

			if (caller === "ui_agent" && action.expose?.ui_agent === false) {
				res.status(403).json({ message: "not_exposed_to_ui_agent" });
				return;
			}

			// 7. Execute action with validated caller
			const requestId = (req.header("x-request-id") as string) || randomUUID();
			const rawTraceId = req.header("x-action-trace-id");
			const traceId =
				typeof rawTraceId === "string" && UUID_RE.test(rawTraceId)
					? rawTraceId
					: undefined;
			const rawParentRequestId = req.header("x-parent-request-id");
			const parentRequestId =
				typeof rawParentRequestId === "string" && UUID_RE.test(rawParentRequestId)
					? rawParentRequestId
					: undefined;

			const result = await executeAction(action, req.body, {
				context: {
					caller,
					userId: user.id,
					requestId,
					...(traceId ? { traceId } : {}),
					...(parentRequestId ? { parentRequestId } : {}),
				},
			});

			res.status(200).json(result);
		} catch (err: any) {
			if (isPendingApproval(err)) {
				res.status(202).json({
					status: "pending_approval",
					decision_id: err.decisionId,
					action_id: err.actionId,
				});
				return;
			}

			if (err instanceof ApprovalDeniedError || err?.name === "ApprovalDeniedError") {
				res.status(403).json({ message: err.message });
				return;
			}

			const isZodError = err.name === "ZodError" || Boolean(err.issues);
			const isDomainValidation =
				err.status === 400 ||
				err.statusCode === 400 ||
				/validation|required|invalid|must differ/i.test(err.message || "");

			if (isZodError || isDomainValidation) {
				res.status(400).json({
					message: err.message || "Invalid action input",
					errors: err.issues ?? undefined,
				});
				return;
			}

			const statusCode =
				typeof err.status === "number" && err.status >= 400 && err.status < 600
					? err.status
					: 500;
			res.status(statusCode).json({ message: err.message || "Action execution failed" });
		}
	});

	return router;
}
