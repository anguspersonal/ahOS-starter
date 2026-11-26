/**
 * Exception-only alert conditions: config resolution + the crossing/re-arm rule
 * (issue #573).
 *
 * This module is deliberately pure — no Supabase, no email, no clock beyond the
 * values it is handed. It answers exactly one question per condition:
 *
 *     given the measured value, the threshold, and the durable state of this
 *     condition, do we send an email right now?
 *
 * ## Why a durable rule exists at all
 *
 * `utils/alerts.ts` dedupes on a **10-minute in-memory window**. It does not
 * survive a restart and does not span days. An evaluator that simply fired
 * whenever `days_since_ritual >= 6` would therefore email every single day from
 * day 6 onward — turning an exception into a daily digest and reintroducing the
 * decay that got the nightly-nudge form rejected in #493 Q3.
 *
 * So the rule is: **fire on the threshold being CROSSED, never on it being
 * HELD.**
 *
 *   breached && armed    -> fire once, disarm
 *   breached && !armed   -> silent (the condition is merely still true)
 *   !breached && improved-> re-arm (the condition cleared; the next crossing may fire)
 *   !breached && !improved -> stay disarmed (see "a threshold raise is not a clear")
 *
 * "No stored state" means armed, so the very first evaluation of an
 * already-breached condition fires exactly once — which is the 2026-08-04 case:
 * deploy the evaluator into a system that has been silent for a month and you
 * get one email, not thirty.
 *
 * ## A threshold raise is not a clear (#573 review round 1, M1)
 *
 * `breached` is recomputed from the *current* config on every run, and the
 * config is explicitly designed to be edited at runtime (ADR-030). So if
 * `!breached` alone were the re-arm signal, an owner who quietened a live alert
 * by raising its threshold would silently re-arm it: silence at 10 days, fired,
 * threshold moved 6 -> 20, next run sees `10 < 20` -> "cleared" -> re-armed —
 * and day 20 brings a *second* email for one uninterrupted stretch of silence.
 * #573 says re-arm happens "only after the condition clears", and no clearing
 * event ever occurred there.
 *
 * The fix uses the one property every signal here shares: these are all
 * "days since X" measures, so the value can only DECREASE when X actually
 * happened. Re-arming therefore requires both `!breached` and evidence the
 * signal genuinely improved — `value < lastFiredValue`. A threshold raise moves
 * the bar, not the value, so it can no longer manufacture a re-arm; the ritual
 * actually running (value drops to ~0) still re-arms exactly as before.
 */

import type {
  AlertConditionConfig,
  ExceptionAlertsConfig,
  SourceSilentConditionConfig,
} from '@ahkms/shared';

/** Defaults applied when the user's DB config omits a key. */
export const DEFAULT_RITUAL_SILENT: Required<AlertConditionConfig> = {
  enabled: true,
  threshold_days: 6,
};

export const DEFAULT_SOURCE_SILENT: Required<SourceSilentConditionConfig> = {
  enabled: true,
  threshold_days: 7,
  sources: [],
  discovery_window_days: 90,
  min_observations: 3,
};

/** Master switch default. Off at the deploy level too (see `alertEvaluator`). */
export const DEFAULT_ALERTS_ENABLED = true;

export interface ResolvedAlertConfig {
  enabled: boolean;
  ritualSilent: Required<AlertConditionConfig>;
  sourceSilent: Required<SourceSilentConditionConfig>;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return out.map((v) => v.trim());
}

/**
 * Resolve a stored `notification_preferences.exception_alerts` blob (which is
 * untyped JSONB and may be absent, partial, or garbage) into a fully-populated
 * config. Never throws: a malformed value falls back to the default rather than
 * taking the cadence down.
 */
export function resolveAlertConfig(raw: unknown): ResolvedAlertConfig {
  const blob = (raw && typeof raw === 'object' ? raw : {}) as ExceptionAlertsConfig;
  const ritual = (blob.ritual_silent ?? {}) as AlertConditionConfig;
  const source = (blob.source_silent ?? {}) as SourceSilentConditionConfig;
  const sources = stringList(source.sources);

  return {
    enabled: boolean(blob.enabled, DEFAULT_ALERTS_ENABLED),
    ritualSilent: {
      enabled: boolean(ritual.enabled, DEFAULT_RITUAL_SILENT.enabled),
      threshold_days: positiveNumber(ritual.threshold_days, DEFAULT_RITUAL_SILENT.threshold_days),
    },
    sourceSilent: {
      enabled: boolean(source.enabled, DEFAULT_SOURCE_SILENT.enabled),
      threshold_days: positiveNumber(source.threshold_days, DEFAULT_SOURCE_SILENT.threshold_days),
      sources: sources ?? DEFAULT_SOURCE_SILENT.sources,
      discovery_window_days: positiveNumber(
        source.discovery_window_days,
        DEFAULT_SOURCE_SILENT.discovery_window_days,
      ),
      min_observations: positiveNumber(
        source.min_observations,
        DEFAULT_SOURCE_SILENT.min_observations,
      ),
    },
  };
}

/**
 * Durable per-condition state, one row per (user, condition_key) in
 * `alert_condition_state`. `null` means "no row yet", which is treated as armed.
 */
export interface ConditionState {
  armed: boolean;
  lastValue: number | null;
  lastFiredAt: string | null;
  lastFiredValue: number | null;
}

export type AlertOutcome =
  /** Threshold crossed on this run: send the email and disarm. */
  | 'fire'
  /** Still breached, but we already fired for this crossing: stay silent. */
  | 'held'
  /** Not breached and the signal genuinely improved: re-arm. */
  | 'rearm'
  /** Not breached and already armed: nothing to do. */
  | 'clear'
  /**
   * Below the threshold, but only because the threshold moved — the measured
   * value has not improved since we fired. Stays disarmed so a threshold raise
   * cannot produce a second email for one uninterrupted breach (M1).
   */
  | 'suppressed';

export interface AlertDecision {
  outcome: AlertOutcome;
  /** Whether an email should be sent for this evaluation. */
  shouldSend: boolean;
  /** The armed flag to persist after this evaluation. */
  nextArmed: boolean;
  breached: boolean;
}

/**
 * The crossing/re-arm rule. Pure: same inputs, same answer, no clock read.
 *
 * @param value      measured days of silence (null = not measurable, e.g. the
 *                   ritual has never run — see `alertEvaluator` for why that is
 *                   skipped rather than treated as infinitely silent)
 * @param thresholdDays breach at or above this value
 * @param state      durable state, or null when no row exists yet
 */
export function decideAlert(
  value: number | null,
  thresholdDays: number,
  state: ConditionState | null,
): AlertDecision {
  // Unmeasurable conditions never fire and never disturb the armed flag: an
  // absent signal is not evidence of silence, it is absence of evidence.
  if (value === null) {
    const armed = state?.armed ?? true;
    return { outcome: 'clear', shouldSend: false, nextArmed: armed, breached: false };
  }

  const breached = value >= thresholdDays;
  const armed = state?.armed ?? true;

  if (!breached) {
    if (armed) {
      // Nothing was outstanding; nothing to re-arm.
      return { outcome: 'clear', shouldSend: false, nextArmed: true, breached: false };
    }

    // Disarmed and below the threshold. Re-arm only if the SIGNAL improved, not
    // merely because the threshold moved above it — see the module docstring.
    // `lastFiredValue === null` means no fire is on record (legacy row, or state
    // written before this rule existed), so fall back to the old behaviour.
    const lastFiredValue = state?.lastFiredValue ?? null;
    const improved = lastFiredValue === null || value < lastFiredValue;

    return {
      outcome: improved ? 'rearm' : 'suppressed',
      shouldSend: false,
      nextArmed: improved,
      breached: false,
    };
  }

  if (!armed) {
    return { outcome: 'held', shouldSend: false, nextArmed: false, breached: true };
  }

  return { outcome: 'fire', shouldSend: true, nextArmed: false, breached: true };
}

/** Stable key for the ritual-silence condition. */
export const RITUAL_SILENT_KEY = 'ritual_silent';

/**
 * Stable key for "the source_silent watch is watching nothing". A boolean
 * condition expressed as 0/1 against a threshold of 1, so it rides the same
 * crossing/re-arm rule as everything else and cannot become a repeating nag.
 */
export const SOURCE_COVERAGE_KEY = 'source_coverage_degraded';

/**
 * Stable key for "the nightly dos sweep left a day with material unclosed" in
 * one domain (#2270). The value is the number of missed days, breached at 1, so
 * it rides the same crossing rule: one email when days first go missing, silence
 * while they stay missing, re-armed once the count is back to zero.
 */
export function sweepMissedKey(domain: string): string {
  return `sweep_missed:${domain}`;
}

/**
 * Stable key for "the read that tells us whether the sweep closed its days is
 * failing" in one domain (#2270). 0/1 against a threshold of 1, like
 * `SOURCE_COVERAGE_KEY`: a watch that has gone blind must say so rather than
 * report a clean run. This is the November 2026 shape, where the coverage read
 * timed out and the sweep silently could not decide anything.
 */
export function sweepUnreadableKey(domain: string): string {
  return `sweep_unreadable:${domain}`;
}

/** Stable key for one watched ingestion surface. */
export function sourceSilentKey(surface: string): string {
  return `source_silent:${surface}`;
}

/**
 * Whole days between two instants, floored. Used for every "days since"
 * measurement so the evaluator has exactly one definition of a day.
 *
 * Deliberately **elapsed 24-hour periods**, not calendar days: pure millisecond
 * arithmetic, so there is no timezone or DST hazard and no dependence on the
 * host's locale. The trade is a consistent rounding-down — a ritual that ran at
 * 23:00 reads as 5 days on the 6th calendar morning — so an alert can land one
 * run late but never early. Firing early on a threshold the owner set is the
 * worse error for an exception channel, so this is the intended direction; do
 * not "fix" it to calendar days without also revisiting the thresholds.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
