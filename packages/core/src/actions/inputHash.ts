/**
 * Canonical JSON serialization and input SHA-256 hashing (ADR-104 L6).
 *
 * Implements pure isomorphic canonicalization matching JSON.stringify semantics:
 * - toJSON applied where defined
 * - undefined, functions, and symbols omitted from objects and serialized as null in arrays
 * - Object keys sorted lexicographically at every depth
 * - Throws TypeError on BigInt or circular structures (cycles)
 *
 * Uses globalThis.crypto.subtle.digest ("SHA-256") without any node:crypto dependency.
 */

function canonicalJsonInternal(val: unknown, seen: Set<object>): string | undefined {
	if (val !== null && typeof val === "object" && typeof (val as any).toJSON === "function") {
		val = (val as any).toJSON();
	}
	if (val === null) return "null";
	if (typeof val === "boolean") return val ? "true" : "false";
	if (typeof val === "number") return Number.isFinite(val) ? String(val) : "null";
	if (typeof val === "string") return JSON.stringify(val);
	if (typeof val === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
	if (typeof val === "undefined" || typeof val === "function" || typeof val === "symbol") {
		return undefined;
	}
	if (Array.isArray(val)) {
		if (seen.has(val)) throw new TypeError("Converting circular structure to JSON");
		seen.add(val);
		const elements = val.map((item) => {
			const s = canonicalJsonInternal(item, seen);
			return s === undefined ? "null" : s;
		});
		seen.delete(val);
		return "[" + elements.join(",") + "]";
	}
	if (typeof val === "object") {
		if (seen.has(val)) throw new TypeError("Converting circular structure to JSON");
		seen.add(val);
		const keys = Object.keys(val).sort();
		const entries: string[] = [];
		for (const k of keys) {
			const v = (val as Record<string, unknown>)[k];
			if (v === undefined || typeof v === "function" || typeof v === "symbol") {
				continue;
			}
			const s = canonicalJsonInternal(v, seen);
			if (s !== undefined) {
				entries.push(JSON.stringify(k) + ":" + s);
			}
		}
		seen.delete(val);
		return "{" + entries.join(",") + "}";
	}
	return undefined;
}

/**
 * Returns a canonical, deterministically-keyed JSON string representation of a value.
 */
export function canonicalJson(value: unknown): string {
	const res = canonicalJsonInternal(value, new Set());
	return res === undefined ? "" : res;
}

/**
 * Computes lowercase hex SHA-256 of a string using globalThis.crypto.subtle.
 */
export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes the lowercase hex SHA-256 digest of the canonical JSON representation of a value.
 */
export async function inputSha256(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}
