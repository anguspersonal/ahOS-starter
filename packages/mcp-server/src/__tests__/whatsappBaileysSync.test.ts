import { describe, expect, it } from "vitest";
import {
	convertBaileysMessage,
	extractBaileysMessageFields,
} from "../whatsapp/baileysSync.js";

describe("whatsapp Baileys message extraction and conversion", () => {
	it("extracts plain conversation, extendedTextMessage with quoted reply, and media captions", () => {
		expect(
			extractBaileysMessageFields({
				conversation: "  Hello from WhatsApp!  ",
			}),
		).toEqual({
			text: "Hello from WhatsApp!",
			mediaType: null,
			quotedText: null,
		});

		expect(
			extractBaileysMessageFields({
				extendedTextMessage: {
					text: "Sounds good, let's do 4pm.",
					contextInfo: {
						quotedMessage: {
							conversation: "Can we meet tomorrow?",
						},
					},
				},
			}),
		).toEqual({
			text: "Sounds good, let's do 4pm.",
			mediaType: null,
			quotedText: "Can we meet tomorrow?",
		});

		expect(
			extractBaileysMessageFields({
				ephemeralMessage: {
					message: {
						imageMessage: {
							caption: "Whiteboard snapshot",
						},
					},
				},
			}),
		).toEqual({
			text: "Whiteboard snapshot",
			mediaType: "image",
			quotedText: null,
		});
	});

	it("converts WAMessage into normalized WhatsappMessage and skips status@broadcast", () => {
		const broadcast = convertBaileysMessage(
			{
				key: { remoteJid: "status@broadcast", id: "B1" },
				message: { conversation: "Status update" },
			} as any,
			"447700900111@s.whatsapp.net",
		);
		expect(broadcast).toBeNull();

		const dm = convertBaileysMessage(
			{
				key: {
					remoteJid: "447700900222:5@s.whatsapp.net",
					id: "MSG-42",
					fromMe: false,
				},
				pushName: "Alice",
				messageTimestamp: 1761652800,
				message: {
					conversation: "Ping!",
				},
			} as any,
			"447700900111@s.whatsapp.net",
		);
		expect(dm).toEqual({
			id: "MSG-42",
			chatJid: "447700900222@s.whatsapp.net",
			chatName: "447700900222@s.whatsapp.net",
			chatKind: "dm",
			senderJid: "447700900222@s.whatsapp.net",
			senderName: "Alice",
			fromMe: false,
			timestamp: new Date(1761652800 * 1000).toISOString(),
			text: "Ping!",
			quotedText: null,
			mediaType: null,
		});
	});
});
