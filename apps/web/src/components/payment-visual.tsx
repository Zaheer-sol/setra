"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, ChainMark } from "./app-ui";

/**
 * The product in one picture: money arrives on Monad, Setra turns it into business meaning.
 * Plays through its steps once, gently; reduced-motion users see the final state.
 */
const STEPS = ["Payment detected on Monad", "Verified: USDC, receiving wallet, amount", "Matched to Acme Ltd · INV-2041", "Invoice paid · webhook sent"];

function useSequence(length: number, interval = 1100) {
  const [step, setStep] = useState(length);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setStep(0);
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setStep(i);
      if (i >= length) clearInterval(t);
    }, interval);
    return () => clearInterval(t);
  }, [length, interval]);
  return step;
}

const hvCard = "rounded-[22px] bg-card px-[22px] py-5 text-left text-card-foreground shadow-overlay";
const hvLabel = "text-xs font-medium text-muted-foreground";

export function HeroVisual() {
  const step = useSequence(STEPS.length);
  const paid = step >= STEPS.length;
  return (
    <div className="grid w-full max-w-[440px] [transform-style:preserve-3d]" aria-label="A $2,000 USDC payment on Monad being matched to invoice INV-2041 and marked paid">
      <div className={cn(hvCard, "w-[86%] shadow-raised [transform:translateZ(18px)]")}>
        <div className="flex items-center justify-between gap-3">
          <span className={hvLabel}>Incoming transfer</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground/80">
            <ChainMark /> Monad
          </span>
        </div>
        <div className="tabular mt-1.5 text-[1.875rem] font-semibold tracking-[-0.03em]">
          2,000.00 <span className="text-[1.05rem] font-medium text-muted-foreground">USDC</span>
        </div>
        <div className="mt-1 font-mono text-[11.5px] text-muted-foreground">0x91c4…0a72 → 0x5e7a…93f1</div>
      </div>
      <div className="relative ml-9 h-[34px] w-0.5 overflow-hidden bg-border" aria-hidden="true">
        <span className={cn("absolute inset-0 bg-primary transition-transform duration-700 ease-(--ease-apple)", step > 0 ? "translate-y-0" : "-translate-y-full")} />
      </div>
      <div className={cn(hvCard, "ml-[14%] transition-shadow duration-700 [transform:translateZ(46px)]", paid && "shadow-[0_0_0_1px_rgba(48,209,88,0.35),0_0_48px_rgba(48,209,88,0.18),var(--overlay-shadow)]")}>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 font-semibold tracking-[-0.02em]">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <rect width="24" height="24" rx="7" style={{ fill: "var(--logo-bg)" }} />
              <rect x="5.5" y="7" width="10" height="3" rx="1.5" style={{ fill: "var(--logo-fg)" }} />
              <rect x="8.5" y="14" width="10" height="3" rx="1.5" style={{ fill: "var(--logo-fg)" }} />
              <circle cx="18" cy="8.5" r="1.6" fill="#2997ff" />
            </svg>
            Setra
          </span>
          <Badge tone={paid ? "success" : "info"} pulse={!paid}>
            {paid ? "Paid" : "Confirming"}
          </Badge>
        </div>
        <ul className="my-4 grid gap-[9px]">
          {STEPS.map((label, i) => (
            <li key={label} className={cn("flex items-center gap-2.5 text-sm transition-colors", i < step ? "text-foreground" : i === step ? "text-foreground/80" : "text-muted-foreground")}>
              <span
                className={cn(
                  "grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] border-border transition-colors",
                  i < step && "border-success bg-success text-white",
                  i === step && "animate-spin border-dashed border-primary [animation-duration:3s]"
                )}
              >
                {i < step ? <Check className="size-[11px] stroke-[3]" /> : null}
              </span>
              {label}
            </li>
          ))}
        </ul>
        <div className="flex justify-between border-t pt-3.5">
          <div>
            <div className={hvLabel}>Acme Ltd</div>
            <div className="tabular mt-0.5 font-semibold">INV-2041</div>
          </div>
          <div className="text-right">
            <div className={hvLabel}>Amount due</div>
            <div className="tabular mt-0.5 font-semibold">$2,000.00</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AuthAsideVisual() {
  return (
    <div className="relative max-w-[400px] rounded-[22px] border-[0.5px] border-white/12 bg-white/4 px-[26px] py-6 backdrop-blur-xl">
      <div className="flex items-center justify-between text-sm text-[#a1a1a6]">
        <span>INV-2041 · Acme Ltd</span>
        <span className="rounded-full bg-[#30d158]/16 px-2.5 py-0.5 text-xs font-semibold text-[#30d158]">Paid</span>
      </div>
      <div className="tabular mt-2 mb-3.5 text-4xl font-semibold tracking-[-0.03em]">$2,000.00</div>
      <div className="grid gap-2 text-sm text-[#d2d2d7]">
        {["Correct receiving wallet", "Approved asset · USDC", "Monad · finalized", "Exact amount", "One deterministic candidate"].map((c) => (
          <div key={c} className="flex items-center gap-2">
            <Check className="size-[13px] stroke-[3] text-[#30d158]" /> {c}
          </div>
        ))}
      </div>
    </div>
  );
}
