import { describe, expect, it } from "vitest";
import { DEFAULT_OWNER_ADDRESSES } from "../google/gmailPriorityTriage.js";
import {
	extractThreadReference as ref,
	GMAIL_RECONCILE_LABEL_NAMES,
	GMAIL_RECONCILE_PERSONAL_LABEL_IDS,
	isSentByAngus,
	isTaskWaitingOn,
} from "./reconcileRules.js";

const ID = "18f123456789abcd";
const link = (o: Partial<{ artifact_id: string; provider: string; kind: string }> = {}) => ({
	artifact_id: "a", provider: "gmail", kind: "thread", external_id: ID, ...o,
});
const mail = (path: string) => `https://mail.google.com/mail/${path}`;

describe("reconcile rules", () => {
	it("case 1: isSentByAngus matches exactly DEFAULT_OWNER_ADDRESSES, case-insensitively", () => {
		expect(isSentByAngus("Angus Hally <owner@example.com>")).toBe(true);
		expect(isSentByAngus("owner@work.example.com")).toBe(true);
		expect(isSentByAngus("owner@example.com")).toBe(true);
		expect(isSentByAngus("Graeme Rodd <contact6@example.com>")).toBe(false);
		expect(isSentByAngus("Robbie <contact7@example.com>")).toBe(false);
		expect(isSentByAngus(undefined)).toBe(false);
		expect([...DEFAULT_OWNER_ADDRESSES]).toEqual([
			"owner@example.com", "owner@work.example.com", "owner@work.example.com", "owner@work.example.com",
		]);
		for (const a of DEFAULT_OWNER_ADDRESSES) expect(isSentByAngus(`X <${a}>`)).toBe(true);
	});

	it("case 2: isTaskWaitingOn", () => {
		for (const s of ["Waiting On", "waiting on reply", "6: awaiting reply", "Awaiting client response"]) {
			expect(isTaskWaitingOn(s)).toBe(true);
		}
		for (const s of ["In progress", "Done", undefined]) expect(isTaskWaitingOn(s)).toBe(false);
	});

	it("case 3: external links match on provider, kind and artifact id, and win over every other source", () => {
		expect(ref({ id: "a" }, [link()])).toEqual({ threadId: ID, account: "personal" });
		for (const kind of ["gmail_thread", "email", "THREAD"]) expect(ref({ id: "a" }, [link({ kind })])?.threadId).toBe(ID);
		expect(ref({ id: "a" }, [link({ provider: "google_work" })])).toEqual({ threadId: ID, account: "work" });
		expect(ref({ id: "a" }, [link({ artifact_id: "b" })])).toBeNull();
		expect(ref({ id: "a" }, [link({ provider: "notion" })])).toBeNull();
		expect(ref({ id: "a" }, [link({ kind: "page" })])).toBeNull();
		const all = {
			id: "a",
			processing_metadata: { gmail: { thread_id: "meta" } },
			source_url: mail("u/0/#inbox/bbbbbbbbbbbbbbbb"),
			text: "Thread: cccccccccccccccc",
		};
		expect(ref(all, [link()])?.threadId).toBe(ID);
		expect(ref(all)?.threadId).toBe("meta");
	});

	it("case 3: processing_metadata in order gmail/email, thread_id, gmail_thread_id", () => {
		const meta = (m: Record<string, unknown>) => ref({ id: "a", processing_metadata: m });
		expect(meta({ gmail: { thread_id: "g", account: "work" } })).toEqual({ threadId: "g", account: "work" });
		expect(meta({ email: { thread_id: "e", account: "work" } })).toEqual({ threadId: "e", account: "work" });
		expect(meta({ thread_id: "top", gmail_thread_id: "gt" })).toEqual({ threadId: "top", account: "personal" });
		expect(meta({ gmail_thread_id: "gt" })).toEqual({ threadId: "gt", account: "personal" });
		expect(ref({ id: "a", processing_metadata: { thread_id: "top" }, source_url: mail("u/0/#inbox/bbbbbbbbbbbbbbbb") })?.threadId).toBe("top");
	});

	it("case 3: mail.google.com source_url, then Thread: in text, then null", () => {
		expect(ref({ id: "a", source_url: mail("u/0/#inbox/18fbbbbbbbbbbbbb") })).toEqual({ threadId: "18fbbbbbbbbbbbbb", account: "personal" });
		expect(ref({ id: "a", source_url: mail("u/1/#all/18fccccccccccccc") })).toEqual({ threadId: "18fccccccccccccc", account: "work" });
		expect(ref({ id: "a", source_url: mail("u/0/?ui=2&th=18feeeeeeeeeeeee") })?.threadId).toBe("18feeeeeeeeeeeee");
		expect(ref({ id: "a", source_url: mail("u/0/#inbox/18fabc") })).toBeNull();
		expect(ref({ id: "a", source_url: mail("u/0/#inbox/18fbbbbbbbbbbbbb"), text: "Thread: cccccccccccccccc" })?.threadId).toBe("18fbbbbbbbbbbbbb");
		expect(ref({ id: "a", text: "Captured email note\nThread: 18fddddddddddddd\nDetails" })).toEqual({ threadId: "18fddddddddddddd", account: "personal" });
		expect(ref({ id: "a", source_url: "https://drive.google.com/file/d/xyz", text: "No thread here" })).toBeNull();
		expect(ref({ id: "a" })).toBeNull();
	});

	it("case 4: account tags set the account before any source is read; default personal", () => {
		const text = "Thread: 18fddddddddddddd";
		expect(ref({ id: "a", text, tags: ["account:work"] })?.account).toBe("work");
		expect(ref({ id: "a", text, tags: ["account:personal"] })?.account).toBe("personal");
		expect(ref({ id: "a", text })?.account).toBe("personal");
		expect(ref({ id: "a", tags: ["account:personal"], source_url: mail("u/1/#inbox/18fbbbbbbbbbbbbb") })?.account).toBe("work");
	});

	it("case 5: label names and personal label ids under the same four keys", () => {
		expect(GMAIL_RECONCILE_LABEL_NAMES).toEqual({
			AHOS: "AhOS", AHOS_PROCESSED: "AhOSProcessed", PENDING_ACTION: "Pending Action", AWAITING_REPLY: "6: awaiting reply",
		});
		expect(GMAIL_RECONCILE_PERSONAL_LABEL_IDS).toEqual({
			AHOS: "Label_329", AHOS_PROCESSED: "Label_330", PENDING_ACTION: "Label_331", AWAITING_REPLY: "Label_314",
		});
	});
});
