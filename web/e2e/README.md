# Browser e2e (Playwright + Brave)

Tests drive the installed Brave browser (Chromium) against a production build of the web app.
The app reads from a FIXTURE read service (`fixture-read-api.mjs`): the real agent read code over in-memory data.
Nothing here touches a live chain, wallet or account.

## Run

```bash
pnpm -F @valtrum/agent build      # the fixture imports agent/dist
pnpm -C web e2e                   # headless
E2E_HEADED=1 E2E_SLOWMO=500 pnpm -C web e2e   # visible Brave window, slowed down
```

| Variable | Meaning |
| --- | --- |
| `E2E_HEADED=1` | Open a visible Brave window |
| `E2E_SLOWMO=<ms>` | Delay each browser step so it can be watched |
| `BRAVE_PATH` | Override the Brave binary (default: macOS app path) |

Ports: fixture API `18790`, web `3100`. Failure screenshots and traces go to `e2e/.results/` (git-ignored).

## Not covered

Wallet signing, the deposit flow and live-chain reads. Those belong to the acceptance issue (#80).
