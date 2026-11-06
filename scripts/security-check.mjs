import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
// This harness must never use a production database or external credentials.
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
env.FINANCE_TEST_MODE = "1";
const virtualPython = path.resolve(
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python",
);
const pythonCommand = existsSync(virtualPython)
  ? virtualPython
  : process.env.FINANCE_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
env.FINANCE_PYTHON = pythonCommand;
for (const key of [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "APP_ORIGIN",
  "BANK_CONNECTIONS_KEY",
  "PARSER_TOKEN",
  "SETUP_TOKEN",
  "CRON_SECRET",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "AI_PROVIDER",
  "VERCEL",
])
  delete env[key];
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Execute com npm run security:check.");
for (const script of [
  "lint",
  "check:public",
  "typecheck",
  "test",
  "build",
  "check:artifacts",
  "test:http",
]) {
  const result = spawnSync(process.execPath, [npm, "run", script], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const python = spawnSync(
  pythonCommand,
  ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
  { env, stdio: "inherit", windowsHide: true },
);
if (python.status !== 0) process.exit(python.status ?? 1);
const audit = spawnSync(
  process.execPath,
  [npm, "audit", "--audit-level=moderate"],
  { env, stdio: "inherit", windowsHide: true },
);
process.exit(audit.status ?? 1);
