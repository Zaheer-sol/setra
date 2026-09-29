import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOCS } from "@/lib/docs";

const pager = "grid min-w-[200px] gap-0.5 rounded-2xl bg-card px-[18px] py-3.5 font-medium text-card-foreground shadow-card transition-shadow hover:shadow-raised";

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = DOCS.find((d) => d.slug === slug);
  return { title: doc ? `${doc.title} · Docs` : "Docs", description: doc?.lead };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const index = DOCS.findIndex((d) => d.slug === slug);
  if (index === -1) notFound();
  const doc = DOCS[index]!;
  const prev = DOCS[index - 1];
  const next = DOCS[index + 1];
  return (
    <>
      <h1>{doc.title}</h1>
      <p className="lead">{doc.lead}</p>
      {doc.body}
      <nav className="not-prose mt-14 flex justify-between gap-4 border-t pt-6" aria-label="Pagination">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} className={pager}>
            <span className="text-xs text-muted-foreground">Previous</span>
            {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/docs/${next.slug}`} className={`${pager} text-right`}>
            <span className="text-xs text-muted-foreground">Next</span>
            {next.title}
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}
