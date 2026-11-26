// The one fact the dedup-claim lifecycle in links.ts cannot work out for itself: whether
// a throw from an outward create happened before or after the provider created the item.
// A leaf module on purpose — the outward clients (notion.ts, google/calendar.ts) raise it
// and links.ts reads it, so neither has to depend on the other.

/**
 * Thrown when an outward create was **accepted** by the provider — a success status came
 * back — but its response could not be read: a socket reset mid-body, a truncated payload,
 * a non-JSON body from something in front of the API. The external item exists; only its
 * identity was lost.
 *
 * This is the single failure the claim lifecycle must NOT read as "nothing was created"
 * (issue #653). `releaseClaimForFailedWrite` releases a dedup claim on the evidence that
 * the outward write threw; that evidence is sound for every other throw on the write path,
 * and wrong for this one. Releasing here would free the slot for an item that really is
 * out there, and the next retry would create a second — turning a stuck slot into a silent
 * double-create, which is a worse failure than the one #653 fixed. So the claim is kept,
 * the row stays pending, and the next create refuses loudly with `interruptedClaimMessage`
 * and its remedy.
 *
 * Deliberately narrow. A genuinely **ambiguous** failure — request sent, no response at
 * all — is not this, and must not be raised as this: it stays on the default "no item
 * created" path. Nothing on the client side can resolve that ambiguity; closing it needs a
 * read of the system of record (issue #734). This error covers only the case where the
 * provider already said yes.
 */
export class ExternalItemCreatedButUnreadable extends Error {
	constructor(what: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`${what} was created, but its response could not be read: ${detail}`, {
			cause,
		});
		this.name = "ExternalItemCreatedButUnreadable";
	}
}

/**
 * Does this error prove the external item exists? Only `ExternalItemCreatedButUnreadable`
 * does. Everything else — including every ambiguous network failure — answers `false`,
 * which is the pre-existing assumption and keeps the default behaviour unchanged.
 */
export function externalItemWasCreated(error: unknown): boolean {
	return error instanceof ExternalItemCreatedButUnreadable;
}
