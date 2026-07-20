import type { Metadata, Viewport } from "next";
import { Geist_Mono, Noto_Sans_JP } from "next/font/google";
import "./globals.css";

const sans = Noto_Sans_JP({ subsets: ["latin"], variable: "--font-noto-sans-jp" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Pico Stepper Console | USBモーターテスト",
  description: "Raspberry Pi PicoへWeb Serialで接続し、2台のステップモーターをブラウザから安全にテストします。",
};

export const viewport: Viewport = {
  themeColor: "#f4f2ea",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" className={`bg-background ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
