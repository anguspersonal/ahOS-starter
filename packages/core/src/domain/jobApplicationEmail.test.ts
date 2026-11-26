import { describe, expect, it } from "vitest";
import {
	classifyJobEmail,
	extractEmailAddress,
	parseEmailAddressList,
	resolveThreadConflicts,
	type JobEmailClassificationContext,
	type JobEmailInput,
} from "./jobApplicationEmail.js";

function makeEmail(overrides: Partial<JobEmailInput>): JobEmailInput {
	return {
		message_id: "msg-1",
		thread_id: "thr-1",
		from: "sender@example.com",
		subject: "",
		body: "",
		...overrides,
	};
}

const DEFAULT_CTX: JobEmailClassificationContext = {
	owner_addresses: ["owner@personal.example"],
	linked_contact_emails: ["recruiter@company.example"],
	linked_thread_ids: ["thr-linked-1"],
};

describe("classifyJobEmail (ADR-120 Appendix B golden suite)", () => {
	describe("20 Appendix B positives", () => {
		it("1. Lever applied: Strategy Director - OpenData at Veeva", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Thank you for applying for Strategy Director - OpenData at Veeva",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates).toHaveLength(1);
			expect(res.updates[0]).toMatchObject({
				organisation: "Veeva",
				role_title: "Strategy Director - OpenData",
				stage: "applied",
				channel: "company_site",
				ats: "lever",
				needs_review: false,
			});
		});

		it("2. Lever rejected: Update on Your Application at Veeva", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Update on Your Application at Veeva",
					body: "Thank you for your interest. Unfortunately we have decided not to move forward at this time.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Veeva",
				stage: "rejected",
				ats: "lever",
			});
		});

		it("3. Greenhouse applied: Thank you for applying to Brainlabs", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Thank you for applying to Brainlabs",
					body: "We received your application for the Director, Data Strategy role.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Brainlabs",
				role_title: "Director, Data Strategy",
				stage: "applied",
				ats: "greenhouse",
			});
		});

		it("4. Company domain rejected: Update on your Brainlabs application", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@agency.example.com",
					subject: "Update on your Brainlabs application",
					body: "We will not be moving forward with your application for Director, Data Strategy.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Brainlabs",
				role_title: "Director, Data Strategy",
				stage: "rejected",
				channel: "company_site",
			});
		});

		it("5. Rippling applied: Thank you for applying to Novatus", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Thank you for applying to Novatus",
					body: "Position: Manager | Data & AI\nWe will review your application shortly.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Novatus",
				role_title: "Manager | Data & AI",
				stage: "applied",
				ats: "rippling",
			});
		});

		it("6. Rippling rejected: Thank you for your application to Novatus", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Thank you for your application to Novatus",
					body: "We have decided not to move forward with your application.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Novatus",
				stage: "rejected",
				ats: "rippling",
			});
		});

		it("7. Ashby applied: Thanks for applying to Cohere!", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Thanks for applying to Cohere!",
					body: "Thank you for your application for the Applied AI Engineer, Agents & Automations role.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Cohere",
				role_title: "Applied AI Engineer, Agents & Automations",
				stage: "applied",
				ats: "ashby",
			});
		});

		it("8. Workable applied: Thanks for applying to Trade Nation (with salary expectation)", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "noreply@example.com",
					subject: "Thanks for applying to Trade Nation",
					body: "Your application for the Head of Data & AI job was submitted successfully.\nSalary expectation: £140,000",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Trade Nation",
				role_title: "Head of Data & AI",
				stage: "applied",
				ats: "workable",
				salary_expectation_submitted: 140000,
			});
		});

		it("9. UCL portal applied with platform_ref B28-00397", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "noreply@university.example.com",
					subject: "UCL - Associate Director Data and Digital (B28-00397) - Application Received",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "UCL",
				role_title: "Associate Director Data and Digital",
				platform_ref: "B28-00397",
				stage: "applied",
				ats: "ucl_portal",
			});
		});

		it("10. Dex jobs multi-role Thanks for applying", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "digest@jobs.example.com",
					subject: "Thanks for applying",
					body: [
						"We submitted your profile to:",
						"- Forward Deployed Engineer / Augur",
						"- Applied AI Engineer / ModelML",
						"- Product Engineer / Rome AI",
					].join("\n"),
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates).toHaveLength(3);
			expect(res.updates.map((u) => [u.role_title, u.organisation, u.stage, u.channel])).toEqual([
				["Forward Deployed Engineer", "Augur", "applied", "dex_jobs"],
				["Applied AI Engineer", "ModelML", "applied", "dex_jobs"],
				["Product Engineer", "Rome AI", "applied", "dex_jobs"],
			]);
			expect(new Set(res.updates.map((u) => u.item_key)).size).toBe(3);
		});

		it("11. Jumpstart rejected: Glide has decided not to interview you", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "hello@mkt.careers.example.com",
					subject: "Glide has decided not to interview you",
					body: "Unfortunately Glide won't be progressing for the Solutions Engineer position.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Glide",
				role_title: "Solutions Engineer",
				stage: "rejected",
				channel: "jumpstart",
			});
		});

		it("12. Jumpstart screening invite: Interview Request: Telemachus", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "hello@mkt.careers.example.com",
					subject: "Interview Request: Telemachus is keen to have a chat!",
					body: "Telemachus would like to speak about the Special Projects Lead role.",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Telemachus",
				stage: "screening",
				channel: "jumpstart",
			});
		});

		it("13. Jumpstart interview introduction with hiring contact", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "hello@mkt.careers.example.com",
					to: ["owner@personal.example", "Sam Taylor <recruiter1@example.com>"],
					subject: "Angus @ Jumpstart <> Jack @ Telemachus - interview introduction!",
					body: "Connecting you both regarding the Special Projects Lead role.",
				}),
				DEFAULT_CTX,
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Telemachus",
				role_title: "Special Projects Lead",
				stage: "screening",
				channel: "jumpstart",
				hiring_contact: {
					name: "Sam Taylor",
					email: "recruiter1@example.com",
				},
			});
		});

		it("14. Jumpstart live match: Chief of Staff @ Novabook", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "hello@mkt.careers.example.com",
					subject: "Chief of Staff @ Novabook just went live and it's a strong match for you",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Novabook",
				role_title: "Chief of Staff",
				stage: "matched",
				channel: "jumpstart",
			});
		});

		it("15. Jumpstart matchmaking task-only alert", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "matchmaking@careers.example.com",
					subject: "IMPORTANT: Please respond to your match request!",
				}),
			);
			expect(res.kind).toBe("task_only");
			if (res.kind !== "task_only") return;
			expect(res.task).toMatchObject({
				task_title: "Respond to Jumpstart match request",
				priority_level: 6,
				source: "email_triage",
			});
		});

		it("16. Cord task-only alert: New message from Paddy, Co-founder & CEO at Stackfix", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "update@hiring.example.com",
					subject: "New message from Paddy, Co-founder & CEO at Stackfix",
				}),
			);
			expect(res.kind).toBe("task_only");
			if (res.kind !== "task_only") return;
			expect(res.task).toMatchObject({
				task_title: "Read Cord message from Paddy (Stackfix)",
				priority_level: 5,
				source: "email_triage",
				organisation: "Stackfix",
				person_name: "Paddy",
			});
		});

		it("17. Firststage drafting: Finish your application for Head of Data at Data Idols", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "notifications@ats.example.com",
					subject: "Finish your application for Head of Data at Data Idols",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Data Idols",
				role_title: "Head of Data",
				stage: "drafting",
				ats: "firststage",
				needs_review: false,
			});
		});

		it("18. Firststage paused: propose withdrawn for review", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "notifications@ats.example.com",
					subject: "Application paused for Head of Data at Data Idols",
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates[0]).toMatchObject({
				organisation: "Data Idols",
				role_title: "Head of Data",
				stage: "withdrawn",
				ats: "firststage",
				needs_review: true,
			});
		});

		it("19. Jack & Jill multi-role digest", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "recruiter@talent.example.com",
					subject: "Five early-stage roles from this morning's search",
					body: [
						"1. Head of AI at Acme Labs (£120k-£150k)",
						"2. Founding Product Manager @ Beta Corp (£95k-£115k)",
					].join("\n"),
				}),
			);
			expect(res.kind).toBe("application_updates");
			if (res.kind !== "application_updates") return;
			expect(res.updates).toHaveLength(2);
			expect(res.updates[0]).toMatchObject({
				role_title: "Head of AI",
				organisation: "Acme Labs",
				salary_band: "£120k-£150k",
				stage: "matched",
				channel: "jack_and_jill",
			});
			expect(res.updates[1]).toMatchObject({
				role_title: "Founding Product Manager",
				organisation: "Beta Corp",
				salary_band: "£95k-£115k",
				stage: "matched",
				channel: "jack_and_jill",
			});
		});

		it("20. Teamtailor applied + EWOR incomplete reminder conflict resolves to drafting + review", () => {
			const e1 = makeEmail({
				message_id: "m-tt",
				thread_id: "t-ewor-1",
				from: "recruiter2@example.com",
				subject: "We have received your application!",
				body: "Thank you for applying to EWOR.",
			});
			const e2 = makeEmail({
				message_id: "m-ewor",
				thread_id: "t-ewor-2",
				from: "applications@fellowship.example.com",
				subject: "Complete your application for the EWOR Fellowship",
			});
			const r1 = classifyJobEmail(e1);
			const r2 = classifyJobEmail(e2);
			const resolved = resolveThreadConflicts([
				{ email: e1, result: r1 },
				{ email: e2, result: r2 },
			]);
			expect(resolved[0].result.kind).toBe("application_updates");
			expect(resolved[1].result.kind).toBe("application_updates");
			if (
				resolved[0].result.kind === "application_updates" &&
				resolved[1].result.kind === "application_updates"
			) {
				expect(resolved[0].result.updates[0]).toMatchObject({
					organisation: "EWOR",
					stage: "drafting",
					needs_review: true,
					conflict_detected: true,
				});
				expect(resolved[1].result.updates[0]).toMatchObject({
					organisation: "EWOR",
					role_title: "EWOR Fellowship",
					stage: "drafting",
					needs_review: true,
					conflict_detected: true,
				});
			}
		});
	});

	describe("Evidence-only emails", () => {
		it("classifies Dex CRM screening briefing as evidence_only without updating last_inbound_at", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "notify@updates.jobs.example.com",
					subject: "Briefing: Telemachus Screening (Sam Taylor)",
				}),
			);
			expect(res).toMatchObject({
				kind: "evidence_only",
				evidence: {
					subtype: "dex_screening_briefing",
					organisation: "Telemachus",
					person_name: "Sam Taylor",
					updates_last_inbound_at: false,
					direction: "inbound",
				},
			});
		});

		it("classifies inbound human reply from linked contact as evidence_only and updates last_inbound_at", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "Recruiter <recruiter@company.example>",
					subject: "Re: Interview next week",
					body: "Are you free Tuesday at 2pm?",
				}),
				DEFAULT_CTX,
			);
			expect(res).toMatchObject({
				kind: "evidence_only",
				evidence: {
					subtype: "inbound_human_reply",
					updates_last_inbound_at: true,
					direction: "inbound",
				},
			});
		});

		it("classifies owner in:sent reply on linked thread as evidence_only without updating last_inbound_at", () => {
			const res = classifyJobEmail(
				makeEmail({
					from: "owner@personal.example",
					to: ["recruiter@company.example"],
					thread_id: "thr-linked-1",
					is_sent: true,
					subject: "Re: Interview next week",
					body: "Tuesday at 2pm works great!",
				}),
				DEFAULT_CTX,
			);
			expect(res).toMatchObject({
				kind: "evidence_only",
				evidence: {
					subtype: "owner_sent_reply",
					updates_last_inbound_at: false,
					direction: "outbound",
				},
			});
		});
	});

	describe("7 Appendix B negatives (must classify as ignore)", () => {
		const negatives: Array<[string, string, string]> = [
			["Jumpstart onboarding", "applications@careers.example.com", "We've received your Jumpstart application!"],
			["Jumpstart stream welcome", "recruiter3@example.com", "Angus - Welcome to the Senior Operator Stream @ Jumpstart!"],
			["Jumpstart marketing", "hello@mkt.careers.example.com", "How to NAIL your first stage interview."],
			["Lambeth council permit", "permits@council.example.com", "Your trader application LJT216076 has been received"],
			["GitHub OAuth", "noreply@github.com", "[GitHub] A third-party OAuth application has been added to your account"],
			["Dex new matches", "digest@jobs.example.com", "New matches picked for you"],
			["Dex CRM digest", "notify@updates.jobs.example.com", "Dex Digest - Saturday, November 21, 2026 - 8 items need you"],
		];

		it.each(negatives)("%s", (_label, from, subject) => {
			const res = classifyJobEmail(makeEmail({ from, subject }));
			expect(res.kind).toBe("ignore");
		});
	});

	describe("Teamtailor org extraction & header/domain hardening", () => {
		it("extracts EWOR cleanly on Teamtailor 'applying for <role> at EWOR' and 'applying to EWOR for ...' bodies so conflict resolution matches", () => {
			const variants = [
				{
					from: "recruiter2@example.com",
					body: "Thank you for applying for the Fellowship role at EWOR.",
				},
				{
					from: "jobs@example.com",
					body: "Thank you for applying to EWOR for the Fellowship.",
				},
				{
					from: "jobs@example.com",
					body: "Thank you for applying for the Fellowship role at EWOR on Teamtailor.",
				},
			];
			const eworReminder = makeEmail({
				message_id: "m-ewor-rem",
				thread_id: "t-ewor-rem",
				from: "applications@fellowship.example.com",
				subject: "Complete your application for the EWOR Fellowship",
			});
			const remRes = classifyJobEmail(eworReminder);

			for (const [idx, variant] of variants.entries()) {
				const ttEmail = makeEmail({
					message_id: `m-tt-${idx}`,
					thread_id: `t-tt-${idx}`,
					from: variant.from,
					subject: "We have received your application!",
					body: variant.body,
				});
				const ttRes = classifyJobEmail(ttEmail);
				expect(ttRes.kind).toBe("application_updates");
				if (ttRes.kind === "application_updates") {
					expect(ttRes.updates[0].organisation).toBe("EWOR");
				}
				const resolved = resolveThreadConflicts([
					{ email: ttEmail, result: ttRes },
					{ email: eworReminder, result: remRes },
				]);
				expect(resolved[0].result.kind).toBe("application_updates");
				if (resolved[0].result.kind === "application_updates") {
					expect(resolved[0].result.updates[0]).toMatchObject({
						organisation: "EWOR",
						stage: "drafting",
						needs_review: true,
						conflict_detected: true,
					});
				}
			}
		});

		it("anchors extractEmailAddress to trailing addr-spec so display names cannot spoof senders", () => {
			expect(
				extractEmailAddress("Lever <no-reply@example.com> <attacker@evil.example>"),
			).toBe("attacker@evil.example");
			const spoofed = classifyJobEmail(
				makeEmail({
					from: "Lever <no-reply@example.com> <attacker@evil.example>",
					subject: "Thank you for applying for Strategy Director at Veeva",
				}),
			);
			expect(spoofed.kind).toBe("ignore");
		});

		it("enforces domain boundaries on Greenhouse, Jumpstart, and automated sender checks", () => {
			const spoofedGreenhouse = classifyJobEmail(
				makeEmail({
					from: "no-reply@example.com",
					subject: "Thank you for applying to Brainlabs",
				}),
			);
			expect(spoofedGreenhouse.kind).toBe("ignore");

			// A real human on a lookalike domain (notcareers.example.com) is NOT filtered out of hiring_contact
			const jumpstartIntro = classifyJobEmail(
				makeEmail({
					from: "hello@mkt.careers.example.com",
					to: ['"Taylor, Sam" <jack@notcareers.example.com>', "owner@personal.example"],
					subject: "Angus @ Jumpstart <> Jack @ Acme - interview introduction!",
					body: "Connecting you both regarding the Head of Data role.",
				}),
				DEFAULT_CTX,
			);
			expect(jumpstartIntro.kind).toBe("application_updates");
			if (jumpstartIntro.kind === "application_updates") {
				expect(jumpstartIntro.updates[0].hiring_contact).toEqual({
					name: "Taylor, Sam",
					email: "jack@notcareers.example.com",
				});
			}

			// A linked human contact on a lookalike domain (notcord.co) is NOT misclassified as automated
			const humanLookalike = classifyJobEmail(
				makeEmail({
					from: "alice@example.com",
					subject: "Re: Catching up",
					body: "Are you free Thursday?",
				}),
				{ linked_contact_emails: ["alice@example.com"] },
			);
			expect(humanLookalike.kind).toBe("evidence_only");
		});

		it("parseEmailAddressList preserves commas inside quoted display names", () => {
			expect(
				parseEmailAddressList(
					'"Taylor, Sam" <recruiter1@example.com>, "Doe, \\"Jane\\"" <jane@example.com>, owner@personal.example',
				),
			).toEqual([
				'"Taylor, Sam" <recruiter1@example.com>',
				'"Doe, \\"Jane\\"" <jane@example.com>',
				"owner@personal.example",
			]);
		});
	});
});
