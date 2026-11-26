import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { LocalFileReader } from "@ahkms/core";

export const readLocalFile: LocalFileReader = async (path: string) => {
	const buf = await readFile(path);
	return {
		bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
		name: basename(path),
	};
};
