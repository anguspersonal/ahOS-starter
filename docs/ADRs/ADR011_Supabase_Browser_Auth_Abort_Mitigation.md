# ADR-011: Supabase Browser Auth Abort Mitigation

**Status:** Accepted  
**Date:** 2026-02-16  
**Accepted-on-dev:** 2026-02-16  
**Deciders:** Web Platform Team  
**Tags:** auth, supabase, oauth, web, reliability

## Context

Production web auth (`packages/web`, Vercel domain `https://kms.example.com`) intermittently failed after Google OAuth redirect.

Observed behavior in production browser profiles:

- OAuth provider redirect completed and returned tokens in URL hash on `/login`.
- `supabase.auth.getSession()` and `supabase.auth.setSession()` failed with:
  - `signal is aborted without reason`
- Users stayed on `/login` without session recovery.
- Incognito frequently worked, indicating browser-profile/runtime contention rather than credential configuration.

This issue did not consistently reproduce locally.

## Decision

We accepted a reliability-focused mitigation in the web client:

1. Configure Supabase browser auth with a custom in-process lock:
   - File: `packages/web/utils/supabase.ts`
   - Setting: `auth.lock = noOpAuthLock`
   - Purpose: avoid browser Web Locks-related abort behavior seen in production OAuth/session flows.

2. Harden auth bootstrap:
   - File: `packages/web/contexts/AuthContext.tsx`
   - Behavior: initial `getSession()` abort/error must not prevent `onAuthStateChange` subscription setup.

3. Harden hash-based session recovery on login:
   - File: `packages/web/app/login/page.tsx`
   - Behavior:
     - parse hash tokens on `/login`
     - attempt `setSession()`
     - on abort: retry once, then fallback `getSession()`
     - redirect immediately when user/session becomes available
     - clear hash tokens from URL after successful recovery

4. Keep server cookie synchronization:
   - Endpoint: `POST /api/auth/sync-session`
   - Purpose: ensure Next.js server routes can authenticate user context using synced session cookies.

## Consequences

### Positive

- OAuth/login reliability improved in production browser profiles.
- Removed repeated abort failure loop during hash session recovery.
- Server routes remain auth-aware through session cookie sync.

### Negative

- We are intentionally bypassing Supabase's default browser lock strategy in the web client.
- Future Supabase/browser changes may require revisiting this workaround.

## Alternatives Considered

1. Rely only on default Supabase lock behavior.
   - Rejected due to repeated production aborts.

2. Immediate migration to server-only code flow callback for all OAuth cases.
   - Deferred. Current mitigation restored reliability with lower migration risk and less disruption.

## Operational Guidance

If auth abort symptoms return:

1. Verify `packages/web/utils/supabase.ts` still sets `auth.lock` to `noOpAuthLock`.
2. Verify hash recovery hardening still exists in `packages/web/app/login/page.tsx`.
3. Verify auth bootstrap still subscribes even when initial `getSession()` fails.
4. Collect debug logs with `?authDebug=1` and preserve browser network logs.
5. Redact or revoke leaked tokens if logs include OAuth hash values.

