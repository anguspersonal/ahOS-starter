/**
 * Single overview metric cell returned by RevenueCat v2 overview metrics endpoint.
 */
export type RevenueCatMetric = {
	id: string;
	name: string;
	value: number | null;
};

/**
 * The three ratified scorecard metrics extracted from RevenueCat v2 overview metrics.
 */
export type RevenueCatMetrics = {
	activeSubscriptions: RevenueCatMetric | null;
	activeTrials: RevenueCatMetric | null;
	mrr: RevenueCatMetric | null;
};

/**
 * Abstract port for reading ratified RevenueCat project overview metrics (ADR-101, #1536).
 */
export interface RevenueCatPort {
	getMetrics(projectId: string): Promise<RevenueCatMetrics>;
}
