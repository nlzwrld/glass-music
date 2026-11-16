import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/e2e', timeout: 90000, workers: 1, reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]], use: { actionTimeout: 15000, trace: 'retain-on-failure' } });
