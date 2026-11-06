import { mkdir, writeFile } from "node:fs/promises";
const value = process.env.APP_ORIGIN;
let origin = "",
  host = "";
if (value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error("APP_ORIGIN deve conter apenas a origem HTTPS.");
  origin = url.origin;
  host = url.hostname;
}
await mkdir("ios-shell", { recursive: true });
const safe = JSON.stringify(origin).replaceAll("<", "\\u003c");
await writeFile(
  "ios-shell/index.html",
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Entre Nós</title><style>body{font:17px/1.6 -apple-system,sans-serif;background:#f5f7f3;color:#123e35;padding:calc(35px + env(safe-area-inset-top)) 24px}main{max-width:480px;margin:auto}button{font:inherit;background:#123e35;color:white;border:0;border-radius:12px;padding:16px;width:100%}p{color:#5e7167}</style></head><body><main><h1>Entre Nós</h1><p>Seu espaço financeiro compartilhado.</p><p id="notice"></p><button id="open" hidden>Abrir meu espaço</button></main><script>const origin=${safe};if(origin){const button=document.getElementById('open');button.hidden=false;button.onclick=()=>location.assign(origin);}else{document.getElementById('notice').textContent='O endereço privado ainda precisa ser configurado antes da compilação. Este protótipo não contém dados financeiros.'}</script></body></html>`,
);
await writeFile(
  "capacitor.config.ts",
  `import type { CapacitorConfig } from '@capacitor/cli';\nconst config: CapacitorConfig = {appId:'app.entrenos.financas',appName:'Entre Nós',webDir:'ios-shell',ios:{contentInset:'automatic'},server:{allowNavigation:${JSON.stringify(host ? [host] : [])}}};\nexport default config;\n`,
);
console.log(
  origin
    ? "Projeto configurado para o endereço HTTPS informado. Execute cap sync ios."
    : "Protótipo iOS preparado sem endereço remoto e sem dados financeiros.",
);
