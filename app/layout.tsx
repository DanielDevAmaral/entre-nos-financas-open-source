import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./family.css";
export const metadata: Metadata = {
  title: "Entre Nós · Finanças da família",
  description: "Nosso planejamento, nossas contas e nossos planos.",
  applicationName: "Entre Nós",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Entre Nós" },
  icons: {
    icon: [
      { url: "/icons/icon-192-v3.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon-v3.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#181a18" },
  ],
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
