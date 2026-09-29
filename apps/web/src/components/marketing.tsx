import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChainMark } from "./app-ui";
import { Stagger, StaggerItem, Tilt } from "./motion";
import { Seti, type SetiMood } from "./seti";

// Building blocks for the marketing site (Tailwind + shadcn tokens).

export const wrap = "mx-auto max-w-[1200px] px-6 max-md:px-4";
export const section = "py-28 max-md:py-16";

/** Large page title block used at the top of secondary marketing pages, optionally with Seti beside it. */
export function PageHero({ title, children, mascot, actions }: { title: ReactNode; children?: ReactNode; mascot?: SetiMood; actions?: ReactNode }) {
  return (
    <section className="pt-22 pb-14 max-md:pt-12">
      <div className={cn(wrap, "flex items-end justify-between gap-10")}>
        <Stagger onView={false} gap={0.1} className="min-w-0">
          {mascot && (
            <StaggerItem className="md:hidden">
              <Seti mood={mascot} size={112} priority className="mb-5" />
            </StaggerItem>
          )}
          <StaggerItem>
            <h1 className="max-w-[860px] text-[clamp(2.5rem,5vw,4rem)] leading-[1.05] font-bold tracking-[-0.03em] text-balance">{title}</h1>
          </StaggerItem>
          {children && (
            <StaggerItem>
              <p className="mt-5 max-w-[680px] text-[clamp(1.1875rem,1.6vw,1.375rem)] leading-[1.42] tracking-[-0.015em] text-muted-foreground">{children}</p>
            </StaggerItem>
          )}
          {actions && (
            <StaggerItem>
              <div className="mt-8 flex flex-wrap gap-2.5">{actions}</div>
            </StaggerItem>
          )}
        </Stagger>
        {mascot && (
          <>
            <Seti mood={mascot} size={220} priority className="mr-4 shrink-0 max-lg:hidden" />
            <Seti mood={mascot} size={160} priority className="shrink-0 max-md:hidden lg:hidden" />
          </>
        )}
      </div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-card py-[5px] pr-[13px] pl-1.5 text-sm font-medium text-foreground/80 shadow-card">
      <ChainMark className="size-[18px] rounded-md" /> {children}
    </span>
  );
}

export function TextArrow({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1 text-[1.0625rem] tracking-[-0.015em] text-primary hover:underline underline-offset-3">
      {children} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

export function SectionHead({ kicker, title, children, className }: { kicker: string; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-12 max-w-[680px]", className)}>
      <div className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-muted-foreground">{kicker}</div>
      <h2 className="mt-2 text-[clamp(2rem,4vw,3rem)] leading-[1.08] font-bold tracking-[-0.03em] text-balance">{title}</h2>
      {children && <p className="mt-4 text-[clamp(1.0625rem,1.3vw,1.25rem)] leading-[1.45] tracking-[-0.012em] text-muted-foreground">{children}</p>}
    </div>
  );
}

export function InlineCode({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return <code className={cn("rounded-md px-1.5 py-0.5 font-mono text-[0.86em]", dark ? "bg-white/10" : "bg-muted text-foreground")}>{children}</code>;
}

export function Bullet({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_1fr] gap-3 leading-normal text-foreground/80">
      <span className="mt-0.5 text-primary [&_svg]:size-[18px]">{icon}</span>
      <span>
        <strong className="text-foreground">{title}</strong> {children}
      </span>
    </li>
  );
}

export function Feature({ icon, title, body, inset }: { icon: ReactNode; title: string; body: string; inset?: boolean }) {
  return (
    <Tilt max={5} className="h-full rounded-[28px]">
      <div className={cn("h-full rounded-[28px] px-[30px] py-8 transition-shadow duration-300 hover:shadow-raised", inset ? "bg-background" : "bg-card text-card-foreground")}>
        <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground [&_svg]:size-[22px]" aria-hidden="true">
          {icon}
        </span>
        <h3 className="mt-[18px] mb-2 text-xl font-semibold tracking-[-0.022em]">{title}</h3>
        <p className="text-[0.9375rem] leading-normal text-muted-foreground">{body}</p>
      </div>
    </Tilt>
  );
}

/** Vertical flow diagram: a column of nodes joined by short lines. */
export function Flow({ nodes, label }: { nodes: Array<{ title: string; detail: string; tone?: "monad" | "dark" }>; label?: string }) {
  return (
    <Stagger className="grid max-w-[420px]" aria-label={label} gap={0.1}>
      {nodes.map((n, i) => (
        <StaggerItem key={i}>
          {i > 0 && <div className="ml-6 h-[18px] w-0.5 bg-border" />}
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-[14px] px-[18px] py-3.5 font-semibold shadow-card",
              n.tone === "monad" ? "bg-monad text-white" : n.tone === "dark" ? "bg-[#1d1d1f] text-white" : "bg-card text-card-foreground"
            )}
          >
            {n.title}
            <span className={cn("text-sm font-normal", n.tone ? "text-white/75" : "text-muted-foreground")}>{n.detail}</span>
          </div>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

export function CheckList({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn("grid gap-3.5", className)}>
      {items.map((p) => (
        <li key={p} className="grid grid-cols-[22px_1fr] gap-3 leading-normal text-foreground/80">
          <svg viewBox="0 0 24 24" className="mt-0.5 size-[18px] text-primary" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

export function Tile({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tilt max={5} className="h-full rounded-[28px]">
      <div className={cn("h-full rounded-[28px] bg-card px-[30px] py-8 text-card-foreground", className)}>
        <h3 className="mb-2 text-xl font-semibold tracking-[-0.022em]">{title}</h3>
        <div className="text-[0.9375rem] leading-normal text-muted-foreground">{children}</div>
      </div>
    </Tilt>
  );
}
