const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['line']],
  outputDir: 'test-results/e2e',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
