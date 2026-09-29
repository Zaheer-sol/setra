import { DocsNav } from "./nav";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[1120px] gap-12 px-6 pt-10 pb-20 max-[860px]:gap-6 max-[860px]:px-4 max-[860px]:pt-6 min-[861px]:grid-cols-[220px_minmax(0,1fr)]">
      <DocsNav />
      <article
        className="prose max-w-[760px] min-w-0 prose-neutral dark:prose-invert prose-headings:tracking-[-0.025em] prose-h1:text-[2.5rem] prose-h1:font-bold prose-h2:mt-10 prose-h2:text-[1.375rem] prose-h2:font-semibold prose-a:font-medium prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:rounded-md prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.86em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-table:block prose-table:overflow-x-auto prose-table:rounded-2xl prose-table:bg-card prose-table:shadow-card prose-th:bg-muted/50 prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2 [&_.lead]:text-[1.0625rem] [&_.lead]:text-muted-foreground"
      >
        {children}
      </article>
    </div>
  );
}
