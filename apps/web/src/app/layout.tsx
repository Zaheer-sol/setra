import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { MotionProvider } from "@/components/motion";
import { ThemeProvider } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// Fonts ship with the app (Latin subsets, SIL Open Font License) so builds never depend on reaching Google Fonts.
const inter = localFont({ src: "../fonts/inter-latin-variable.woff2", weight: "100 900", variable: "--font-inter", display: "swap" });
const mono = localFont({
  src: [
    { path: "../fonts/jetbrains-mono-latin-400.woff2", weight: "400" },
    { path: "../fonts/jetbrains-mono-latin-500.woff2", weight: "500" }
  ],
  variable: "--font-mono-face",
  display: "swap"
});

export const metadata: Metadata = {
  title: { default: "Setra · Get paid in stablecoins. Your books are already done.", template: "%s · Setra" },
  description: "Invoices and bookkeeping for businesses paid in USDC on Monad. About two seconds after a payment lands, Setra matches it to its invoice and posts it to your books.",
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
