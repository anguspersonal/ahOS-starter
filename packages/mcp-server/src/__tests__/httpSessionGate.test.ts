import { describe, expect, it } from "vitest";
import {
	gateMcpGet,
	gateMcpPost,
	gateMcpSessionRequest,
} from "../httpSessionGate.js";

// The status-code split is the whole point (MCP spec, Session Management): 404 is
// the one rejection clients recover from by re-initializing; 400 is terminal. The
// pre-#640 gate returned 400 for expired sessions, which stranded every connected
// client across each redeploy of the (in-memory-session) Railway service.
describe("gateMcpPost", () => {
	it("hands a known session straight to its transport", () => {
		expect(
			gateMcpPost({ sessionId: "s1", sessionKnown: true, isInitialize: false }),
		).toEqual({ kind: "handle" });
	});

	it("404s an unknown session id so the client starts a new session", () => {
		const decision = gateMcpPost({
			sessionId: "stale-after-redeploy",
			sessionKnown: false,
			isInitialize: false,
		});
		expect(decision).toMatchObject({ kind: "reject", status: 404, code: -32001 });
	});

	it("404s even when the stale-session request is itself an initialize", () => {
		// A client must not initialize *onto* a dead session id; it re-initializes fresh.
		const decision = gateMcpPost({
			sessionId: "stale",
			sessionKnown: false,
			isInitialize: true,
		});
		expect(decision).toMatchObject({ kind: "reject", status: 404 });
	});

	it("400s a sessionless non-initialize request", () => {
		const decision = gateMcpPost({
			sessionId: undefined,
			sessionKnown: false,
			isInitialize: false,
		});
		expect(decision).toMatchObject({ kind: "reject", status: 400, code: -32000 });
	});

	it("creates a session for a sessionless initialize request", () => {
		expect(
			gateMcpPost({ sessionId: undefined, sessionKnown: false, isInitialize: true }),
		).toEqual({ kind: "create" });
	});

	// A client re-initializing over a session it still holds open (e.g. a spec-compliant
	// client re-sending `initialize` idempotently) is not a stale-session case — it's
	// handed straight to the transport like any other known-session request.
	it("hands a known session straight to its transport even when the request is an initialize", () => {
		expect(
			gateMcpPost({ sessionId: "s1", sessionKnown: true, isInitialize: true }),
		).toEqual({ kind: "handle" });
	});
});

// GET (SSE reconnect) / DELETE (teardown) share the POST gate's 404-vs-400 contract
// (see gateMcpPost above) but never create a session — there's no "initialize"
// escape hatch on these verbs.
describe("gateMcpSessionRequest", () => {
	it("hands a known session straight to its transport", () => {
		expect(
			gateMcpSessionRequest({ sessionId: "s1", sessionKnown: true }),
		).toEqual({ kind: "handle" });
	});

	it("404s an unknown session id so the client starts a new session", () => {
		const decision = gateMcpSessionRequest({
			sessionId: "stale-after-redeploy",
			sessionKnown: false,
		});
		expect(decision).toEqual({
			kind: "reject",
			status: 404,
			message: "Session not found or expired",
		});
	});

	it("400s a missing session id", () => {
		const decision = gateMcpSessionRequest({
			sessionId: undefined,
			sessionKnown: false,
		});
		expect(decision).toEqual({
			kind: "reject",
			status: 400,
			message: "Missing session id",
		});
	});
});

// GET /mcp is not offered because ahOS does not send unsolicited server-initiated
// notifications; per the MCP Streamable HTTP spec ("Listening for Messages from
// the Server" §3), returning 405 Method Not Allowed stops clients from holding
// open a silent SSE stream that drops on proxy idle timeouts and exhausts retries.
describe("gateMcpGet", () => {
	it("405s with Allow: POST, DELETE so clients disable the standalone GET SSE stream", () => {
		expect(gateMcpGet()).toEqual({
			kind: "reject",
			status: 405,
			allow: "POST, DELETE",
			message: "Method Not Allowed: standalone GET SSE stream is not offered",
		});
	});
});
