"use client";

import Link from "next/link";
import { Fragment, forwardRef, useCallback, useId, useState, type ComponentProps, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Info, Loader2, Minus, RefreshCw, Search, X, XCircle } from "lucide-react";
import { toast as sonner } from "sonner";
import type { ApiError } from "@/lib/api";
import { money, moneyParts, shortAddress } from "@/lib/format";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Alert as UIAlert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge as UIBadge } from "@/components/ui/badge";
import { Button as UIButton } from "@/components/ui/button";
import { Card as UICard } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input as UIInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select as UISelect, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea as UITextarea } from "@/components/ui/textarea";
import { Tooltip as UITooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatePresence, CountUp, motion, Pop, SPRING, Stagger, StaggerItem } from "./motion";
import { Seti, type SetiMood } from "./seti";

// App-level building blocks. Everything here is composed from shadcn/ui components
// (components/ui/*) and Tailwind; pages import these for a consistent product vocabulary.

// ── Brand ────────────────────────────────────────────────────────────────────

export function Logo({ size = 22, withWordmark = true, invert = false }: { size?: number; withWordmark?: boolean; invert?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[9px]" aria-label="Setra">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="7" style={{ fill: invert ? "#fff" : "var(--logo-bg)" }} />
        <rect x="5.5" y="7" width="10" height="3" rx="1.5" style={{ fill: invert ? "#1d1d1f" : "var(--logo-fg)" }} />
        <rect x="8.5" y="14" width="10" height="3" rx="1.5" style={{ fill: invert ? "#1d1d1f" : "var(--logo-fg)" }} />
        <circle cx="18" cy="8.5" r="1.6" fill="#2997ff" />
      </svg>
      {withWordmark && (
        <span className={cn("font-bold tracking-[-0.03em]", invert ? "text-white" : "text-foreground")} style={{ fontSize: size * 0.78 }}>
          Setra
        </span>
      )}
    </span>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent" | "outline" | "dark";
type Size = "sm" | "md" | "lg";
const variantMap = { primary: "default", accent: "default", secondary: "secondary", ghost: "ghost", danger: "destructive", outline: "outline", dark: "dark" } as const;
const sizeMap = { sm: "sm", md: "default", lg: "lg" } as const;
const iconSizeMap = { sm: "icon-sm", md: "icon", lg: "icon-lg" } as const;

interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", loading, icon, block, className, children, disabled, ...rest }, ref) {
  return (
    <UIButton
      ref={ref}
      variant={variantMap[variant]}
      size={children ? sizeMap[size] : iconSizeMap[size]}
      className={cn(block && "w-full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : icon}
      {children}
    </UIButton>
  );
});

export function ButtonLink({ href, variant = "secondary", size = "md", icon, children, className, ...rest }: { href: string; variant?: Variant; size?: Size; icon?: ReactNode; children?: ReactNode; className?: string; target?: string; rel?: string }) {
  const external = /^https?:|^mailto:/.test(href);
  return (
    <UIButton asChild variant={variantMap[variant]} size={children ? sizeMap[size] : iconSizeMap[size]} className={className}>
      {external ? (
        <a href={href} {...rest}>
          {icon}
          {children}
        </a>
      ) : (
        <Link href={href} {...rest}>
          {icon}
          {children}
        </Link>
      )}
    </UIButton>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────

const toneVariant: Record<Tone, "success" | "warning" | "danger" | "info" | "neutral"> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
  accent: "info",
  neutral: "neutral"
};

export function Badge({ tone = "neutral", children, dot = true, pulse = false, icon, className }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; icon?: ReactNode; className?: string }) {
  return (
    <UIBadge variant={toneVariant[tone]} className={cn("transition-colors duration-500", className)}>
      {icon ?? (dot && <span className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse")} aria-hidden="true" />)}
      {children}
    </UIBadge>
  );
}

export function Chain({ network, name }: { network?: string | null; name?: string | null }) {
  const family = network ?? "monad";
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-foreground/80">
      <span className={cn("size-3.5 shrink-0", family === "monad" ? "rounded-[4px] bg-monad" : family === "base" ? "rounded-full bg-[#0052ff]" : "rounded-[4px] bg-muted-foreground")} aria-hidden="true" />
      {name ?? (family === "monad" ? "Monad" : family === "base" ? "Base" : "Local devnet")}
    </span>
  );
}

export function ChainMark({ className }: { className?: string }) {
  return <span className={cn("inline-block size-3.5 shrink-0 rounded-[4px] bg-monad", className)} aria-hidden="true" />;
}

export function SimulatedTag() {
  return (
    <UIBadge variant="neutral" className="h-5 rounded-md px-1.5 text-[11px]" title="Simulated in test mode. No funds moved.">
      Simulated
    </UIBadge>
  );
}

// ── Money & addresses ────────────────────────────────────────────────────────

export function Money({ value, asset, muted = false, sign = false }: { value: string | null | undefined; asset?: string | null; muted?: boolean; sign?: boolean }) {
  return (
    <span className={cn("tabular", muted && "text-muted-foreground")}>
      {money(value, { sign })}
      {asset && <span className="ml-1 text-[0.85em] font-medium text-muted-foreground">{asset}</span>}
    </span>
  );
}

export function BigMoney({ value, asset, className }: { value: string | null | undefined; asset?: string | null; className?: string }) {
  const n = value && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  const parts = (v: string) => {
    const [whole, cents] = moneyParts(v);
    return (
      <>
        {whole}
        <span className="text-muted-foreground/70">{cents}</span>
      </>
    );
  };
  return (
    <span className={cn("tabular text-[2.75rem] leading-none font-semibold tracking-[-0.035em] max-sm:text-[2rem]", className)}>
      {n === null ? parts(value ?? "") : <CountUp value={n} duration={0.9} format={(x) => parts(x.toFixed(2))} />}
      {asset && <span className="ml-1.5 text-xl font-medium tracking-[-0.01em] text-muted-foreground">{asset}</span>}
    </span>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn("inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary [&_svg]:size-3.5", done && "text-success", className)}
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

export function Address({ value, full = false, copy = true, href }: { value: string | null | undefined; full?: boolean; copy?: boolean; href?: string | null }) {
  if (!value) return <span className="text-muted-foreground">-</span>;
  const text = full ? value : shortAddress(value);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[0.86em] text-foreground/80" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
          {text}
        </a>
      ) : (
        <span className="truncate">{text}</span>
      )}
      {copy && <CopyButton value={value} label="Copy address" />}
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.92em] whitespace-nowrap", className)}>{children}</span>;
}

// ── Layout primitives ────────────────────────────────────────────────────────

export function PageHeader({ title, description, actions, breadcrumbs }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: Array<{ label: string; href?: string }> }) {
  return (
    <div>
      {breadcrumbs && (
        <nav className="mb-2.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
          {breadcrumbs.map((b, i) => (
            <span key={i} className={cn("flex min-w-0 items-center gap-1.5", i === breadcrumbs.length - 1 && "flex-1")}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
              {b.href ? (
                <Link href={b.href} className="hover:text-foreground">
                  {b.label}
                </Link>
              ) : (
                <span aria-current="page" className="truncate">
                  {b.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}
      {title !== undefined && (
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[2.125rem] leading-[1.08] font-bold tracking-[-0.03em] max-md:text-[1.75rem]">{title}</h1>
            {description && <p className="mt-2 max-w-[640px] text-[1.0625rem] leading-snug tracking-[-0.012em] text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
    </div>
  );
}

/** A card with an optional header row (title, description, actions) and footer. */
export function Card({ title, description, actions, children, footer, padded = false, className, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; footer?: ReactNode; padded?: boolean; className?: string; id?: string }) {
  return (
    <UICard className={cn("gap-0 overflow-hidden py-0", className)} id={id} aria-labelledby={title && id ? `${id}-title` : undefined} role={title && id ? "region" : undefined}>
      {(title || actions) && (
        <div className="flex min-h-[60px] flex-wrap items-center justify-between gap-x-3 gap-y-3 border-b px-6 pt-5 pb-4 max-md:px-4">
          {/* The title claims at least ~16rem; actions wrap below it on narrow screens instead of squeezing it. */}
          <div className="min-w-0 flex-1 basis-[16rem]">
            {title && (
              <h2 id={id ? `${id}-title` : undefined} className="text-[1.0625rem] font-semibold tracking-[-0.02em]">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {padded ? <CardBody>{children}</CardBody> : children}
      {footer && <div className="flex items-center justify-between gap-3 border-t px-6 py-3 text-sm text-muted-foreground max-md:px-4">{footer}</div>}
    </UICard>
  );
}

export function CardBody({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cn("px-6 py-5 max-md:px-4", className)}>{children}</div>;
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode] | null | false | undefined> }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,34%)_1fr] max-[560px]:grid-cols-1">
      {items.filter(Boolean).map((item, i, all) => {
        const [k, v] = item as [ReactNode, ReactNode];
        const last = i === all.length - 1;
        return (
          <Fragment key={i}>
            <dt className={cn("min-w-0 py-3 pr-4 text-muted-foreground max-[560px]:pb-0 max-[560px]:text-sm", !last && "border-b max-[560px]:border-b-0")}>{k}</dt>
            <dd className={cn("flex min-w-0 flex-wrap items-center gap-2 py-3 max-[560px]:pt-0.5", !last && "border-b")}>{v ?? <span className="text-muted-foreground">-</span>}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

export function Alert({ tone = "info", title, children, actions, className }: { tone?: "info" | "warning" | "danger" | "success" | "neutral"; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  const Icon = tone === "danger" ? XCircle : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info;
  const variant = tone === "danger" ? "destructive" : tone === "neutral" ? "default" : tone;
  return (
    <UIAlert variant={variant} role={tone === "danger" ? "alert" : "status"} className={className}>
      <Icon aria-hidden="true" />
      {title && <AlertTitle className="line-clamp-none font-semibold">{title}</AlertTitle>}
      {(children || actions) && (
        <AlertDescription className="min-w-0 text-foreground/80">
          {children && <div className="w-full min-w-0">{children}</div>}
          {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
        </AlertDescription>
      )}
    </UIAlert>
  );
}

/** An empty list or first-run state. Pass `mascot` to show Seti instead of the icon on page-level states. */
export function EmptyState({ icon, title, children, actions, mascot }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; mascot?: SetiMood }) {
  return (
    <div className="grid justify-items-center gap-2.5 px-6 py-12 text-center">
      {mascot ? (
        <Seti mood={mascot} size={104} className="mb-1" />
      ) : (
        <Pop>
          <div className="mb-1 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-[22px]" aria-hidden="true">
            {icon}
          </div>
        </Pop>
      )}
      <h3 className="text-[1.0625rem] font-semibold">{title}</h3>
      {children && <p className="max-w-[420px] text-muted-foreground">{children}</p>}
      {actions && <div className="mt-1.5 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorState({ error, retry, compact = false }: { error: ApiError | Error | undefined | null; retry?: () => void; compact?: boolean }) {
  const e = error as ApiError | undefined;
  const title = e?.status === 404 ? "Not found" : e?.status === 403 ? "You don't have access" : "Couldn't load this";
  return (
    <div className={compact ? "px-6 py-5" : "grid justify-items-center gap-2.5 px-6 py-12 text-center"} role="alert">
      {!compact && <Seti mood="attention" size={104} className="mb-1" />}
      <h3 className="text-[1.0625rem] font-semibold">{title}</h3>
      <p className="text-muted-foreground">{e?.message ?? "Something went wrong."}</p>
      {e?.requestId && <p className="font-mono text-[11px] text-muted-foreground">Request {e.requestId}</p>}
      {retry && e?.status !== 404 && e?.status !== 403 && (
        <div className="mt-1.5">
          <Button size="sm" icon={<RefreshCw />} onClick={retry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" role="status">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-6 border-b px-6 py-4 last:border-b-0" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3" style={{ width: `${45 + ((r * 7 + c * 13) % 45)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <Skeleton className="rounded-2xl" style={{ height }} aria-busy="true" aria-label="Loading" role="status" />;
}

export function Checks({ checks }: { checks: Array<{ code: string; passed: boolean | null; label: string; detail: string }> }) {
  return (
    <ul className="grid">
      {checks.map((c) => (
        <li key={c.code} className="grid grid-cols-[22px_1fr] items-start gap-2.5 border-t py-2.5 first:border-t-0">
          <span
            className={cn(
              "mt-px grid size-5 place-items-center rounded-full [&_svg]:size-3 [&_svg]:stroke-[3]",
              c.passed === true ? "bg-success/12 text-success" : c.passed === false ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
            )}
            aria-label={c.passed === true ? "Passed" : c.passed === false ? "Failed" : "Note"}
          >
            {c.passed === true ? <Check /> : c.passed === false ? <X /> : <Minus />}
          </span>
          <div>
            <div className="font-semibold">{c.label}</div>
            <div className="text-sm text-muted-foreground">{c.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Pager({ hasMore, onNext, onPrev, canPrev, count }: { hasMore: boolean; onNext: () => void; onPrev: () => void; canPrev: boolean; count: number }) {
  if (!hasMore && !canPrev) return count ? <div className="border-t px-6 py-2.5 text-sm text-muted-foreground max-md:px-4">{count} shown</div> : null;
  return (
    <div className="flex items-center justify-between border-t px-6 py-2.5 text-sm text-muted-foreground max-md:px-4">
      <span>{count} shown</span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" icon={<ChevronLeft />} onClick={onPrev} disabled={!canPrev}>
          Previous
        </Button>
        <Button size="sm" variant="secondary" onClick={onNext} disabled={!hasMore}>
          Next <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/** Keyset pagination state for list pages. */
export function useCursorPager() {
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    reset: useCallback(() => setStack([]), []),
    next: (c: string | null) => c && setStack((s) => [...s, c]),
    prev: () => setStack((s) => s.slice(0, -1)),
    canPrev: stack.length > 0
  };
}

// ── Forms ────────────────────────────────────────────────────────────────────

export function Field({ label, hint, error, optional, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("grid min-w-0 grid-cols-1 gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="flex items-baseline justify-between gap-2 font-medium text-foreground/80">
        <span className="flex-1">{label}</span>
        {optional && <span className="font-normal text-muted-foreground">Optional</span>}
      </Label>
      {children}
      {error ? (
        <span className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertCircle size={13} aria-hidden="true" /> {error}
        </span>
      ) : hint ? (
        <span className="text-xs leading-snug text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input"> & { invalid?: boolean }>(function Input({ invalid, ...rest }, ref) {
  return <UIInput ref={ref} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea"> & { invalid?: boolean }>(function Textarea({ invalid, ...rest }, ref) {
  return <UITextarea ref={ref} aria-invalid={invalid || undefined} {...rest} />;
});

export interface Option {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}
export interface OptionGroup {
  group: string;
  options: Option[];
}
const isGroup = (o: Option | OptionGroup): o is OptionGroup => "group" in o;

// Radix Select reserves "" for "no value"; map it to a sentinel so "All …" options work.
const EMPTY = "__empty__";

/** shadcn Select with a flat options list. `value=""` is a normal, selectable option. */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  id,
  name,
  invalid,
  required,
  disabled,
  className,
  size = "default",
  "aria-label": ariaLabel
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<Option | OptionGroup>;
  placeholder?: string;
  id?: string;
  name?: string;
  invalid?: boolean;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
  "aria-label"?: string;
}) {
  const flat = options.flatMap((o) => (isGroup(o) ? o.options : [o]));
  const hasEmpty = flat.some((o) => o.value === "");
  const item = (o: Option) => (
    <SelectItem key={o.value || EMPTY} value={o.value || EMPTY} disabled={o.disabled}>
      {o.label}
    </SelectItem>
  );
  return (
    <UISelect value={value === "" && hasEmpty ? EMPTY : value || undefined} onValueChange={(v) => onValueChange(v === EMPTY ? "" : v)} name={name} required={required} disabled={disabled}>
      <SelectTrigger id={id} size={size} className={cn("w-full min-w-0 *:data-[slot=select-value]:min-w-0", className)} aria-invalid={invalid || undefined} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) =>
          isGroup(o) ? (
            o.options.length > 0 && (
              <SelectGroup key={o.group}>
                <SelectLabel className="text-xs font-semibold">{o.group}</SelectLabel>
                {o.options.map(item)}
              </SelectGroup>
            )
          ) : (
            item(o)
          )
        )}
      </SelectContent>
    </UISelect>
  );
}

/** Map API field errors onto form fields. */
export function fieldErrors(error: ApiError | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of error?.details ?? []) if (d.field && !out[d.field]) out[d.field] = d.message;
  return out;
}

// ── Overlays ─────────────────────────────────────────────────────────────────

export function Modal({ open, onClose, title, description, children, footer, wide = false }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn("max-h-[calc(100vh-48px)] gap-0 overflow-hidden p-0", wide ? "sm:max-w-[720px]" : "sm:max-w-[560px]")}>
        <DialogHeader className="px-6 pt-6 pb-0 text-left">
          <DialogTitle className="text-[1.0625rem] font-semibold tracking-[-0.02em]">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{typeof title === "string" ? title : "Dialog"}</DialogDescription>}
        </DialogHeader>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <DialogFooter className="px-6 pb-6">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

// ── Toasts (Sonner) ──────────────────────────────────────────────────────────

type ToastTone = "success" | "error" | "info";
const push = (tone: ToastTone, message: string) => (tone === "success" ? sonner.success(message) : tone === "error" ? sonner.error(message) : sonner.info(message));
export const useToast = () => push;

// ── Tooltip ──────────────────────────────────────────────────────────────────

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <UITooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </UITooltip>
  );
}

export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cn("relative overflow-x-auto rounded-2xl bg-[#1d1d1f] px-[18px] py-4 font-mono text-[12.5px] leading-[1.65] whitespace-pre text-[#f5f5f7] dark:shadow-card", className)} aria-label={label}>
      <CopyButton value={code} label="Copy code" className="absolute top-2.5 right-2.5 size-8 text-[#86868b] hover:bg-white/10 hover:text-white" />
      <code>{code}</code>
    </div>
  );
}

// ── Shared text helpers ──────────────────────────────────────────────────────

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-sm font-semibold text-muted-foreground", className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin", className)} aria-hidden="true" />;
}

/** Segmented control (shadcn Tabs list without panels). */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: ReactNode }>; label: string; className?: string }) {
  const id = useId();
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)} className={className}>
      <TabsList aria-label={label}>
        {options.map((o) => (
          <TabsTrigger
            key={o.value}
            value={o.value}
            className="relative isolate cursor-pointer px-3.5 data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent"
          >
            {value === o.value && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 -z-10 rounded-md bg-card shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366]" transition={SPRING} aria-hidden="true" />}
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Headline numbers as a grid of small cards (the shadcn dashboard "section cards" pattern). */
export function Metrics({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <Stagger onView={false} gap={0.06} aria-label={label} className={cn("grid grid-cols-2 gap-4 max-sm:gap-3 lg:grid-cols-3 xl:grid-cols-5", className)}>
      {children}
    </Stagger>
  );
}

export function Metric({ label, value, money: isMoney, foot, href, warn, small }: { label: ReactNode; value: ReactNode; money?: boolean; foot?: ReactNode; href?: string; warn?: boolean; small?: boolean }) {
  const numeric = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  const shown =
    numeric === null ? (
      value
    ) : isMoney ? (
      <CountUp value={numeric} format={(n) => <MoneyText value={n.toFixed(2)} />} />
    ) : (
      <CountUp value={numeric} format={(n) => Math.round(n).toLocaleString("en-US")} />
    );
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">{label}</span>
      <span className={cn("tabular text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.028em] max-sm:text-[1.35rem]", small && "text-xl max-sm:text-lg", warn && "text-warning")}>{shown}</span>
      {foot && <span className="text-xs text-muted-foreground">{foot}</span>}
    </>
  );
  const cls = "metric grid h-full min-w-0 content-start gap-2 rounded-2xl bg-card px-5 py-[18px] text-card-foreground shadow-card max-sm:px-4 max-sm:py-3.5";
  return (
    <StaggerItem className="h-full">
      {href ? (
        <Link href={href} className={cn(cls, "transition-[box-shadow,translate] duration-300 hover:-translate-y-0.5 hover:shadow-raised")}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </StaggerItem>
  );
}

/** "$1,234" with the cents quieter, for animated money. */
function MoneyText({ value }: { value: string }) {
  const [whole, cents] = moneyParts(value);
  return (
    <>
      {whole}
      <span className="font-medium text-muted-foreground/70">{cents}</span>
    </>
  );
}

/** Route-driven tabs (underline style) for list pages. */
export function NavTabs({ label, items, className, children }: { label: string; items: Array<{ href: string; label: ReactNode; active: boolean }>; className?: string; children?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b px-6 max-md:px-4", className)}>
      <nav className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]" aria-label={label}>
        {items.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.active ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
              t.active && "font-semibold text-foreground"
            )}
          >
            {t.label}
            {t.active && <motion.span layoutId={`tab-${id}`} className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" transition={SPRING} aria-hidden="true" />}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}

/** Filter row under a card's tabs. */
export function Toolbar({ children, className, ...rest }: ComponentProps<"form">) {
  return (
    <form className={cn("flex flex-wrap items-center gap-2 border-b px-6 py-3.5 max-md:px-4", className)} {...rest}>
      {children}
    </form>
  );
}

export function SearchInput({ className, ...rest }: ComponentProps<"input">) {
  return (
    <div className={cn("relative max-w-[360px] min-w-[200px] flex-[1_1_220px]", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <UIInput className="h-8 pl-8 text-sm" {...rest} />
    </div>
  );
}

// ── Detail-page pieces ───────────────────────────────────────────────────────

export function TextLink({ href, children, className, mono, external }: { href: string; children: ReactNode; className?: string; mono?: boolean; external?: boolean }) {
  const cls = cn("font-medium text-primary hover:underline underline-offset-3", mono && "font-mono text-[0.92em]", className);
  return external ? (
    <a href={href} className={cls} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** Status badge row above a hero amount. `status-line` is kept as a stable hook for tests. */
export function StatusLine({ children, eyebrow }: { children: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="status-line mb-3 flex flex-wrap items-center gap-2">
      {children}
      {eyebrow && <span className="text-sm font-semibold text-muted-foreground">{eyebrow}</span>}
    </div>
  );
}

export function DetailHero({ children, actions, below }: { children: ReactNode; actions?: ReactNode; below?: ReactNode }) {
  return (
    <UICard className="gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-6 p-6 max-md:px-4 max-md:py-5">
        <div className="min-w-0">{children}</div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {below && <div className="grid gap-3 px-6 pb-5 max-md:px-4">{below}</div>}
    </UICard>
  );
}

export function HeroMeta({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex flex-wrap items-center gap-x-[18px] gap-y-2.5 text-muted-foreground">{children}</div>;
}

/** What a payment/invoice is for. `className` carries test hooks such as `hero-purpose`. */
export function PurposeBlock({ label = "For", title, unknown, className, size = "lg" }: { label?: ReactNode; title?: ReactNode; unknown?: boolean; className?: string; size?: "md" | "lg" }) {
  return (
    <div className={cn("grid min-w-0 gap-0.5", className)}>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className={cn("font-semibold tracking-[-0.02em] break-words", size === "lg" ? "text-[1.0625rem]" : "text-[0.9375rem]", unknown && "font-normal text-muted-foreground italic")}>{unknown ? "Purpose unknown" : title}</span>
    </div>
  );
}

export function LineItems({ items, total, className }: { items: Array<{ description: string; quantity: number; amount: string }>; total?: string; className?: string }) {
  return (
    <dl className={cn("mt-3 grid border-t", className)}>
      {items.map((li, i) => (
        <div key={i} className="flex justify-between gap-4 border-b py-2 text-sm">
          <dt className="min-w-0 break-words text-foreground/80">
            {li.description}
            {li.quantity > 1 && <span className="text-muted-foreground"> × {li.quantity}</span>}
          </dt>
          <dd className="tabular whitespace-nowrap">{money(li.amount)}</dd>
        </div>
      ))}
      {total !== undefined && (
        <div className="flex justify-between gap-4 py-2 text-sm font-semibold">
          <dt>Total</dt>
          <dd className="tabular whitespace-nowrap">{money(total)}</dd>
        </div>
      )}
    </dl>
  );
}

const dotTone: Record<string, string> = {
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-info/12 text-info"
};

export function Timeline({ items }: { items: Array<{ title: ReactNode; meta?: ReactNode; time?: ReactNode; timeTitle?: string; tone?: string; icon?: ReactNode; href?: string }> }) {
  return (
    <ol className="grid">
      {items.map((i, n) => (
        <li key={n} className="relative grid grid-cols-[24px_1fr] gap-3 pb-[18px] last:pb-0">
          {n < items.length - 1 && <span className="absolute top-[26px] bottom-0.5 left-[11.5px] w-px bg-border" aria-hidden="true" />}
          <span className={cn("z-[1] grid size-6 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-3", i.tone && dotTone[i.tone])} aria-hidden="true">
            {i.icon}
          </span>
          <div className="min-w-0">
            <div className="font-semibold">{i.href ? <Link href={i.href} className="hover:underline">{i.title}</Link> : i.title}</div>
            {i.meta && <div className="text-sm break-words text-muted-foreground">{i.meta}</div>}
            {i.time && (
              <div className="text-sm text-muted-foreground" title={i.timeTitle}>
                {i.time}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Radio options presented as cards (shadcn RadioGroup). */
export function ChoiceGroup({ value, onChange, label, children, className }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode; className?: string }) {
  return (
    <RadioGroup value={value} onValueChange={onChange} aria-label={label} className={cn("gap-2.5", className)}>
      {children}
    </RadioGroup>
  );
}

export function ChoiceCard({ id, value, selected, disabled, title, description, children }: { id: string; value: string; selected: boolean; disabled?: boolean; title?: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-2xl border bg-card px-4 py-3.5 leading-normal font-normal transition-colors hover:border-muted-foreground/50",
        selected && "border-primary bg-primary/5 ring-1 ring-primary hover:border-primary",
        disabled && "cursor-not-allowed opacity-55"
      )}
    >
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-0.5" />
      <span className="grid min-w-0 gap-0.5">
        {title && <span className="flex flex-wrap items-center gap-2 font-semibold">{title}</span>}
        {description && <span className="text-sm text-muted-foreground">{description}</span>}
        {children}
      </span>
    </Label>
  );
}

export function Muted({ children, className, as: Tag = "p" }: { children: ReactNode; className?: string; as?: "p" | "span" | "div" }) {
  return <Tag className={cn("text-sm text-muted-foreground", className)}>{children}</Tag>;
}

export function Stack({ children, className, gap = 6 }: { children: ReactNode; className?: string; gap?: 3 | 4 | 6 }) {
  return <div className={cn("grid min-w-0 [&>*]:min-w-0", gap === 3 ? "gap-3" : gap === 4 ? "gap-4" : "gap-6", className)}>{children}</div>;
}

export function DetailGrid({ children, aside = 360 }: { children: ReactNode; aside?: number }) {
  return <div className={cn("grid items-start gap-6 [&>*]:min-w-0", aside === 360 ? "xl:grid-cols-[minmax(0,1fr)_360px]" : "xl:grid-cols-[minmax(0,1fr)_400px]")}>{children}</div>;
}

/** A dollar amount input: "$" prefix, optional unit suffix, digits and one dot only. */
export function MoneyInput({ value, onChange, suffix, large, invalid, className, ...rest }: Omit<ComponentProps<"input">, "onChange" | "value"> & { value: string; onChange: (v: string) => void; suffix?: string; large?: boolean; invalid?: boolean }) {
  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-3 text-muted-foreground">$</span>
      <Input
        {...rest}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
        invalid={invalid}
        aria-describedby={suffix && rest.id ? `${rest.id}-currency` : undefined}
        className={cn("tabular pl-6", suffix && "pr-14", large && "h-11 rounded-xl text-[1.0625rem]", className)}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 text-sm font-medium text-muted-foreground" id={rest.id ? `${rest.id}-currency` : undefined}>
          {suffix}
        </span>
      )}
    </div>
  );
}
