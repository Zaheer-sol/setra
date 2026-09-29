"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Seti } from "@/components/seti";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <main id="main" className="grid min-h-screen place-items-center p-6">
      <div className="max-w-[440px] text-center">
        <Seti mood="attention" size={132} priority />
        <h1 className="mt-5 text-xl font-bold tracking-[-0.02em]">Something went wrong on this page</h1>
        <p className="mt-2 text-muted-foreground">Your payment records are unaffected. Try again, or reload the page.</p>
        {error.digest && <p className="mt-2 font-mono text-[11px] text-muted-foreground">Reference {error.digest}</p>}
        <Button className="mt-5" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
