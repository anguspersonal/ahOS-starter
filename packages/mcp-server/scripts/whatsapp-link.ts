/**
 * Link or sync a personal WhatsApp account for ahOS read-only actions
 * (`whatsapp_status`, `whatsapp_list_chats`, `whatsapp_read_messages`, `whatsapp_ingest`).
 *
 * Usage:
 *   npm run whatsapp-link -w @ahkms/mcp-server                  # interactive QR pairing + sync via Baileys
 *   npm run whatsapp-link -w @ahkms/mcp-server -- --phone 447... # pair via 8-char phone pairing code
 *   npm run whatsapp-link -w @ahkms/mcp-server -- --import-macos-db # hydrate store from macOS WhatsApp Desktop SQLite
 *   npm run whatsapp-link -w @ahkms/mcp-server -- --status       # inspect local store + session status
 */

import {
	createWhatsappAdapter,
	readBaileysAuthCreds,
	resolveWhatsappPaths,
} from "@ahkms/core/adapters";
import { formatWhatsappStatusMcp } from "@ahkms/core/actions";
import {
	DEFAULT_MACOS_WHATSAPP_DB_PATH,
	importFromMacosWhatsappDb,
	syncWhatsappViaBaileys,
} from "../src/whatsapp/baileysSync.js";

function parseArgs(argv: string[]) {
	let statusOnly = false;
	let importMacosDb = false;
	let pairingPhone: string | undefined;
	let timeoutMs: number | undefined;
	let limit: number | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--status") {
			statusOnly = true;
		} else if (arg === "--import-macos-db" || arg === "--from-macos-db") {
			importMacosDb = true;
		} else if ((arg === "--phone" || arg === "--pairing-code") && argv[i + 1]) {
			pairingPhone = argv[++i];
		} else if (arg.startsWith("--phone=")) {
			pairingPhone = arg.slice("--phone=".length);
		} else if (arg.startsWith("--pairing-code=")) {
			pairingPhone = arg.slice("--pairing-code=".length);
		} else if (arg === "--timeout" && argv[i + 1]) {
			timeoutMs = Number(argv[++i]);
		} else if (arg === "--limit" && argv[i + 1]) {
			limit = Number(argv[++i]);
		}
	}

	return { statusOnly, importMacosDb, pairingPhone, timeoutMs, limit };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { storePath, authDir } = resolveWhatsappPaths(null);
	const adapter = createWhatsappAdapter({
		defaultStorePath: storePath,
		defaultAuthDir: authDir,
	});

	if (args.statusOnly) {
		const status = await adapter.getStatus({ sync: false });
		console.log(formatWhatsappStatusMcp(status));
		return;
	}

	if (args.importMacosDb) {
		const creds = readBaileysAuthCreds(authDir);
		console.log(`Importing chats & messages from macOS WhatsApp Desktop (${DEFAULT_MACOS_WHATSAPP_DB_PATH})...`);
		const summary = importFromMacosWhatsappDb({
			dbPath: DEFAULT_MACOS_WHATSAPP_DB_PATH,
			storePath,
			limit: args.limit ?? 3000,
			accountJid: creds.accountJid,
			accountName: creds.accountName,
		});
		console.log(
			`Imported ${summary.syncedChats} chats and ${summary.syncedMessages} messages into ${summary.storePath} (total: ${summary.totalChats} chats, ${summary.totalMessages} messages).`,
		);
		const status = await adapter.getStatus({ sync: false });
		console.log("\n" + formatWhatsappStatusMcp(status));
		return;
	}

	console.log(`Starting WhatsApp companion sync (authDir: ${authDir}, storePath: ${storePath})...`);
	const firstPass = await syncWhatsappViaBaileys({
		authDir,
		storePath,
		interactive: true,
		pairingPhone: args.pairingPhone,
		timeoutMs: args.timeoutMs ?? 120_000,
		onLog: (msg) => console.log(msg),
	});

	// If initial QR scan triggered stream restart (515), run a second non-interactive pass to collect history.
	const credsAfterFirst = readBaileysAuthCreds(authDir);
	if (credsAfterFirst.linked && firstPass.syncedMessages === 0 && firstPass.totalMessages === 0) {
		await syncWhatsappViaBaileys({
			authDir,
			storePath,
			interactive: false,
			timeoutMs: 20_000,
			onLog: (msg) => console.log(msg),
		});
	}

	const status = await adapter.getStatus({ sync: false });
	console.log("\n" + formatWhatsappStatusMcp(status));
}

main().catch((err) => {
	console.error("whatsapp-link failed:", err instanceof Error ? err.message : String(err));
	process.exit(1);
});
