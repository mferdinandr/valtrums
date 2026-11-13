# Valtrums user docs

The public Valtrums documentation at https://docs.valtrums.xyz. It is a small Next.js app written for players: creating and joining battles, scoring, rewards, the winners' vote, the assistant and player agents. Technical specs stay in [`../docs`](../docs).

The look follows the web app: the same palette, fonts (Bricolage Grotesque and Figtree) and rounded frames.

## Run locally

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm -F @valtrum/docs dev        # http://localhost:3100
pnpm -F @valtrum/docs typecheck
pnpm -F @valtrum/docs build
```

## Layout

```
content/              one .mdx file per page (frontmatter: title, sidebarTitle, description, keywords)
mdx-components.tsx    components pages can use without importing them
src/lib/navigation.ts sidebar groups and page order
src/lib/pages.ts      one import per page
src/components/mdx/   Steps, Card, Columns, Note/Info/Tip/Warning, Accordion, Tabs
src/components/widgets/ BattleStages, DrawdownCalculator, RewardCalculator
src/app/              layout, page renderer and the raw Markdown route (<page>.md)
```

## Adding a page

1. Create `content/<section>/<slug>.mdx` with `title`, `description` and `keywords` frontmatter (`sidebarTitle` when the sidebar label should be shorter).
2. Add the slug to `NAVIGATION` in `src/lib/navigation.ts` and to `PAGE_LOADERS` in `src/lib/pages.ts`.
3. Take every fact from the app (`web/`), the contracts or `docs/`. Don't document behavior that isn't built.

## Deploy

Deploy it as its own Vercel project with **Root Directory** `docs-site` (framework: Next.js), then add the domain `docs.valtrums.xyz` to that project and point the `docs` CNAME at the target Vercel shows.
