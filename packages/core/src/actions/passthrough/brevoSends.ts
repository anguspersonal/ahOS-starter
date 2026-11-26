const BREVO_SEND_TOOLS = new Set([
	"conversations_post_messages",
	"conversations_post_pushed_messages",
	"contact_import_export_create_doi_contact",
	"users_inviteuser",
	"accounts_invite_admin_user",
	"senders_create_sender",
]);
const BREVO_NON_SEND_STATUSES = new Set([
	"suspended",
	"archive",
	"darchive",
	"replicate",
	"replicateTemplate",
	"draft",
]);

/** ADR-104 D5: Brevo send detection rule, checked against the live catalogue (2026-10-10, 282 tools). */
export function brevoCallSends(input: unknown): boolean {
	const raw = (input ?? {}) as {
		name?: unknown;
		arguments?: Record<string, unknown>;
		notification?: unknown;
	};
	const name = typeof raw.name === "string" ? raw.name : "";
	const args = raw.arguments && typeof raw.arguments === "object" ? raw.arguments : {};
	if (/(^|_)send(_|$)/i.test(name) || BREVO_SEND_TOOLS.has(name)) return true;
	for (const k of ["scheduledAt", "sendAtBestTime", "rescheduleFor"]) {
		if (args[k] !== undefined && args[k] !== null && args[k] !== false) return true;
	}
	if (name.endsWith("_campaign_status")) {
		return typeof args.status !== "string" || !BREVO_NON_SEND_STATUSES.has(args.status);
	}
	if (name === "users_putresendcancelinvitation") return args.action !== "cancel";
	if (name === "payments_create_payment_request") {
		const notif = args.notification ?? raw.notification;
		return Boolean(notif && (typeof notif !== "object" || Object.keys(notif).length > 0));
	}
	return false;
}
