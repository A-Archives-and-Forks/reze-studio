import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import { Analytics } from "@vercel/analytics/next"
import { CrashLogCapture } from "@/components/crash-log-capture"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Reze Studio",
  description: "Web-based MMD animation curve editor",
  keywords: ["MMD", "animation", "curve editor", "WebGPU", "Reze Engine"],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark select-none">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased outline-none`}>
        {/* Capture starts here so a crash report carries what led up to it. */}
        <CrashLogCapture />
        {children}
        <Analytics />
      </body>
    </html>
  )
}
