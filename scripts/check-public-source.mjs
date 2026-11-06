import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Inspect tracked files only. Do not enumerate or upload local private data.
const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  windowsHide: true,
})
  .split("\0")
  .filter(Boolean);
const problems = [];
for (const file of files) {
  if (
    /^(?:data|private|work|node_modules|\.next|\.vercel|coverage)\//i.test(
      file,
    ) ||
    (/(?:^|\/)\.env(?:\.|$)/i.test(file) && file !== ".env.example") ||
    /\.(?:pdf|xlsx?|ofx|csv|sqlite\d*|db|dump|bak|enc|pem|p12|pfx|key|log|tgz|zip|tar|gz)$/i.test(
      file,
    )
  ) {
    problems.push(file + ": arquivo privado ou gerado não permitido");
    continue;
  }
  const bytes = await readFile(file);
  if (bytes.includes(0)) {
    if (
      !/^(?:public\/icons\/|ios\/App\/App\/Assets\.xcassets\/)/.test(file) ||
      !/\.png$/i.test(file)
    )
      problems.push(file + ": binário não revisado");
    continue;
  }
  const text = bytes.toString("utf8");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\b(?:gsk_|ghp_|github_pat_)[A-Za-z0-9_]{30,}/.test(text)
  )
    problems.push(file + ": possível segredo");
  const connections = text.match(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi) ?? [];
  if (
    connections.some(
      (value) =>
        value.includes("@") &&
        !/USUARIO:SENHA@HOST|example:fake@db\.example|u:p@(?:db|localhost|127\.0\.0\.1)|user:pass@(?:db|localhost|127\.0\.0\.1)/.test(
          value,
        ),
    )
  )
    problems.push(file + ": string de conexão fora dos exemplos permitidos");
}
for (const file of files.filter((f) => /\.md$/.test(f))) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const local = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), target),
    );
    if (!files.includes(local))
      problems.push(file + ": link local ausente: " + local);
  }
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(
  `Código público: ${files.length} arquivos versionados verificados; sem arquivos privados proibidos, segredos reconhecidos ou links locais quebrados. A verificação não substitui revisão humana e Gitleaks.`,
);
