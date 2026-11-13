import { getPage } from "@/lib/content";
import { ALL_SLUGS } from "@/lib/navigation";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return ALL_SLUGS.map((slug) => ({ slug: slug.split("/") }));
}

/** The raw Markdown source of a page, served at `<page URL>.md` through a rewrite. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const slug = (await params).slug.join("/");
  if (!ALL_SLUGS.includes(slug)) return new Response("Not found", { status: 404 });
  return new Response(getPage(slug).raw, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
