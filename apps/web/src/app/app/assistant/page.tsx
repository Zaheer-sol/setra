"use client";

import { AssistantPanel } from "@/components/assistant";
import { PageHeader } from "@/components/app-ui";

export default function AssistantPage() {
  return (
    <div>
      <PageHeader
        title="Seti"
        description="Ask about payments, profit, cash and what you owe, in plain language. Seti answers from your books, never guesses a number, and asks you to confirm before creating or changing anything."
      />
      <div className="flex h-[min(78vh,880px)] overflow-hidden rounded-2xl bg-background shadow-card">
        <AssistantPanel full />
      </div>
    </div>
  );
}
