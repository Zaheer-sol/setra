"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { motion, SPRING } from "./motion";

// Appearance follows the system by default; Light or Dark can be pinned per browser.
// next-themes stores the choice and sets the `dark` class on <html> before first paint.

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem storageKey="setra-theme" disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}

const OPTIONS = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon }
] as const;

export function ThemeSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const id = useId();
  useEffect(() => setMounted(true), []);
  return (
    <ToggleGroup
      type="single"
      value={mounted ? theme ?? "system" : "system"}
      onValueChange={(v) => v && setTheme(v)}
      aria-label="Appearance"
      className={cn("rounded-[9px] bg-muted p-0.5", compact && "w-full", className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className={cn(
            "relative isolate h-7 cursor-pointer gap-1.5 rounded-[7px]! border-0 px-3 text-sm font-medium text-foreground hover:bg-transparent data-[state=on]:bg-transparent data-[state=on]:font-semibold",
            compact && "flex-1 px-0"
          )}
        >
          {mounted && (theme ?? "system") === value && (
            <motion.span layoutId={`theme-${id}`} className="absolute inset-0 -z-10 rounded-[7px] bg-card shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366]" transition={SPRING} aria-hidden="true" />
          )}
          <Icon className="size-3.5" aria-hidden="true" />
          {!compact && label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
