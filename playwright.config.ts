import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.test.ts",
  use: {
    // viewer.html is opened as a local file, no server needed
    baseURL: undefined,
    // Chromium only (lightweight)
    browserName: "chromium",
  },
  // Generate test fixtures before running viewer tests
  globalSetup: "./test/global-setup.ts",
});
