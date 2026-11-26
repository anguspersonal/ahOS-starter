import {
	DOCTOR_FAMILIES,
	type DoctorCheck,
	type DoctorFamily,
	type DoctorPort,
} from "@ahkms/core";
import { checkCredentials } from "./credentialChecks.js";
import { checkOutcomes } from "./outcomeChecks.js";
import { checkTravels } from "./travelChecks.js";
import { checkWiring } from "./wiringChecks.js";

const RUNNERS: Record<DoctorFamily, () => Promise<DoctorCheck[]>> = {
	credentials: checkCredentials,
	wiring: checkWiring,
	travels: checkTravels,
	outcomes: checkOutcomes,
};

export function createDoctorPort(
	runners: Record<DoctorFamily, () => Promise<DoctorCheck[]>> = RUNNERS,
): DoctorPort {
	return {
		families: DOCTOR_FAMILIES,
		run: (family) => runners[family](),
	};
}

export const doctorPort: DoctorPort = createDoctorPort();
