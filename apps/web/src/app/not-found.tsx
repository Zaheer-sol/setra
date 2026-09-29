import { Button } from "@/components/ui/button";
import { Seti } from "@/components/seti";
import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-screen place-items-center p-6">
      <div className="max-w-[420px] text-center">
        <Seti mood="curious" size={132} priority />
        <p className="mt-5 font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-1.5 text-[1.75rem] font-bold tracking-[-0.025em]">This page doesn&rsquo;t exist</h1>
        <p className="mt-2 text-muted-foreground">The link may be old, or the page may have moved.</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button asChild variant="secondary">
            <Link href="/">Home</Link>
          </Button>
          <Button asChild>
            <Link href="/app">Open console</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
