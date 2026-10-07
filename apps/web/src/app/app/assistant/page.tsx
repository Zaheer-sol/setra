"use client";

import { AssistantPanel } from "@/components/assistant";
import { PageHeader } from "@/components/app-ui";

export default function AssistantPage() {
  return (
    <div>
      <PageHeader
        title="Seti"
        description="Ask about payments, cash, profit, receivables, payables or the health of your books in plain language. Seti uses Setra records for every figure and asks before changing a financial record."
      />
      <div className="flex h-[min(78vh,880px)] overflow-hidden rounded-2xl bg-background shadow-card">
        <AssistantPanel full />
      </div>
    </div>
  );
}
