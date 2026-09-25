import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// T024 higiene RGPD + resiliencia CI: fuentes servidas desde
// public/fonts/ (Cormorant Garamond y DM Sans en OFL, versionadas
// en el repo). El backoffice no hace peticiones a fonts.googleapis.com
// ni a fonts.gstatic.com, y la build no depende de que la red del
// runner alcance Google (CI #53 cayó por esto).
const cormorant = localFont({
  variable: "--font-cormorant",
  display: "swap",
  src: [
    {
      path: "../../public/fonts/cormorant-garamond-500.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../public/fonts/cormorant-garamond-600.woff2",
      weight: "600",
      style: "normal",
    },
  ],
});

const dmSans = localFont({
  variable: "--font-dm-sans",
  display: "swap",
  src: [
    {
      path: "../../public/fonts/dm-sans-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../public/fonts/dm-sans-500.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../public/fonts/dm-sans-600.woff2",
      weight: "600",
      style: "normal",
    },
  ],
});

export const metadata: Metadata = {
  title: "OUTPILOT v2",
  description: "Herramienta interna de Umania Labs.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="es"
      className={`${cormorant.variable} ${dmSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
