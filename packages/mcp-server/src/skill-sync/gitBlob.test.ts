import { describe, expect, it } from "vitest";
import { gitBlobHash } from "./gitBlob.js";

describe("gitBlobHash", () => {
	it("matches `git hash-object` for a known string", () => {
		// printf 'hello\n' | git hash-object --stdin
		expect(gitBlobHash("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
	});

	it("matches git's canonical empty-blob hash", () => {
		expect(gitBlobHash("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});

	it("is content-addressed and stable", () => {
		expect(gitBlobHash("a")).toBe(gitBlobHash("a"));
		expect(gitBlobHash("a")).not.toBe(gitBlobHash("b"));
	});
});
