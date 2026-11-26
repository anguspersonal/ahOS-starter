import { createHash } from "node:crypto";

// Git blob object hash (#375). The `base_blob` in an x-upstream stamp is a git blob
// sha, so it stays resolvable with `git cat-file`/`git hash-object` against the
// upstream clone. Git hashes a blob as sha1("blob <bytelen>\0<bytes>"), which we can
// compute directly — no need to shell out to git for every skill.
export function gitBlobHash(content: string): string {
	const buf = Buffer.from(content, "utf8");
	return createHash("sha1")
		.update(`blob ${buf.length}\0`)
		.update(buf)
		.digest("hex");
}
