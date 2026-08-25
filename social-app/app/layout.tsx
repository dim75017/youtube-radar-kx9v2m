import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Lofi Radar · Social",
    template: "%s · Lofi Radar",
  },
  description:
    "Radar interne des performances Instagram, X, TikTok et YouTube de Lofi Girl.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#07080d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
