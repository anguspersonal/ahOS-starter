/**
 * The worker never writes a NULL `artifacts.surface` (#584; ADR-026, ADR-046 §2/§3).
 *
 * Both worker write paths were found by scripts/check-artifact-surface-writes.js
 * rather than by #584's original report, which listed only the two mcp-server tools.
 * They account for 105 of the 219 null-surface rows a read-only production scan found
 * on 2026-08-22 (102 uploads, 3 derivatives).
 *
 * WHY TOTALITY IS THE PROPERTY UNDER TEST, not the individual mappings. A null surface
 * does not break a read — `resolveTrust` and `resolveSynthesisRole` fall through to
 * `source_channel` and then to a bare default. It makes the row UNADDRESSABLE: ADR-046
 * §3 keys the role ladder on this column, so with no value there is no key an owner's
 * `surface_role_map` entry can ever match. `resolveUploadSurface` is therefore
 * deliberately total where its neighbouring `source_channel` expression is not, and
 * the unknown-platform case is the one that matters most — it is the only branch that
 * could quietly reintroduce the hole.
 */
import { resolveUploadSurface } from '../../../src/workflows/steps/createArtifact';
import { ARTIFACT_SURFACES } from '@ahkms/shared';

describe('resolveUploadSurface (#584)', () => {
  it('maps a browser client to web_app', () => {
    expect(resolveUploadSurface('web')).toBe(ARTIFACT_SURFACES.webApp);
  });

  it('maps both mobile platforms to mobile_app', () => {
    expect(resolveUploadSurface('ios')).toBe(ARTIFACT_SURFACES.mobileApp);
    expect(resolveUploadSurface('android')).toBe(ARTIFACT_SURFACES.mobileApp);
  });

  it('maps the worker itself to api', () => {
    expect(resolveUploadSurface('worker')).toBe(ARTIFACT_SURFACES.api);
  });

  it('is TOTAL: unknown, absent and empty platforms all land on the api floor', () => {
    // The neighbouring `source_channel` expression leaves this case null, and that is
    // fine there — a null channel costs one fallback rung. A null surface costs the
    // row its only addressable identity, so this branch may never return null.
    for (const platform of [undefined, null, '', 'desktop', 'watchOS', 'WEB'] as const) {
      expect(resolveUploadSurface(platform)).toBe(ARTIFACT_SURFACES.api);
    }
  });

  it('never returns null or undefined for any input', () => {
    for (const platform of [undefined, null, '', 'web', 'ios', 'android', 'worker', 'wat']) {
      const surface = resolveUploadSurface(platform);
      expect(surface).toBeTruthy();
      expect(typeof surface).toBe('string');
    }
  });
});
