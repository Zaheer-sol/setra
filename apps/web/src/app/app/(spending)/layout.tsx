import type { ReactNode } from "react";
import { SectionTabs } from "@/components/section-tabs";

/** Bills, expenses and vendors are one area in the console: Spending. */
export default function SpendingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionTabs
        label="Spending"
        tabs={[
          { href: "/app/bills", label: "Bills" },
          { href: "/app/expenses", label: "Expenses" },
          { href: "/app/vendors", label: "Vendors" }
        ]}
      />
      {children}
    </>
  );
}
