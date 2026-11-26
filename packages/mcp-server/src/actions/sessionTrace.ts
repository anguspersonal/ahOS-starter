export const SESSION_TURN_WINDOW_MS = 30_000;
export const MAX_ACTIVE_SESSIONS = 1_000;

export interface SessionTraceEntry {
	traceId: string;
	rootRequestId: string;
	lastSeenMs: number;
}

export interface SessionTraceIdentity {
	sessionId?: string | null;
	userId?: string | null;
	clientId?: string | null;
}

export interface SessionTraceResolution {
	traceId: string;
	parentRequestId: string | null;
}

export interface SessionTraceTrackerOptions {
	windowMs?: number;
	maxSessions?: number;
}

export function deriveSessionTraceKey(identity: SessionTraceIdentity): string | null {
	const sessionId = typeof identity.sessionId === "string" ? identity.sessionId.trim() : "";
	if (sessionId.length > 0) {
		return sessionId;
	}
	const userId = typeof identity.userId === "string" ? identity.userId.trim() : "";
	const clientId = typeof identity.clientId === "string" ? identity.clientId.trim() : "";
	if (userId.length > 0 && clientId.length > 0) {
		return `${userId}:${clientId}`;
	}
	return null;
}

/**
 * Bounded, TTL-pruned tracker that correlates top-level MCP tool calls within a
 * single conversational turn burst into a shared `traceId` and `parentRequestId`.
 */
export class SessionTraceTracker {
	private readonly windowMs: number;
	private readonly maxSessions: number;
	private readonly entries = new Map<string, SessionTraceEntry>();

	constructor(
		optionsOrWindowMs: SessionTraceTrackerOptions | number = SESSION_TURN_WINDOW_MS,
		maxSessions = MAX_ACTIVE_SESSIONS,
	) {
		if (typeof optionsOrWindowMs === "number") {
			this.windowMs = optionsOrWindowMs;
			this.maxSessions = maxSessions;
		} else {
			this.windowMs = optionsOrWindowMs.windowMs ?? SESSION_TURN_WINDOW_MS;
			this.maxSessions = optionsOrWindowMs.maxSessions ?? MAX_ACTIVE_SESSIONS;
		}
	}

	private pruneExpired(now: number): void {
		for (const [key, entry] of this.entries.entries()) {
			if (now - entry.lastSeenMs >= this.windowMs) {
				this.entries.delete(key);
			}
		}
	}

	resolve(
		requestId: string,
		identity: SessionTraceIdentity,
		now = Date.now(),
	): SessionTraceResolution {
		this.pruneExpired(now);

		const key = deriveSessionTraceKey(identity);
		if (!key) {
			return {
				traceId: requestId,
				parentRequestId: null,
			};
		}

		const existing = this.entries.get(key);
		if (existing && now - existing.lastSeenMs < this.windowMs) {
			const updated: SessionTraceEntry = {
				...existing,
				lastSeenMs: now,
			};
			this.entries.delete(key);
			this.entries.set(key, updated);
			return {
				traceId: updated.traceId,
				parentRequestId: updated.rootRequestId,
			};
		}

		if (this.entries.size >= this.maxSessions) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) {
				this.entries.delete(oldestKey);
			}
		}

		const created: SessionTraceEntry = {
			traceId: requestId,
			rootRequestId: requestId,
			lastSeenMs: now,
		};
		this.entries.set(key, created);

		return {
			traceId: requestId,
			parentRequestId: null,
		};
	}

	get(keyOrIdentity: string | SessionTraceIdentity, now = Date.now()): SessionTraceEntry | undefined {
		this.pruneExpired(now);
		const key =
			typeof keyOrIdentity === "string"
				? keyOrIdentity
				: deriveSessionTraceKey(keyOrIdentity);
		if (!key) return undefined;
		return this.entries.get(key);
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}

export const defaultSessionTraceTracker = new SessionTraceTracker();
