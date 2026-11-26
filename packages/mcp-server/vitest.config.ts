import os from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.{test,spec}.ts"],
		// Bound our share of the cores on multi-core workstations so the repo-wide
		// parallel run does not oversubscribe (#513), while ensuring at least 2
		// workers on 2-vCPU GitHub Actions runners so 296 test files do not
		// serialize on a single worker and exceed the CI job timeout.
		minWorkers: 1,
		maxWorkers: Math.max(2, Math.floor(os.availableParallelism() * 0.5)),
		// The env modules (src/env.ts) throw at import time if these are unset; provide
		// harmless test values so unit tests can import the modules under test. No real
		// network calls are made — fetch and the supabase client are stubbed per test.
		env: {
			SUPABASE_URL: "http://localhost:54321",
			SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
			KMS_USER_ID: "00000000-0000-0000-0000-000000000000",
			// Primary var — exercises the resolution order's first branch. NOTION_API_KEY
			// is also stubbed so any test relying on the legacy fallback name keeps working.
			NOTION_WORK_ACCESS_TOKEN: "secret_test_token",
			NOTION_API_KEY: "secret_test_token",
			// Personal-workspace token: create_task / get_notion_tasks_schema now select it
			// via getCredential('notion_personal') when workspace='notion_personal' (#424
			// defect 1), so the personal-path tests need it set. env.test.ts and
			// credentials.test.ts delete it to assert the unset behaviour.
			NOTION_PERSONAL_ACCESS_TOKEN: "secret_personal_test_token",
		},
	},
});
