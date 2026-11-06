import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const traces = [];
async function walk(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, item.name);
    if (item.isDirectory()) await walk(filename);
    else if (item.name.endsWith(".nft.json")) traces.push(filename);
  }
}
await walk(path.join(root, ".next/server"));
if (!traces.length)
  throw new Error("Build não encontrado para verificar arquivos privados.");
let checked = 0;
for (const trace of traces) {
  const { files } = JSON.parse(await readFile(trace, "utf8"));
  for (const filename of files) {
    const relative = path
      .relative(root, path.resolve(path.dirname(trace), filename))
      .replaceAll("\\", "/");
    if (relative.startsWith("node_modules/") || relative.startsWith(".next/"))
      continue;
    checked++;
    if (
      /^(data|private|work)\//i.test(relative) ||
      /(^|\/)\.env($|\.)/i.test(relative) ||
      /\.(pdf|xlsx|ofx|enc|sqlite|db)$/i.test(relative)
    )
      throw new Error(
        "Artefato de hospedagem contém um arquivo privado. Publicação recusada.",
      );
  }
}
console.log(
  `Artefatos verificados: ${traces.length} manifestos, ${checked} referências de aplicação; nenhum arquivo privado incluído.`,
);
