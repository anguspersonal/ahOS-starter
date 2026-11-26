import { describe, expect, it } from "vitest";
import {
	type CandidateArtifactForCvSweep,
	type TrackedCvDocumentContext,
	extractDriveFileId,
	isCvSweepEvidenceExcluded,
} from "../tools/cvSweepExclusion.js";

describe("cvSweepExclusion (#1246, ADR-099 §3, .claude/skills/cv/SKILL.md rule 2)", () => {
	// 2026-09-29 files from issue #1246:
	// - Tracked CV entity: ca6279c4-fc79-4bf3-939f-48a0d2369c6b
	//   - Canonical PDF (4eb532e1): 1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE
	//   - DOCX Rendition (e0e6ade5): 1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9
	// - Tracked Master CV entity: 2cec4081-c7e0-4e2b-b8bd-fc7fc26c6926
	//   - Canonical PDF (77487f45): 1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_
	//   - DOCX Rendition (6d93b140): 1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1
	const context: TrackedCvDocumentContext = {
		trackedEntityIds: new Set([
			"ca6279c4-fc79-4bf3-939f-48a0d2369c6b",
			"2cec4081-c7e0-4e2b-b8bd-fc7fc26c6926",
		]),
		trackedDocKinds: new Set(["cv", "cv_master"]),
		driveFileIds: new Set([
			"1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE",
			"1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9",
			"1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_",
			"1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1",
		]),
		linkedArtifactIds: new Set([
			"4eb532e1-ade1-4fbb-8670-26341f261dda",
			"e0e6ade5-bcbc-4d70-b0ac-6f0a9622c29b",
			"77487f45-26ca-493a-bbe0-2cb7bff4a159",
			"6d93b140-e5b1-41af-867b-371aff6e5e00",
		]),
	};

	describe("extractDriveFileId", () => {
		it("extracts from standard Drive file URL", () => {
			expect(
				extractDriveFileId(
					"https://drive.google.com/file/d/1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE/view?usp=drivesdk",
				),
			).toBe("1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE");
		});

		it("extracts from Docs edit URL", () => {
			expect(
				extractDriveFileId(
					"https://docs.google.com/document/d/1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9/edit?usp=drivesdk",
				),
			).toBe("1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9");
		});

		it("extracts from open?id URL", () => {
			expect(
				extractDriveFileId("https://drive.google.com/open?id=1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_"),
			).toBe("1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_");
		});

		it("passes through raw Drive file ID", () => {
			expect(extractDriveFileId("1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1")).toBe(
				"1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1",
			);
		});

		it("returns null on non-drive URL or short random string", () => {
			expect(extractDriveFileId("https://github.com/org/repo/pull/123")).toBeNull();
			expect(extractDriveFileId("short-str")).toBeNull();
			expect(extractDriveFileId(null)).toBeNull();
		});
	});

	describe("Acceptance Criteria 1: Drive-discovered twins of tracked CVs", () => {
		it("excludes a discovered_gdrive pointer matching the canonical CV PDF (2026-09-29)", () => {
			const twin: CandidateArtifactForCvSweep = {
				id: "9a123456-1111-2222-3333-444444444444",
				title: "Angus Hally CV 2026-09-29.pdf", // No "CV render" in title!
				tags: [], // No tags!
				source: "1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE",
				sourceDriveFileId: "1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE",
			};
			const res = isCvSweepEvidenceExcluded(twin, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("Drive file id 1Y4u_Q3bnctVCjlMGrx9EiUrpDbHteQQE");
		});

		it("excludes a discovered_gdrive pointer matching the CV docx rendition (2026-09-29)", () => {
			const twin: CandidateArtifactForCvSweep = {
				id: "8b234567-2222-3333-4444-555555555555",
				title: "Angus Hally CV 2026-09-29.docx",
				tags: [],
				source: "1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9",
				sourceDriveFileId: "1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9",
			};
			const res = isCvSweepEvidenceExcluded(twin, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("Drive file id 1ebLcmj2cBJ_z5P4pb-r9YVTNRL0m2JN9");
		});

		it("excludes a discovered_gdrive pointer matching the Master CV canonical PDF (2026-09-29)", () => {
			const twin: CandidateArtifactForCvSweep = {
				id: "7c345678-3333-4444-5555-666666666666",
				title: "Angus Hally Master CV 2026-09-29.pdf",
				tags: [],
				source: "1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_",
				sourceDriveFileId: "1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_",
			};
			const res = isCvSweepEvidenceExcluded(twin, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("Drive file id 1EeTwCBVPpYaW8Hs0OMqOrg4UxEJhudh_");
		});

		it("excludes a discovered_gdrive pointer matching the Master CV docx rendition (2026-09-29)", () => {
			const twin: CandidateArtifactForCvSweep = {
				id: "6d456789-4444-5555-6666-777777777777",
				title: "Angus Hally Master CV 2026-09-29.docx",
				tags: [],
				source: "1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1",
				sourceDriveFileId: "1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1",
			};
			const res = isCvSweepEvidenceExcluded(twin, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("Drive file id 1iVYRVLxZ7VsG-aUpbJ8amxRE9kicG9Z1");
		});
	});

	describe("Acceptance Criteria 2: Tagged doc:cv / doc:cv_master or linked to tracked CV entity", () => {
		it("excludes artifact tagged doc:cv even when title does not say CV render", () => {
			const oldCv: CandidateArtifactForCvSweep = {
				id: "a97f9aff-db43-478e-9d43-9354941ddf6d",
				title: "Angus Hally CV Sept 2022.pdf", // No "CV render" in title
				tags: ["doc:cv"],
			};
			const res = isCvSweepEvidenceExcluded(oldCv, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("Tagged doc:cv");
		});

		it("excludes artifact tagged doc:cv_master even when title does not say CV render", () => {
			const oldCv: CandidateArtifactForCvSweep = {
				id: "b1111111-2222-3333-4444-555555555555",
				title: "Angus Hally Comprehensive Resume 2023.pdf",
				tags: ["doc:cv_master"],
			};
			const res = isCvSweepEvidenceExcluded(oldCv, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("Tagged doc:cv_master");
		});

		it("excludes artifact linked to a tracked CV document entity even when title does not say CV render", () => {
			const linkedCv: CandidateArtifactForCvSweep = {
				id: "c2222222-3333-4444-5555-666666666666",
				title: "Angus Hally CV Sept 2022 156.pdf",
				tags: [],
				linkedEntityIds: ["ca6279c4-fc79-4bf3-939f-48a0d2369c6b"], // Tracked CV entity
			};
			const res = isCvSweepEvidenceExcluded(linkedCv, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("linked to tracked CV document entity ca6279c4-fc79-4bf3-939f-48a0d2369c6b");
		});

		it("excludes known tracked CV artifact IDs directly", () => {
			const knownArtifact: CandidateArtifactForCvSweep = {
				id: "4eb532e1-ade1-4fbb-8670-26341f261dda",
				title: "Angus Hally CV 2026-09-29.pdf",
			};
			const res = isCvSweepEvidenceExcluded(knownArtifact, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain("canonical, rendition, or linked version");
		});
	});

	describe("Title markers and content subtype tags fallback", () => {
		it("excludes artifact with title containing CV render", () => {
			const render: CandidateArtifactForCvSweep = {
				id: "d3333333-4444-5555-6666-777777777777",
				title: "Angus Hally - CV render (2026-10-01).pdf",
				tags: [],
			};
			const res = isCvSweepEvidenceExcluded(render, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain('Title contains "CV render"');
		});

		it("excludes artifact with title ending : job description", () => {
			const jd: CandidateArtifactForCvSweep = {
				id: "e4444444-5555-6666-7777-888888888888",
				title: "Acme Corp Staff Engineer: job description",
				tags: [],
			};
			const res = isCvSweepEvidenceExcluded(jd, context);
			expect(res.excluded).toBe(true);
			expect(res.reason).toContain('Title ends with ": job description"');
		});

		it("excludes artifact tagged cv_render or job_description", () => {
			const render: CandidateArtifactForCvSweep = {
				id: "f5555555-6666-7777-8888-999999999999",
				title: "Random Draft.pdf",
				tags: ["cv_render"],
			};
			expect(isCvSweepEvidenceExcluded(render, context).excluded).toBe(true);

			const jd: CandidateArtifactForCvSweep = {
				id: "a6666666-7777-8888-9999-000000000000",
				title: "Position Spec.pdf",
				tags: ["job_description"],
			};
			expect(isCvSweepEvidenceExcluded(jd, context).excluded).toBe(true);
		});
	});

	describe("Allows legitimate career evidence", () => {
		it("allows PR review, product spec, meeting notes, etc.", () => {
			const pr: CandidateArtifactForCvSweep = {
				id: "12345678-0000-0000-0000-000000000001",
				title: "PR #1248: Implement career ledger seed validation",
				tags: ["github", "pr"],
				sourceUrl: "https://github.com/org/repo/pull/1248",
			};
			expect(isCvSweepEvidenceExcluded(pr, context).excluded).toBe(false);

			const meetingNote: CandidateArtifactForCvSweep = {
				id: "12345678-0000-0000-0000-000000000002",
				title: "2026-09-30 Architecture review notes",
				tags: ["notes", "meeting"],
			};
			expect(isCvSweepEvidenceExcluded(meetingNote, context).excluded).toBe(false);
		});
	});
});
