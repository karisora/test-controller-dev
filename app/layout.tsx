import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pico Stepper Console | USBモーターテスト",
  description: "Raspberry Pi PicoへWeb Serialで接続し、2台のステップモーターをブラウザからテストします。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
