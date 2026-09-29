import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Crypto Tax Engine",
  description: "해외 거래소·DeFi 이용자를 위한 가상자산 과세 준비 도구",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="no-print border-b border-stone-200 dark:border-stone-800">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold">
              Crypto Tax Engine
            </Link>
            <Link href="/" className="text-stone-500 hover:text-foreground">
              스냅샷
            </Link>
            <Link href="/ledger" className="text-stone-500 hover:text-foreground">
              원장
            </Link>
            <Link href="/review" className="text-stone-500 hover:text-foreground">
              분류 검토
            </Link>
            <Link href="/sources" className="text-stone-500 hover:text-foreground">
              연결 계정
            </Link>
            <span className="ml-auto text-xs text-stone-400">
              데이터는 이 브라우저에만 저장됩니다
            </span>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
