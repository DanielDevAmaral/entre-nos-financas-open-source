import { spawnSync } from "node:child_process";
import path from "node:path";
const target = path.resolve("../entre-nos-codigo.tar.gz");
const paths = [
  "app",
  "src",
  "db",
  "public",
  "api",
  "tools",
  "scripts",
  "tests",
  "tests-js",
  "ios",
  "ios-shell",
  "capacitor.config.ts",
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "next.config.ts",
  "next-env.d.ts",
  "tsconfig.json",
  "eslint.config.mjs",
  ".gitignore",
  ".env.example",
  "vercel.json",
  "INICIAR.cmd",
  "README.md",
  "docs",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
];
const result = spawnSync(
  "tar",
  [
    "-czf",
    target,
    "--exclude=__pycache__",
    "--exclude=*.pyc",
    "--exclude=Pods",
    "--exclude=DerivedData",
    ...paths,
  ],
  { stdio: "inherit", windowsHide: true },
);
if (result.status !== 0)
  throw new Error("Não foi possível empacotar o código.");
console.log(
  "Pacote de código sem banco, extratos, credenciais, capturas ou pasta work: " +
    target,
);
