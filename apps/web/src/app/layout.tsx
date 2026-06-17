import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FunLead Recorder",
  description: "Open-source screen recorder — record, edit and share. Self-hosted.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
