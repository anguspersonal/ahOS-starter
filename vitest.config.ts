// -- ALLOW-ARCH-DRIFT: root vitest config and check:packet-allowlist npm script only (non-structural)
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		exclude: [
			...configDefaults.exclude,
			"**/.claude/worktrees/**",
			"**/node_modules/**",
			"**/dist/**",
		],
		env: {
			SUPABASE_URL: "http://localhost:54321",
			SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
			KMS_USER_ID: "00000000-0000-0000-0000-000000000000",
			NOTION_WORK_ACCESS_TOKEN: "secret_test_token",
			NOTION_API_KEY: "secret_test_token",
			NOTION_PERSONAL_ACCESS_TOKEN: "secret_personal_test_token",
		},
	},
});
