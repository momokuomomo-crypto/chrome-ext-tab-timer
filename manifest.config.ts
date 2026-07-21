import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "会議終了タブ・タイマー",
  description: "タブに時限タイマーを設定し、時間になったら通知します。",
  version: pkg.version,
  permissions: ["alarms", "notifications", "storage", "contextMenus", "tabs"],
  icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  action: {
    default_popup: "src/popup/index.html",
    default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  },
  background: { service_worker: "src/background/index.ts", type: "module" },
});
