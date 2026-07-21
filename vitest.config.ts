import { defineConfig } from "vitest/config";

// crx({ manifest }) を使うvite.config.tsとは別に、テスト専用のvite設定を持つ。
// @crxjs/vite-pluginはマニフェスト/複数エントリポイントのビルド処理を行うため、
// テスト実行時には不要かつ干渉しうる。
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
