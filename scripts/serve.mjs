import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
// Regression servers must never reintroduce production secrets from a local file.
if (process.env.FINANCE_TEST_MODE !== "1")
  for (const envFile of [".env.local", ".env"])
    if (existsSync(envFile)) process.loadEnvFile(envFile);
const mode = process.argv[2] === "dev" ? "dev" : "start";
const port = process.env.PORT || "3210";
if (!/^\d{4,5}$/.test(port)) throw new Error("Porta inválida");
const bundledPython = path.join(
  process.env.USERPROFILE || "",
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
);
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    mode,
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      APP_PORT: port,
      FINANCE_PYTHON:
        process.env.FINANCE_PYTHON ||
        (existsSync(bundledPython) ? bundledPython : "python"),
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
