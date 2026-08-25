import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./editorial.css";

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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
        />
        <link rel="stylesheet" href="../assets/css/radar-foundation.css?v=20260825-da-v1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
