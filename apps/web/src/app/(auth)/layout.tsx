import Link from "next/link";
import { Logo } from "@/components/app-ui";
import { AuthAsideVisual } from "@/components/payment-visual";
import { Aurora, Float, Tilt } from "@/components/motion";
import { Seti } from "@/components/seti";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-10 py-7 max-md:p-5">
        <Link href="/" aria-label="Setra home" className="w-fit">
          <Logo />
        </Link>
        <main
          id="main"
          className="m-auto w-full max-w-[380px] py-10 [&_h1]:text-[2rem] [&_h1]:leading-tight [&_h1]:font-bold [&_h1]:tracking-[-0.03em] [&_h1+p]:mb-8"
        >
          <Seti mood="welcome" size={88} priority className="mb-5 lg:hidden" />
          {children}
        </main>
        <p className="text-xs text-muted-foreground">Non-custodial. Setra never asks for private keys or seed phrases.</p>
      </div>
      <aside className="relative isolate flex flex-col justify-between overflow-hidden bg-black p-14 text-[#f5f5f7] max-md:hidden dark:shadow-[inset_0.5px_0_0_rgba(255,255,255,0.12)]" aria-hidden="true">
        <Aurora className="z-0 opacity-90" />
        <blockquote className="relative m-0 max-w-[520px] text-[2rem] leading-[1.18] font-semibold tracking-[-0.03em]">Send an invoice, get paid in USDC on Monad, and find it already in your books.</blockquote>
        <div className="relative flex items-end gap-2">
          <Float amplitude={10} duration={9}>
            <Tilt max={10} glare={false} className="w-fit rounded-[22px]">
              <AuthAsideVisual />
            </Tilt>
          </Float>
          <Seti mood="welcome" size={170} priority className="-ml-10 max-lg:hidden" />
        </div>
        <p className="relative text-sm text-[#86868b]">Invoices and bookkeeping for businesses paid in USDC.</p>
      </aside>
    </div>
  );
}
