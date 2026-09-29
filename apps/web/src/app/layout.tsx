import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { MotionProvider } from "@/components/motion";
import { ThemeProvider } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face", display: "swap", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: { default: "Setra · Get paid in stablecoins. Your books are already done.", template: "%s · Setra" },
  description: "Stablecoin payments and bookkeeping on Monad. The moment a payment is final, Setra matches it to its invoice and updates your books, with every number traceable to the chain.",
  applicationName: "Setra",
  icons: { icon: "/favicon.svg" }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" }
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <a href="#main" className="fixed top-[-40px] left-3 z-[100] rounded-lg bg-foreground px-3 py-2 text-background focus:top-3">
          Skip to content
        </a>
        <ThemeProvider>
          <MotionProvider>
            <TooltipProvider delayDuration={300}>
              {children}
              <Toaster position="bottom-right" richColors={false} closeButton={false} />
            </TooltipProvider>
          </MotionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
