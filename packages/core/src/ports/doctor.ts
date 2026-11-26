import type { DoctorCheck, DoctorFamily } from "../actions/config/doctorReport.js";

export interface DoctorPort {
	families?: readonly DoctorFamily[];
	run(family: DoctorFamily): Promise<DoctorCheck[]>;
}
