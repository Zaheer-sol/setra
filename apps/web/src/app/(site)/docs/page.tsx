import type { Metadata } from "next";
import Link from "next/link";
import { DOCS } from "@/lib/docs";
import { CodeBlock } from "@/components/app-ui";
import { Seti } from "@/components/seti";

export const metadata: Metadata = { title: "Docs", description: "Build with Setra APIs, financial events, webhooks and payment intents on Monad." };

export default function DocsIndex() {
  return (
    <>
      <div className="not-prose flex items-end justify-between gap-6">
        <div>
          <h1 className="text-[2.5rem] leading-tight font-bold tracking-[-0.03em]">Setra documentation</h1>
          <p className="mt-3 text-[1.0625rem] text-muted-foreground">
            Create orders and invoices, receive matched payment events, and read the same numbers you see in the Setra console. The API, webhooks and console all run on one engine.
          </p>
        </div>
        <Seti mood="focused" size={130} priority className="shrink-0 max-sm:hidden" />
      </div>
      <CodeBlock
        className="not-prose"
        code={`Merchant → invoice → customer pays USDC on Monad → merchant wallet
        → Setra observes → verifies → matches → financial event → webhook / API`}
      />
      <h2>Start here</h2>
      <ul>
        {DOCS.map((d) => (
          <li key={d.slug}>
            <Link href={`/docs/${d.slug}`}>{d.title}</Link>: {d.lead}
          </li>
        ))}
      </ul>
      <h2>Environments</h2>
      <table>
        <thead>
          <tr>
            <th>Mode</th>
            <th>Keys</th>
            <th>Network</th>
            <th>USDC</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Test</td>
            <td>
              <code>sk_test_</code>
            </td>
            <td>Monad testnet · chain 10143</td>
            <td>
              <code>0x534b2f3A21130d7a60830c2Df862319e593943A3</code>
            </td>
          </tr>
          <tr>
            <td>Live</td>
            <td>
              <code>sk_live_</code>
            </td>
            <td>Monad mainnet · chain 143</td>
            <td>
              <code>0x754704Bc059F8C67012fEd69BC8A327a5aafb603</code>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
