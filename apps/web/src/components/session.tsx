"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useApi } from "@/lib/api";

export interface Me {
  kind: "user";
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; role: string; is_demo: boolean; onboarding_completed: boolean } | null;
  organizations: Array<{ id: string; name: string; role: string; is_demo: boolean }>;
  environment: "test" | "live";
  role: string | null;
  permissions: string[];
}

interface SessionValue {
  me: Me;
  refresh: () => Promise<unknown>;
  can: (permission: string) => boolean;
  isTest: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside the console");
  return value;
}

export function SessionProvider({ me, refresh, children }: { me: Me; refresh: () => Promise<unknown>; children: ReactNode }) {
  return <SessionContext.Provider value={{ me, refresh, can: (p) => me.permissions.includes(p), isTest: me.environment === "test" }}>{children}</SessionContext.Provider>;
}

export function useMe() {
  return useApi<Me>("/v1/me", { shouldRetryOnError: false, revalidateOnFocus: false });
}
