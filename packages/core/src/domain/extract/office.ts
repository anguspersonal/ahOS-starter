export type OfficeOpenXmlKind = "docx" | "xlsx" | "pptx";

export const OFFICE_OPEN_XML_MIMES: Record<OfficeOpenXmlKind, string> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const MIME_TO_KIND = new Map<string, OfficeOpenXmlKind>([
	[OFFICE_OPEN_XML_MIMES.docx, "docx"],
	[OFFICE_OPEN_XML_MIMES.xlsx, "xlsx"],
	[OFFICE_OPEN_XML_MIMES.pptx, "pptx"],
]);

const EXTENSION_TO_KIND = new Map<string, OfficeOpenXmlKind>([
	[".docx", "docx"],
	[".xlsx", "xlsx"],
	[".pptx", "pptx"],
]);

/**
 * Detect whether a MIME type or file name/path refers to an Office Open XML
 * document (.docx, .xlsx, .pptx).
 */
export function detectOfficeOpenXmlKind(
	mimeType?: string | null,
	fileNameOrPath?: string | null,
): OfficeOpenXmlKind | null {
	if (mimeType) {
		const baseMime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
		const matchedByMime = MIME_TO_KIND.get(baseMime);
		if (matchedByMime) {
			return matchedByMime;
		}
	}

	if (fileNameOrPath) {
		const cleanPath = fileNameOrPath.split(/[?#]/)[0]?.trim() ?? "";
		const dotIndex = cleanPath.lastIndexOf(".");
		if (dotIndex >= 0) {
			const ext = cleanPath.slice(dotIndex).toLowerCase();
			const matchedByExt = EXTENSION_TO_KIND.get(ext);
			if (matchedByExt) {
				return matchedByExt;
			}
		}
	}

	return null;
}

interface ZipEntryMeta {
	name: string;
	compressionMethod: number;
	compressedData: Uint8Array;
}

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

function normalizeZipPath(rawPath: string): string {
	return rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function findEocdOffset(bytes: Uint8Array, view: DataView): number {
	const minEocdSize = 22;
	if (bytes.byteLength < minEocdSize) return -1;
	const maxCommentLength = 0xffff;
	const minOffset = Math.max(0, bytes.byteLength - minEocdSize - maxCommentLength);
	for (let offset = bytes.byteLength - minEocdSize; offset >= minOffset; offset--) {
		if (view.getUint32(offset, true) === ZIP_EOCD_SIG) {
			return offset;
		}
	}
	return -1;
}

function parseZipEntriesFromCentralDirectory(
	bytes: Uint8Array,
	view: DataView,
	eocdOffset: number,
	decoder: TextDecoder,
): Map<string, ZipEntryMeta> | null {
	const totalEntries = view.getUint16(eocdOffset + 10, true);
	const centralDirOffset = view.getUint32(eocdOffset + 16, true);
	if (centralDirOffset >= bytes.byteLength) {
		return null;
	}

	const entries = new Map<string, ZipEntryMeta>();
	let cdOffset = centralDirOffset;

	for (let i = 0; i < totalEntries; i++) {
		if (cdOffset + 46 > bytes.byteLength) break;
		if (view.getUint32(cdOffset, true) !== ZIP_CENTRAL_DIR_HEADER_SIG) {
			return null;
		}

		const compressionMethod = view.getUint16(cdOffset + 10, true);
		const compressedSize = view.getUint32(cdOffset + 20, true);
		const fileNameLength = view.getUint16(cdOffset + 28, true);
		const extraFieldLength = view.getUint16(cdOffset + 30, true);
		const fileCommentLength = view.getUint16(cdOffset + 32, true);
		const localHeaderOffset = view.getUint32(cdOffset + 42, true);

		const nameStart = cdOffset + 46;
		const nameEnd = nameStart + fileNameLength;
		if (nameEnd > bytes.byteLength) break;
		const name = normalizeZipPath(decoder.decode(bytes.subarray(nameStart, nameEnd)));

		cdOffset = nameEnd + extraFieldLength + fileCommentLength;

		if (localHeaderOffset + 30 > bytes.byteLength) continue;
		if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIG) continue;

		const localNameLen = view.getUint16(localHeaderOffset + 26, true);
		const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
		const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > bytes.byteLength) continue;

		entries.set(name, {
			name,
			compressionMethod,
			compressedData: bytes.subarray(dataStart, dataEnd),
		});
	}

	return entries;
}

function parseZipEntriesFromLocalHeaders(
	bytes: Uint8Array,
	view: DataView,
	decoder: TextDecoder,
): Map<string, ZipEntryMeta> {
	const entries = new Map<string, ZipEntryMeta>();
	let offset = 0;

	while (offset + 30 <= bytes.byteLength) {
		const sig = view.getUint32(offset, true);
		if (sig !== ZIP_LOCAL_FILE_HEADER_SIG) {
			break;
		}

		const compressionMethod = view.getUint16(offset + 8, true);
		const compressedSize = view.getUint32(offset + 18, true);
		const fileNameLength = view.getUint16(offset + 26, true);
		const extraFieldLength = view.getUint16(offset + 28, true);

		const nameStart = offset + 30;
		const nameEnd = nameStart + fileNameLength;
		const dataStart = nameEnd + extraFieldLength;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > bytes.byteLength) {
			break;
		}

		const name = normalizeZipPath(decoder.decode(bytes.subarray(nameStart, nameEnd)));
		entries.set(name, {
			name,
			compressionMethod,
			compressedData: bytes.subarray(dataStart, dataEnd),
		});

		offset = dataEnd;
	}

	return entries;
}

function parseZipArchive(bytes: Uint8Array): Map<string, ZipEntryMeta> {
	if (bytes.byteLength < 30) {
		throw new Error("Invalid Office Open XML archive: buffer is too short to be a ZIP file.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder("utf-8");

	const eocdOffset = findEocdOffset(bytes, view);
	if (eocdOffset >= 0) {
		const fromCd = parseZipEntriesFromCentralDirectory(bytes, view, eocdOffset, decoder);
		if (fromCd && fromCd.size > 0) {
			return fromCd;
		}
	}

	const fromLocal = parseZipEntriesFromLocalHeaders(bytes, view, decoder);
	if (fromLocal.size === 0) {
		throw new Error("Invalid Office Open XML archive: no valid ZIP entries found.");
	}
	return fromLocal;
}

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
	if (compressed.byteLength === 0) {
		return new Uint8Array(0);
	}
	const copy = new Uint8Array(compressed.byteLength);
	copy.set(compressed);
	const stream = new ReadableStream<BufferSource>({
		start(controller) {
			controller.enqueue(copy);
			controller.close();
		},
	}).pipeThrough(new DecompressionStream("deflate-raw"));

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			totalLength += value.byteLength;
		}
	}

	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function readZipEntryText(
	entries: Map<string, ZipEntryMeta>,
	entryPath: string,
	decoder: TextDecoder,
): Promise<string | null> {
	const entry = entries.get(normalizeZipPath(entryPath));
	if (!entry) return null;

	if (entry.compressionMethod === 0) {
		return decoder.decode(entry.compressedData);
	}
	if (entry.compressionMethod === 8) {
		const inflated = await inflateRawBytes(entry.compressedData);
		return decoder.decode(inflated);
	}
	throw new Error(
		`Unsupported ZIP compression method ${entry.compressionMethod} in entry "${entry.name}".`,
	);
}

/**
 * Decode standard and numeric XML character entities in a single pass.
 */
export function decodeXmlEntities(raw: string): string {
	return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (full, entity: string) => {
		switch (entity) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				if (entity.startsWith("#x") || entity.startsWith("#X")) {
					const code = Number.parseInt(entity.slice(2), 16);
					return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
				}
				if (entity.startsWith("#")) {
					const code = Number.parseInt(entity.slice(1), 10);
					return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
				}
				return full;
			}
		}
	});
}

function escapeMarkdownTableCell(value: string): string {
	return value
		.replace(/\r?\n/g, " ")
		.replace(/\|/g, "\\|")
		.trim();
}

function formatMarkdownTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	const colCount = Math.max(...rows.map((r) => r.length), 0);
	if (colCount === 0) return "";

	const normalizedRows = rows.map((row) => {
		const cells: string[] = [];
		for (let i = 0; i < colCount; i++) {
			cells.push(escapeMarkdownTableCell(row[i] ?? ""));
		}
		return `| ${cells.join(" | ")} |`;
	});

	const separator = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
	return [normalizedRows[0], separator, ...normalizedRows.slice(1)].join("\n");
}

function extractDocxParagraphText(paragraphXml: string): string {
	const tokenRegex =
		/<w:t(?=\s|>)[^>]*>([\s\S]*?)<\/w:t>|<w:tab(?=\s|\/|>)[^>]*\/?>|<w:(?:br|cr)(?=\s|\/|>)[^>]*\/?>/g;
	const parts: string[] = [];

	for (const match of paragraphXml.matchAll(tokenRegex)) {
		const fullMatch = match[0];
		if (fullMatch.startsWith("<w:tab")) {
			parts.push("\t");
		} else if (fullMatch.startsWith("<w:t")) {
			parts.push(decodeXmlEntities(match[1] ?? ""));
		} else {
			parts.push("\n");
		}
	}

	return parts.join("").trim();
}

function extractDocxTableMarkdown(tableXml: string): string {
	const rowRegex = /<w:tr(?=\s|>)[^>]*>([\s\S]*?)<\/w:tr>/g;
	const cellRegex = /<w:tc(?=\s|>)[^>]*>([\s\S]*?)<\/w:tc>/g;
	const paragraphRegex = /<w:p(?=\s|>|\/)[^>]*>([\s\S]*?)<\/w:p>/g;

	const rows: string[][] = [];
	for (const rowMatch of tableXml.matchAll(rowRegex)) {
		const rowXml = rowMatch[1] ?? "";
		const cells: string[] = [];
		for (const cellMatch of rowXml.matchAll(cellRegex)) {
			const cellXml = cellMatch[1] ?? "";
			const cellParagraphs: string[] = [];
			for (const pMatch of cellXml.matchAll(paragraphRegex)) {
				const pText = extractDocxParagraphText(pMatch[1] ?? "");
				if (pText.length > 0) {
					cellParagraphs.push(pText);
				}
			}
			cells.push(cellParagraphs.join(" "));
		}
		if (cells.some((c) => c.length > 0)) {
			rows.push(cells);
		}
	}

	return formatMarkdownTable(rows);
}

async function extractDocxText(
	entries: Map<string, ZipEntryMeta>,
	decoder: TextDecoder,
): Promise<string> {
	const documentXml = await readZipEntryText(entries, "word/document.xml", decoder);
	if (documentXml === null) {
		throw new Error("Invalid .docx archive: missing word/document.xml.");
	}

	const blockRegex =
		/<w:tbl(?=\s|>|\/)[^>]*>([\s\S]*?)<\/w:tbl>|<w:p(?=\s|>|\/)[^>]*>([\s\S]*?)<\/w:p>/g;
	const blocks: string[] = [];

	for (const match of documentXml.matchAll(blockRegex)) {
		const fullMatch = match[0];
		if (fullMatch.startsWith("<w:tbl")) {
			const tableMd = extractDocxTableMarkdown(match[1] ?? "");
			if (tableMd.length > 0) {
				blocks.push(tableMd);
			}
		} else {
			const paragraphText = extractDocxParagraphText(match[2] ?? "");
			if (paragraphText.length > 0) {
				blocks.push(paragraphText);
			}
		}
	}

	return blocks.join("\n\n");
}

function getXmlAttribute(tagAttrs: string, attrName: string): string | null {
	const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
	const match = regex.exec(tagAttrs);
	if (!match) return null;
	return decodeXmlEntities(match[1] ?? match[2] ?? "");
}

function parseSharedStrings(sharedStringsXml: string | null): string[] {
	if (!sharedStringsXml) return [];
	const strings: string[] = [];
	const siRegex = /<si(?=\s|>)[^>]*>([\s\S]*?)<\/si>/g;
	const tRegex = /<t(?=\s|>)[^>]*>([\s\S]*?)<\/t>/g;

	for (const siMatch of sharedStringsXml.matchAll(siRegex)) {
		const siBody = siMatch[1] ?? "";
		const parts: string[] = [];
		for (const tMatch of siBody.matchAll(tRegex)) {
			parts.push(decodeXmlEntities(tMatch[1] ?? ""));
		}
		strings.push(parts.join(""));
	}

	return strings;
}

function columnRefToIndex(cellRef: string | null): number | null {
	if (!cellRef) return null;
	const match = /^([A-Za-z]+)/.exec(cellRef.trim());
	if (!match) return null;
	const letters = match[1].toUpperCase();
	let col = 0;
	for (let i = 0; i < letters.length; i++) {
		col = col * 26 + (letters.charCodeAt(i) - 64);
	}
	return col - 1;
}

interface WorkbookSheetRef {
	name: string;
	entryPath: string;
}

function resolveWorkbookSheets(
	workbookXml: string | null,
	relsXml: string | null,
	entries: Map<string, ZipEntryMeta>,
): WorkbookSheetRef[] {
	const relTargetById = new Map<string, string>();
	if (relsXml) {
		const relRegex = /<Relationship(?=\s|>)([^>]*?)\/?>/g;
		for (const match of relsXml.matchAll(relRegex)) {
			const attrs = match[1] ?? "";
			const id = getXmlAttribute(attrs, "Id");
			const target = getXmlAttribute(attrs, "Target");
			if (id && target) {
				const normalizedTarget = normalizeZipPath(target);
				const resolved = normalizedTarget.startsWith("xl/")
					? normalizedTarget
					: `xl/${normalizedTarget.replace(/^\.\//, "")}`;
				relTargetById.set(id, resolved);
			}
		}
	}

	const sheets: WorkbookSheetRef[] = [];
	if (workbookXml) {
		const sheetRegex = /<sheet(?=\s|>)([^>]*?)\/?>/g;
		let index = 0;
		for (const match of workbookXml.matchAll(sheetRegex)) {
			index += 1;
			const attrs = match[1] ?? "";
			const name = getXmlAttribute(attrs, "name") ?? `Sheet ${index}`;
			const rId = getXmlAttribute(attrs, "r:id") ?? getXmlAttribute(attrs, "id");
			const sheetId = getXmlAttribute(attrs, "sheetId");

			let entryPath = rId ? relTargetById.get(rId) : undefined;
			if (!entryPath || !entries.has(entryPath)) {
				const byIndex = `xl/worksheets/sheet${index}.xml`;
				const bySheetId = sheetId ? `xl/worksheets/sheet${sheetId}.xml` : undefined;
				if (entries.has(byIndex)) {
					entryPath = byIndex;
				} else if (bySheetId && entries.has(bySheetId)) {
					entryPath = bySheetId;
				}
			}

			if (entryPath && entries.has(entryPath)) {
				sheets.push({ name, entryPath });
			}
		}
	}

	if (sheets.length > 0) {
		return sheets;
	}

	const fallbackSheets: { num: number; entryPath: string }[] = [];
	for (const entryPath of entries.keys()) {
		const match = /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(entryPath);
		if (match) {
			fallbackSheets.push({ num: Number.parseInt(match[1], 10), entryPath });
		}
	}
	fallbackSheets.sort((a, b) => a.num - b.num);
	return fallbackSheets.map((s) => ({
		name: `Sheet ${s.num}`,
		entryPath: s.entryPath,
	}));
}

function extractWorksheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
	const rowRegex = /<row(?=\s|>)[^>]*>([\s\S]*?)<\/row>/g;
	const cellRegex = /<c(?=\s|>|\/)([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
	const vRegex = /<v(?=\s|>)[^>]*>([\s\S]*?)<\/v>/;
	const isRegex = /<is(?=\s|>)[^>]*>([\s\S]*?)<\/is>/;
	const tRegex = /<t(?=\s|>)[^>]*>([\s\S]*?)<\/t>/g;

	const sparseRows: Map<number, string>[] = [];
	let maxColIndex = -1;

	for (const rowMatch of sheetRegexMatches(sheetXml, rowRegex)) {
		const rowBody = rowMatch[1] ?? "";
		const cellMap = new Map<number, string>();
		let nextColIndex = 0;

		for (const cellMatch of rowBody.matchAll(cellRegex)) {
			const attrs = cellMatch[1] ?? "";
			const cellBody = cellMatch[2] ?? "";
			const cellRef = getXmlAttribute(attrs, "r");
			const explicitCol = columnRefToIndex(cellRef);
			const colIndex = explicitCol !== null ? explicitCol : nextColIndex;
			nextColIndex = colIndex + 1;

			const cellType = getXmlAttribute(attrs, "t") ?? "";
			const vMatch = vRegex.exec(cellBody);
			const rawValue = vMatch ? (vMatch[1] ?? "").trim() : "";

			let resolvedValue = "";
			if (cellType === "s") {
				const ssIndex = Number.parseInt(rawValue, 10);
				if (Number.isFinite(ssIndex) && ssIndex >= 0) {
					resolvedValue = sharedStrings[ssIndex] ?? "";
				}
			} else if (cellType === "inlineStr") {
				const isMatch = isRegex.exec(cellBody);
				const sourceXml = isMatch ? (isMatch[1] ?? "") : cellBody;
				const parts: string[] = [];
				for (const tMatch of sourceXml.matchAll(tRegex)) {
					parts.push(decodeXmlEntities(tMatch[1] ?? ""));
				}
				resolvedValue = parts.join("");
			} else if (cellType === "b") {
				resolvedValue =
					rawValue === "1" || rawValue.toLowerCase() === "true" ? "TRUE" : "FALSE";
			} else if (vMatch) {
				resolvedValue = decodeXmlEntities(rawValue);
			} else {
				const isMatch = isRegex.exec(cellBody);
				if (isMatch) {
					const parts: string[] = [];
					for (const tMatch of (isMatch[1] ?? "").matchAll(tRegex)) {
						parts.push(decodeXmlEntities(tMatch[1] ?? ""));
					}
					resolvedValue = parts.join("");
				}
			}

			const trimmed = resolvedValue.trim();
			if (trimmed.length > 0) {
				cellMap.set(colIndex, trimmed);
				if (colIndex > maxColIndex) {
					maxColIndex = colIndex;
				}
			}
		}

		if (cellMap.size > 0) {
			sparseRows.push(cellMap);
		}
	}

	if (sparseRows.length === 0 || maxColIndex < 0) {
		return [];
	}

	const totalCols = maxColIndex + 1;
	return sparseRows.map((cellMap) => {
		const row: string[] = [];
		for (let col = 0; col < totalCols; col++) {
			row.push(cellMap.get(col) ?? "");
		}
		return row;
	});
}

function sheetRegexMatches(text: string, regex: RegExp): IterableIterator<RegExpMatchArray> {
	return text.matchAll(regex);
}

async function extractXlsxText(
	entries: Map<string, ZipEntryMeta>,
	decoder: TextDecoder,
): Promise<string> {
	const sharedStringsXml = await readZipEntryText(entries, "xl/sharedStrings.xml", decoder);
	const sharedStrings = parseSharedStrings(sharedStringsXml);

	const workbookXml = await readZipEntryText(entries, "xl/workbook.xml", decoder);
	const relsXml = await readZipEntryText(entries, "xl/_rels/workbook.xml.rels", decoder);
	const sheets = resolveWorkbookSheets(workbookXml, relsXml, entries);

	if (sheets.length === 0) {
		throw new Error("Invalid .xlsx archive: no worksheet entries found.");
	}

	const sections: string[] = [];
	for (const sheet of sheets) {
		const sheetXml = await readZipEntryText(entries, sheet.entryPath, decoder);
		if (!sheetXml) continue;
		const rows = extractWorksheetRows(sheetXml, sharedStrings);
		if (rows.length > 0) {
			sections.push(`## ${sheet.name}\n\n${formatMarkdownTable(rows)}`);
		} else {
			sections.push(`## ${sheet.name}`);
		}
	}

	return sections.join("\n\n");
}

function extractDrawingParagraphs(xml: string): string[] {
	const pRegex = /<a:p(?=\s|>|\/)[^>]*>([\s\S]*?)<\/a:p>/g;
	const tokenRegex =
		/<a:t(?=\s|>)[^>]*>([\s\S]*?)<\/a:t>|<a:tab(?=\s|\/|>)[^>]*\/?>|<a:br(?=\s|\/|>)[^>]*\/?>/g;
	const paragraphs: string[] = [];

	for (const pMatch of xml.matchAll(pRegex)) {
		const pBody = pMatch[1] ?? "";
		const parts: string[] = [];
		for (const tokenMatch of pBody.matchAll(tokenRegex)) {
			const full = tokenMatch[0];
			if (full.startsWith("<a:tab")) {
				parts.push("\t");
			} else if (full.startsWith("<a:t")) {
				parts.push(decodeXmlEntities(tokenMatch[1] ?? ""));
			} else {
				parts.push("\n");
			}
		}
		const text = parts.join("").trim();
		if (text.length > 0) {
			paragraphs.push(text);
		}
	}

	return paragraphs;
}

function extractPptxNotesParagraphs(notesXml: string): string[] {
	const withoutMetadataPlaceholders = notesXml.replace(
		/<p:sp(?=\s|>)[^>]*>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*\btype\s*=\s*(?:"(?:sldNum|sldImg|dt|hdr|ftr)"|'(?:sldNum|sldImg|dt|hdr|ftr)')[\s\S]*?<\/p:sp>/g,
		"",
	);
	return extractDrawingParagraphs(withoutMetadataPlaceholders);
}

async function extractPptxText(
	entries: Map<string, ZipEntryMeta>,
	decoder: TextDecoder,
): Promise<string> {
	const slideEntries: { num: number; entryPath: string }[] = [];
	for (const entryPath of entries.keys()) {
		const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(entryPath);
		if (match) {
			slideEntries.push({
				num: Number.parseInt(match[1], 10),
				entryPath,
			});
		}
	}

	slideEntries.sort((a, b) => a.num - b.num);
	if (slideEntries.length === 0) {
		throw new Error("Invalid .pptx archive: no slide entries found.");
	}

	const sections: string[] = [];
	for (const slide of slideEntries) {
		const slideXml = await readZipEntryText(entries, slide.entryPath, decoder);
		if (!slideXml) continue;

		const slideParagraphs = extractDrawingParagraphs(slideXml);
		const lines: string[] = [`## Slide ${slide.num}`];
		if (slideParagraphs.length > 0) {
			lines.push(slideParagraphs.join("\n"));
		}

		const notesPath = `ppt/notesSlides/notesSlide${slide.num}.xml`;
		const notesXml = await readZipEntryText(entries, notesPath, decoder);
		if (notesXml) {
			const notesParagraphs = extractPptxNotesParagraphs(notesXml);
			if (notesParagraphs.length > 0) {
				lines.push(`### Notes\n${notesParagraphs.join("\n")}`);
			}
		}

		sections.push(lines.join("\n\n"));
	}

	return sections.join("\n\n");
}

/**
 * Extract clean Markdown text from an Office Open XML (.docx, .xlsx, .pptx) buffer
 * using Web-standard DecompressionStream("deflate-raw") and TextDecoder.
 */
export async function extractOfficeOpenXmlText(
	bytes: Uint8Array,
	kind: OfficeOpenXmlKind,
): Promise<string> {
	const entries = parseZipArchive(bytes);
	const decoder = new TextDecoder("utf-8");

	switch (kind) {
		case "docx":
			return extractDocxText(entries, decoder);
		case "xlsx":
			return extractXlsxText(entries, decoder);
		case "pptx":
			return extractPptxText(entries, decoder);
	}
}
