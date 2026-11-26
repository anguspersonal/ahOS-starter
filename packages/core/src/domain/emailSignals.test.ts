import { describe, expect, it } from "vitest";
import { extractEmailSignals, normaliseAddress, resolveGmailCategory } from "./emailSignals.js";

const owner = { ownerAddresses: ["owner@example.com", "owner@work.example.com"] };

describe("extractEmailSignals", () => {
	it("reads list headers as bulk, whatever Gmail's tab", () => {
		const s = extractEmailSignals(
			{
				from: "Currys <specialoffers@example.com>",
				to: "owner@example.com",
				subject: "The Black Friday brand edit.",
				labelIds: ["INBOX", "CATEGORY_PERSONAL"],
				listUnsubscribe: "<mailto:x@example.com>",
			},
			owner,
		);
		expect(s.senderKind).toBe("bulk");
		expect(s.gmailCategory).toBe("primary");
		expect(s.cues.promo).toBe(true);
	});

	it("flags a Gmail-vs-graph contradiction for a known contact filed under Promotions", () => {
		const s = extractEmailSignals(
			{ from: "Paul Hally <contact1@example.com>", to: "owner@example.com", subject: "Sunday dinner", labelIds: ["CATEGORY_PROMOTIONS"] },
			{ ...owner, knownContact: true, relationship: "father" },
		);
		expect(s.senderKind).toBe("known_contact");
		expect(s.gmailCategoryContradiction).toBe(true);
	});

	it("treats the owner's own mail as self and recognises the Work address as direct", () => {
		expect(extractEmailSignals({ from: "owner@example.com", subject: "Morning Briefing" }, owner).senderKind).toBe("self");
		const s = extractEmailSignals(
			{ from: "Jim Rice <contact8@example.com>", to: "Angus Hally <owner@work.example.com>", subject: "Call This Week", snippet: "Are you free Thursday?" },
			owner,
		);
		expect(s.isDirectRecipient).toBe(true);
		expect(s.senderKind).toBe("human");
		expect(s.cues.ask).toBe(true);
	});

	it("reads a role address as automated unless it asks something", () => {
		expect(extractEmailSignals({ from: "Tide <hello@bank.example.com>", subject: "Peace of mind starts here" }, owner).senderKind).toBe(
			"automated",
		);
		expect(
			extractEmailSignals({ from: "Ethan <hello@vendor.example.com>", subject: "Work vs Paired", snippet: "Would you be open to a chat?" }, owner)
				.senderKind,
		).toBe("human");
	});

	it("marks money, security and legal mail as sensitive", () => {
		const s = extractEmailSignals(
			{ from: "Who Gives A Crap <wedo@example.com>", subject: "Important: your details were accessed in a security incident" },
			owner,
		);
		expect(s.isSensitive).toBe(true);
		expect(s.cues.security).toBe(true);
	});

	it("parses addresses and categories", () => {
		expect(normaliseAddress('"Hally, Angus" <owner@example.com>')).toBe("owner@example.com");
		expect(resolveGmailCategory(["UNREAD", "CATEGORY_SOCIAL"])).toBe("social");
		expect(resolveGmailCategory([])).toBe("unknown");
	});
});
