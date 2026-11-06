import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Entre Nós · Finanças da família",
    short_name: "Entre Nós",
    description: "Nosso mês, nossas contas e nossos planos.",
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    background_color: "#f7f4ef",
    theme_color: "#c5ab8b",
    lang: "pt-BR",
    icons: [
      {
        src: "/icons/icon-192-v3.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512-v3.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
