import type { Metadata } from "next";
import { ConsoleShell } from "@/components/console-shell";

export const metadata: Metadata = { title: { default: "Console", template: "%s · Setra" }, robots: { index: false } };

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
