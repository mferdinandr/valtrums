import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getPage } from "@/lib/content";
import { ALL_SLUGS, SITE_URL, hrefOf } from "@/lib/navigation";
import { PAGE_LOADERS } from "@/lib/pages";
import { PageActions } from "@/components/shell/page-actions";
import { Toc } from "@/components/shell/toc";

export const dynamicParams = false;

interface Props {
  params: Promise<{ slug?: string[] }>;
}

function slugOf(parts: string[] | undefined): string {
  return parts && parts.length > 0 ? parts.join("/") : "index";
}

export function generateStaticParams() {
  return ALL_SLUGS.map((slug) => ({ slug: slug === "index" ? [] : slug.split("/") }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  if (!ALL_SLUGS.includes(slug)) return {};
  const { title, description, keywords } = getPage(slug).frontmatter;
  const url = `${SITE_URL}${hrefOf(slug)}`;
  return {
    title: slug === "index" ? { absolute: title } : title,
    description,
    keywords,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "Valtrums Docs", type: "article" },
  };
}

export default async function DocPage({ params }: Props) {
  const slug = slugOf((await params).slug);
  const load = PAGE_LOADERS[slug];
  if (!load || !ALL_SLUGS.includes(slug)) notFound();
  const { default: Content } = await load();
  const page = getPage(slug);
  const index = ALL_SLUGS.indexOf(slug);
  const prevSlug = index > 0 ? ALL_SLUGS[index - 1] : undefined;
  const nextSlug = index < ALL_SLUGS.length - 1 ? ALL_SLUGS[index + 1] : undefined;
  const labelOf = (s: string) => {
    const fm = getPage(s).frontmatter;
    return fm.sidebarTitle ?? fm.title;
  };
  const markdownPath = slug === "index" ? "/index.md" : `/${slug}.md`;

  return (
    <div className="page-grid">
      <article className="doc">
        <header className="doc-header">
          <p className="eyebrow">{page.group}</p>
          <h1>{page.frontmatter.title}</h1>
          <p className="doc-description">{page.frontmatter.description}</p>
          <PageActions markdownPath={markdownPath} pageUrl={`${SITE_URL}${hrefOf(slug)}`} />
        </header>
        <div className="doc-body">
          <Content />
        </div>
        <nav aria-label="Previous and next page" className="pager">
          {prevSlug ? (
            <Link href={hrefOf(prevSlug)} className="pager-link">
              <span className="pager-hint">
                <ChevronLeft size={14} aria-hidden /> Previous
              </span>
              <span className="pager-title">{labelOf(prevSlug)}</span>
            </Link>
          ) : (
            <span />
          )}
          {nextSlug && (
            <Link href={hrefOf(nextSlug)} className="pager-link pager-next">
              <span className="pager-hint">
                Next <ChevronRight size={14} aria-hidden />
              </span>
              <span className="pager-title">{labelOf(nextSlug)}</span>
            </Link>
          )}
        </nav>
      </article>
      <aside className="doc-toc">
        <Toc />
      </aside>
    </div>
  );
}
