// Session gate for the /mcp POST endpoint (src/http.ts). Extracted as a pure
// function so the status-code contract is unit-testable without booting the
// express app (http.ts runs main() on import).
//
// The distinction between the two rejection statuses is load-bearing, not
// cosmetic (MCP Streamable HTTP spec, "Session Management"):
//
// - A request that PRESENTS an Mcp-Session-Id the server no longer knows MUST
//   get **404**. 404 is the one signal clients are required to recover from by
//   starting a fresh session ("the client MUST start a new session by sending
//   a new InitializeRequest"). Sessions here live in an in-memory Map, so every
//   deploy/restart forgets all of them — 404 is what lets connected clients
//   (claude.ai connectors, SDK clients) re-handshake transparently instead of
//   surfacing an error to the user.
// - A request with NO session id that is not an `initialize` gets **400**:
//   that client never had a session, so "re-initialize" is not a recovery, it
//   is the instruction.
//
// Returning 400 for both cases (the pre-#640 behaviour) stranded every client
// across each redeploy: clients treat 400 as fatal, kept their dead session id,
// and every tool call — reported live against brevo_list_tools, but true of any
// tool — failed with "No valid session. Send an initialize request first."
// wrapped in the caller's transport error.

export type SessionGateDecision =
	| { kind: "handle" }
	| { kind: "create" }
	| {
			kind: "reject";
			status: 404 | 400;
			/** JSON-RPC error code for the response body. */
			code: number;
			message: string;
	  };

export function gateMcpPost(args: {
	sessionId: string | undefined;
	sessionKnown: boolean;
	isInitialize: boolean;
}): SessionGateDecision {
	const { sessionId, sessionKnown, isInitialize } = args;

	if (sessionId && sessionKnown) return { kind: "handle" };

	if (sessionId) {
		// Presented id is unknown: expired, or lost to a restart. -32001 mirrors the
		// SDK server transport's own "session not found" code.
		return {
			kind: "reject",
			status: 404,
			code: -32001,
			message: "Session not found or expired. Start a new session with an initialize request.",
		};
	}

	if (!isInitialize) {
		return {
			kind: "reject",
			status: 400,
			code: -32000,
			message: "No valid session. Send an initialize request first.",
		};
	}

	return { kind: "create" };
}

// Session gate for the /mcp DELETE (session teardown) endpoint (src/http.ts
// `handleDeleteSessionRequest`). Same 404-vs-400 status split as
// {@link gateMcpPost} and for the same reason: a presented-but-unknown session
// id 404s so the client re-initializes instead of treating the rejection as
// fatal, while a request with no session id at all 400s — there's no
// "initialize" escape hatch on DELETE, which only ever operates on an existing
// session.
export type SessionRequestGateDecision =
	| { kind: "handle" }
	| { kind: "reject"; status: 404 | 400; message: string };

export function gateMcpSessionRequest(args: {
	sessionId: string | undefined;
	sessionKnown: boolean;
}): SessionRequestGateDecision {
	const { sessionId, sessionKnown } = args;

	if (sessionId && sessionKnown) return { kind: "handle" };

	if (sessionId) {
		return {
			kind: "reject",
			status: 404,
			message: "Session not found or expired",
		};
	}

	return { kind: "reject", status: 400, message: "Missing session id" };
}

// Gate for the /mcp GET endpoint (standalone server-initiated SSE stream).
// ahOS is a strictly request/response MCP server and never pushes unsolicited
// server-initiated notifications outside a POST request stream. Delegating GET
// to StreamableHTTPServerTransport opens a silent text/event-stream with zero
// bytes (no priming event, no keepalive), which Railway's proxy drops on idle
// timeout (~60s) or rejects with 409 on reconnect — causing clients such as
// modelcontextprotocol/go-sdk and StreamableHTTPClientTransport to exhaust
// their retry budget ("standalone SSE stream: exceeded 5 retries without
// progress") and tear down the session.
//
// Per the MCP Streamable HTTP specification ("Listening for Messages from the
// Server" §3), returning HTTP 405 Method Not Allowed signals that the server
// does not offer a standalone GET SSE stream, so clients cleanly disable the
// background GET loop and use POST /mcp for all requests.
export type GetGateDecision = {
	kind: "reject";
	status: 405;
	allow: "POST, DELETE";
	message: string;
};

export function gateMcpGet(): GetGateDecision {
	return {
		kind: "reject",
		status: 405,
		allow: "POST, DELETE",
		message: "Method Not Allowed: standalone GET SSE stream is not offered",
	};
}
