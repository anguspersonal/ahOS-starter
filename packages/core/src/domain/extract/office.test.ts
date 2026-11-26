import { describe, expect, it } from "vitest";
import {
	decodeXmlEntities,
	detectOfficeOpenXmlKind,
	extractOfficeOpenXmlText,
	OFFICE_OPEN_XML_MIMES,
} from "./office.js";

async function deflateRawBytes(input: Uint8Array): Promise<Uint8Array> {
	const copy = new Uint8Array(input.byteLength);
	copy.set(input);
	const stream = new ReadableStream<BufferSource>({
		start(controller) {
			controller.enqueue(copy);
			controller.close();
		},
	}).pipeThrough(new CompressionStream("deflate-raw"));

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			total += value.byteLength;
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function buildZipBuffer(
	entries: { name: string; content: string; compress?: boolean }[],
	options: { includeCentralDirectory?: boolean } = {},
): Promise<Uint8Array> {
	const includeCentralDirectory = options.includeCentralDirectory ?? true;
	const encoder = new TextEncoder();
	const localChunks: Uint8Array[] = [];
	const centralChunks: Uint8Array[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const rawBytes = encoder.encode(entry.content);
		const useDeflate = entry.compress ?? true;
		const dataBytes = useDeflate ? await deflateRawBytes(rawBytes) : rawBytes;
		const method = useDeflate ? 8 : 0;

		const localHeader = new Uint8Array(30 + nameBytes.byteLength + dataBytes.byteLength);
		const localView = new DataView(localHeader.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, 0, true);
		localView.setUint16(8, method, true);
		localView.setUint32(10, 0, true);
		localView.setUint32(14, 0, true);
		localView.setUint32(18, dataBytes.byteLength, true);
		localView.setUint32(22, rawBytes.byteLength, true);
		localView.setUint16(26, nameBytes.byteLength, true);
		localView.setUint16(28, 0, true);
		localHeader.set(nameBytes, 30);
		localHeader.set(dataBytes, 30 + nameBytes.byteLength);
		localChunks.push(localHeader);

		if (includeCentralDirectory) {
			const cdHeader = new Uint8Array(46 + nameBytes.byteLength);
			const cdView = new DataView(cdHeader.buffer);
			cdView.setUint32(0, 0x02014b50, true);
			cdView.setUint16(4, 20, true);
			cdView.setUint16(6, 20, true);
			cdView.setUint16(8, 0, true);
			cdView.setUint16(10, method, true);
			cdView.setUint32(12, 0, true);
			cdView.setUint32(16, 0, true);
			cdView.setUint32(20, dataBytes.byteLength, true);
			cdView.setUint32(24, rawBytes.byteLength, true);
			cdView.setUint16(28, nameBytes.byteLength, true);
			cdView.setUint16(30, 0, true);
			cdView.setUint16(32, 0, true);
			cdView.setUint16(34, 0, true);
			cdView.setUint16(36, 0, true);
			cdView.setUint32(38, 0, true);
			cdView.setUint32(42, localOffset, true);
			cdHeader.set(nameBytes, 46);
			centralChunks.push(cdHeader);
		}

		localOffset += localHeader.byteLength;
	}

	if (!includeCentralDirectory) {
		const out = new Uint8Array(localOffset);
		let offset = 0;
		for (const chunk of localChunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}

	const cdSize = centralChunks.reduce((sum, c) => sum + c.byteLength, 0);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(4, 0, true);
	eocdView.setUint16(6, 0, true);
	eocdView.setUint16(8, entries.length, true);
	eocdView.setUint16(10, entries.length, true);
	eocdView.setUint32(12, cdSize, true);
	eocdView.setUint32(16, localOffset, true);
	eocdView.setUint16(20, 0, true);

	const totalSize = localOffset + cdSize + eocd.byteLength;
	const out = new Uint8Array(totalSize);
	let offset = 0;
	for (const chunk of localChunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	for (const chunk of centralChunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	out.set(eocd, offset);
	return out;
}

describe("Office Open XML text extraction (#2084)", () => {
	it("detectOfficeOpenXmlKind matches MIME types and file extensions", () => {
		expect(detectOfficeOpenXmlKind(OFFICE_OPEN_XML_MIMES.docx)).toBe("docx");
		expect(detectOfficeOpenXmlKind(`${OFFICE_OPEN_XML_MIMES.xlsx}; charset=binary`)).toBe("xlsx");
		expect(detectOfficeOpenXmlKind(OFFICE_OPEN_XML_MIMES.pptx.toUpperCase())).toBe("pptx");

		expect(detectOfficeOpenXmlKind("application/octet-stream", "/path/to/report.DOCX")).toBe(
			"docx",
		);
		expect(detectOfficeOpenXmlKind(null, "financials.xlsx")).toBe("xlsx");
		expect(detectOfficeOpenXmlKind(undefined, "deck.pptx?version=1")).toBe("pptx");

		expect(detectOfficeOpenXmlKind("application/pdf", "file.pdf")).toBeNull();
		expect(detectOfficeOpenXmlKind("application/msword", "legacy.doc")).toBeNull();
		expect(detectOfficeOpenXmlKind("text/plain", "notes.txt")).toBeNull();
	});

	it("decodeXmlEntities decodes named and numeric entities without double-unescaping", () => {
		expect(decodeXmlEntities("A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;")).toBe(
			`A & B < C > D "E" 'F'`,
		);
		expect(decodeXmlEntities("&amp;lt; &#65; &#x42;")).toBe("&lt; A B");
	});

	it("extracts paragraphs, tabs, line breaks, and tables from .docx", async () => {
		const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Quarterly &amp; Annual Review</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Key</w:t><w:tab/><w:t>Value</w:t><w:br/><w:t>Second line</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Result</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>$120k</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

		const bytes = await buildZipBuffer([
			{ name: "word/document.xml", content: documentXml, compress: true },
		]);
		const extracted = await extractOfficeOpenXmlText(bytes, "docx");

		expect(extracted).toContain("Quarterly & Annual Review");
		expect(extracted).toContain("Key\tValue\nSecond line");
		expect(extracted).toContain("| Metric | Result |\n| --- | --- |\n| Revenue | $120k |");
	});

	it("extracts sheets, shared strings, inline strings, booleans, and sparse cells from .xlsx", async () => {
		const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Details" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

		const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>`;

		const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Item</t></si>
  <si><t>Status</t></si>
  <si><t>Count</t></si>
  <si><r><t>Alpha </t></r><r><t>&amp; Beta</t></r></si>
</sst>`;

		const sheet1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c>
      <c r="B2" t="b"><v>1</v></c>
      <c r="C2"><v>42</v></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>SparseRow</t></is></c>
      <c r="C3"><v>99</v></c>
    </row>
  </sheetData>
</worksheet>`;

		const sheet2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Note</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

		const bytes = await buildZipBuffer(
			[
				{ name: "xl/workbook.xml", content: workbookXml, compress: false },
				{ name: "xl/_rels/workbook.xml.rels", content: relsXml, compress: true },
				{ name: "xl/sharedStrings.xml", content: sharedStringsXml, compress: true },
				{ name: "xl/worksheets/sheet1.xml", content: sheet1Xml, compress: true },
				{ name: "xl/worksheets/sheet2.xml", content: sheet2Xml, compress: false },
			],
			{ includeCentralDirectory: false },
		);

		const extracted = await extractOfficeOpenXmlText(bytes, "xlsx");

		expect(extracted).toContain("## Summary");
		expect(extracted).toContain("| Item | Status | Count |");
		expect(extracted).toContain("| Alpha & Beta | TRUE | 42 |");
		expect(extracted).toContain("| SparseRow |  | 99 |");
		expect(extracted).toContain("## Details");
		expect(extracted).toContain("| Note |");
	});

	it("extracts slides in numeric order and includes non-placeholder speaker notes from .pptx", async () => {
		const slide1Xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Intro Slide</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

		const slide2Xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Second Slide</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

		const slide10Xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Tenth Slide</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

		const notesSlide1Xml = `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>Mention Q3 roadmap milestones.</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`;

		const bytes = await buildZipBuffer([
			{ name: "ppt/slides/slide10.xml", content: slide10Xml },
			{ name: "ppt/slides/slide2.xml", content: slide2Xml },
			{ name: "ppt/slides/slide1.xml", content: slide1Xml },
			{ name: "ppt/notesSlides/notesSlide1.xml", content: notesSlide1Xml },
		]);

		const extracted = await extractOfficeOpenXmlText(bytes, "pptx");
		const idx1 = extracted.indexOf("## Slide 1");
		const idx2 = extracted.indexOf("## Slide 2");
		const idx10 = extracted.indexOf("## Slide 10");

		expect(idx1).toBeGreaterThanOrEqual(0);
		expect(idx2).toBeGreaterThan(idx1);
		expect(idx10).toBeGreaterThan(idx2);
		expect(extracted).toContain("### Notes\nMention Q3 roadmap milestones.");
		expect(extracted).not.toContain("### Notes\nMention Q3 roadmap milestones.\n1");
	});

	it("rejects buffers that are not valid ZIP archives", async () => {
		const invalidBytes = new TextEncoder().encode("not a zip archive at all");
		await expect(extractOfficeOpenXmlText(invalidBytes, "docx")).rejects.toThrow(
			/Invalid Office Open XML archive/,
		);
	});
});
