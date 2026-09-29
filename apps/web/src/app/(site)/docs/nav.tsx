"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_GROUPS, DOCS } from "@/lib/docs";
import { cn } from "@/lib/utils";

const item = "rounded-lg px-2.5 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold aria-[current=page]:text-foreground";

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-[88px] grid gap-0.5 self-start max-[860px]:static max-[860px]:grid-cols-2" aria-label="Documentation">
      <Link href="/docs" className={item} aria-current={pathname === "/docs" ? "page" : undefined}>
        Overview
      </Link>
      {DOC_GROUPS.map((g) => (
        <div key={g} className="contents">
          <div className={cn("mt-4 mb-1.5 ml-2.5 text-xs font-semibold text-muted-foreground max-[860px]:col-span-full")}>{g}</div>
          {DOCS.filter((d) => d.group === g).map((d) => (
            <Link key={d.slug} href={`/docs/${d.slug}`} className={item} aria-current={pathname === `/docs/${d.slug}` ? "page" : undefined}>
              {d.title}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
