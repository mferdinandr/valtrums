# Valtrums user docs

The public Valtrums documentation site, built with [Mintlify](https://mintlify.com). It is written for players: creating and joining battles, scoring, rewards, the winners' vote, the assistant and player agents. Technical specs stay in [`../docs`](../docs).

Live at https://docs.valtrums.xyz/. `.github/workflows/mintlify.yml` deploys it on every push to `main` that touches `docs-site/`. The workflow's `--subdomain valtrum` is Mintlify's internal project ID; keep it as is.

## Preview locally

```bash
cd docs-site
npx mint@latest dev
```

Then open http://localhost:3000.

## Check before pushing

```bash
npx mint@latest validate
npx mint@latest broken-links
```

## Adding a page

1. Create an `.mdx` file with `title`, `description` and `keywords` frontmatter.
2. Add its path to `navigation` in `docs.json`.
3. Take every fact from the app (`web/`), the contracts or `docs/`. Don't document behavior that isn't built.
