import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { DoctorPort } from "../../ports/doctor.js";
import {
	DOCTOR_FAMILIES,
	renderDoctorReport,
	verdictFor,
	type DoctorCheck,
	type DoctorFamily,
	type DoctorStatus,
} from "./doctorReport.js";

export const ahosDoctorInput = {
	families: z
		.array(z.enum(DOCTOR_FAMILIES))
		.optional()
		.describe(
			"Which check families to run: 'credentials' (present, authenticates, right account), 'wiring' (integration rows, dos pointers, surface_role_map, Notion options), 'travels' (registered skills match the repo receipts), 'outcomes' (routines produced what they should have: the dos sweep closed its days). Default: all four.",
		),
};

export const ahosDoctorSchema = z.object(ahosDoctorInput);

export type AhosDoctorInput = z.infer<typeof ahosDoctorSchema>;

export interface AhosDoctorOutput {
	checks: DoctorCheck[];
	verdict: DoctorStatus;
	report: string;
}

export function formatAhosDoctorMcp(output: AhosDoctorOutput): string {
	return output.report;
}

export function createAhosDoctorAction(port: DoctorPort) {
	return defineAction({
		id: "ahos_doctor",
		domain: "ops",
		description:
			"Is ahOS correctly set up, and what is missing? One read-only pass over credentials (set under " +
			"which name, authenticates, right account), wiring (integration rows, dos pointers, " +
			"surface_role_map, Notion options), what travels (registered skills match the repo) and " +
			"outcomes (did the dos sweep close the days it should have). Each " +
			"finding carries its exact fix; nothing is changed. Full notes: docs/guides/tools/ahos_doctor.md",
		schema: ahosDoctorSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input: AhosDoctorInput): Promise<AhosDoctorOutput> => {
			const defaultFamilies: readonly DoctorFamily[] = Array.isArray(port.families)
				? (port.families as readonly DoctorFamily[])
				: DOCTOR_FAMILIES;
			const families: DoctorFamily[] =
				input.families && input.families.length > 0
					? [...new Set(input.families)]
					: [...defaultFamilies];

			const results = await Promise.all(
				families.map(async (family): Promise<DoctorCheck[]> => {
					try {
						return await port.run(family);
					} catch (err) {
						if (err instanceof Error && err.name === "AdapterUnavailableError") {
							throw err;
						}
						return [
							{
								family,
								name: family,
								status: "fail",
								detail: `could not run: ${err instanceof Error ? err.message : String(err)}`,
								fix: "re-run; if it persists, the error above names the failing read",
							},
						];
					}
				}),
			);

			const checks = results.flat();
			return {
				checks,
				verdict: verdictFor(checks),
				report: renderDoctorReport(checks),
			};
		},
		formatMcp: formatAhosDoctorMcp,
	});
}
