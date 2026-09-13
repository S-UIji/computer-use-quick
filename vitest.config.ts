import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/fixtures/global.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 集成测试共享同一个浏览器，并行会互相踩
    fileParallelism: false
  }
});
