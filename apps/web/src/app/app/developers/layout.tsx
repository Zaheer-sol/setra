"use client";

import type { ReactNode } from "react";
import { SectionTabs } from "@/components/section-tabs";
import { useSession } from "@/components/session";

/** The developer pages share one entry in the sidebar and switch here. */
export default function DevelopersLayout({ children }: { children: ReactNode }) {
  const { me } = useSession();
  return (
    <>
      <SectionTabs
        label="Developers"
        tabs={[
          { href: "/app/developers", label: "Overview", exact: true },
          { href: "/app/developers/api-keys", label: "API keys" },
          { href: "/app/developers/webhooks", label: "Webhooks" },
          { href: "/app/developers/events", label: "Events" },
          ...(me.environment === "test" ? [{ href: "/app/developers/test-mode", label: "Test payments" }] : [])
        ]}
      />
      {children}
    </>
  );
}
