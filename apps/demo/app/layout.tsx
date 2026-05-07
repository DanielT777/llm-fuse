import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "llm-fuse — VFS for LLM agents",
  description:
    "Mount any API as a virtual filesystem an LLM can navigate with ls/cat/invoke",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
