/**
 * Shared retry utility with exponential backoff
 * 
 * Provides a consistent retry mechanism across the codebase to reduce duplication.
 * 
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => someAsyncOperation(),
 *   3, // max attempts
 *   [2000, 4000, 8000] // delays in ms
 * );
 * ```
 */

import logger from './logger';

export interface RetryOptions {
	maxAttempts?: number;
	delays?: number[];
	onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAYS = [2000, 4000, 8000]; // Exponential backoff: 2s, 4s, 8s

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 * 
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns Promise with the result of the function
 * @throws Error if all retries fail (throws the last error encountered)
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const delays = options.delays ?? DEFAULT_DELAYS;
	const onRetry = options.onRetry;

	let lastError: Error | null = null;
	let attempt = 0;

	while (attempt < maxAttempts) {
		attempt++;

		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));

			if (onRetry) {
				onRetry(attempt, lastError);
			}

			// If not the last attempt, wait before retrying
			if (attempt < maxAttempts) {
				const delay = delays[attempt - 1] || delays[delays.length - 1];
				logger.info(`Retry attempt ${attempt}/${maxAttempts} failed, retrying in ${delay / 1000}s...`, {
					error: lastError.message,
				});
				await sleep(delay);
			}
		}
	}

	// All retries failed
	throw lastError || new Error('Retry failed with unknown error');
}
