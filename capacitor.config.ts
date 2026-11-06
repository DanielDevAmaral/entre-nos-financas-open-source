import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "app.entrenos.financas",
  appName: "Entre Nós",
  webDir: "ios-shell",
  ios: { contentInset: "automatic" },
  server: { allowNavigation: [] },
};
export default config;
