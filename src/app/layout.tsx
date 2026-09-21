import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "600", "700"],
});

export const metadata: Metadata = {
  title: "بيناري — Binary Agent",
  description: "لوحة الوكيل الذكي المستقل — الحالة والمزودات والأهداف والذاكرة",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className="dark">
      <body className={`${cairo.variable} font-sans antialiased bg-zinc-950 text-zinc-100`}>
        {children}
      </body>
    </html>
  );
}
