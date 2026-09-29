"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeSwitcher } from "./theme";
import { Logo } from "./app-ui";

const LINKS = [
  { href: "/product", label: "Product" },
  { href: "/developers", label: "Developers" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" }
];

const FOOTER = [
  { title: "Product", links: [["/product", "How it works"], ["/pricing", "Pricing"], ["/security", "Security"]] },
  { title: "Developers", links: [["/docs", "Documentation"], ["/docs/quickstart", "Quickstart"], ["/docs/webhooks", "Webhooks"], ["/docs/payment-intents", "Payment intents"]] },
  { title: "Company", links: [["/login", "Sign in"], ["/signup", "Create account"], ["mailto:hello@setra.dev", "Contact"]] }
] as const;

export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="min-h-screen bg-background">
      <header className={cn("material sticky top-0 z-40 border-b border-transparent transition-colors", scrolled && "border-sidebar-border/70")}>
        <nav className="mx-auto flex h-[52px] max-w-[1200px] items-center gap-8 px-6 max-md:px-4" aria-label="Main">
          <Link href="/" aria-label="Setra home">
            <Logo />
          </Link>
          <div className="flex gap-0.5 max-md:hidden">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={pathname.startsWith(l.href) ? "page" : undefined}
                className="rounded-lg px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:text-foreground aria-[current=page]:text-foreground"
              >
                {l.label}
              </Link>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="max-md:hidden">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/signup">Start your workspace</Link>
            </Button>
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="top" className="material border-b-0 px-4 pt-14 pb-6">
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <SheetDescription className="sr-only">Site navigation</SheetDescription>
                <nav className="grid gap-1" aria-label="Mobile">
                  {[...LINKS, { href: "/login", label: "Sign in" }].map((l) => (
                    <Link key={l.href} href={l.href} className="rounded-xl px-3 py-2.5 text-[1.0625rem] font-medium hover:bg-accent">
                      {l.label}
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </nav>
      </header>
      <main id="main">{children}</main>
      <footer className="mt-10 border-t border-sidebar-border/70 pt-10 pb-12 text-sm">
        <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-8 px-6 max-md:px-4 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="max-lg:col-span-2">
            <Logo />
            <p className="mt-3 max-w-[320px] text-muted-foreground">Accounting and financial operations for businesses on Monad. Your wallets, books and financial reports, together.</p>
            <p className="mt-3 max-w-[320px] text-muted-foreground">Setra is non-custodial software. It never holds funds or keys.</p>
            <ThemeSwitcher className="mt-5" />
          </div>
          {FOOTER.map((col) => (
            <div key={col.title}>
              <h4 className="mb-3 font-semibold">{col.title}</h4>
              <ul className="grid gap-2">
                {col.links.map(([href, label]) => (
                  <li key={href}>
                    {href.startsWith("mailto:") ? (
                      <a href={href} className="text-muted-foreground hover:text-foreground">
                        {label}
                      </a>
                    ) : (
                      <Link href={href} className="text-muted-foreground hover:text-foreground">
                        {label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}
