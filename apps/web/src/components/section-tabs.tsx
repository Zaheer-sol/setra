"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { motion, SPRING } from "@/components/motion";
import { cn } from "@/lib/utils";

export interface SectionTab {
  href: string;
  label: string;
  /** Match only this exact path (for a section's index page). */
  exact?: boolean;
}

/** Tabs that switch between the pages of one area (Spending, Developers), styled like the segmented control. */
export function SectionTabs({ label, tabs, className }: { label: string; tabs: SectionTab[]; className?: string }) {
  const pathname = usePathname();
  const id = useId();
  const active = tabs.find((t) => (t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`)));
  return (
    <nav aria-label={label} className={cn("-mt-2 mb-6 max-w-full overflow-x-auto max-md:-mt-1 max-md:mb-4", className)}>
      <ul className="inline-flex h-9 items-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground">
        {tabs.map((t) => {
          const on = t === active;
          return (
            <li key={t.href} className="h-full">
              <Link
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={cn("relative isolate inline-flex h-full items-center rounded-md px-3.5 text-sm font-medium whitespace-nowrap transition-colors hover:text-foreground", on && "text-foreground")}
              >
                {on && <motion.span layoutId={`tabs-${id}`} className="absolute inset-0 -z-10 rounded-md bg-card shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366]" transition={SPRING} aria-hidden="true" />}
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
