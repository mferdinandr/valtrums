# Valtrum demo video

The NEAR hackathon demo video, built with [Remotion](https://www.remotion.dev/). This folder is its own npm project and is not part of the pnpm workspace.

Output: 1920x1080, 30 fps, about 29 seconds. It has no audio yet; the voiceover is added later.

## Commands

```bash
cd video
npm i
npm run dev      # Remotion Studio preview
npm run render   # writes out/valtrum-demo.mp4 (git-ignored)
npm run lint     # eslint + tsc
```

## Scenes

The order and length of each scene are set in [`src/DemoVideo.tsx`](src/DemoVideo.tsx). Scenes fade into each other (20 frames).

| # | Scene | File | Length |
| --- | --- | --- | --- |
| 1 | The problem | `ProblemStatement.tsx` | 3 s |
| 2 | Logo and tagline | `Intro.tsx` | 3 s |
| 3 | Any community can enter | `ClipScene.tsx` + `public/hook.mp4` | 5 s |
| 4 | Scoring mode and rounds | `ClipScene.tsx` + `public/mekanik.mp4` | 5 s |
| 5 | Winner takes the losing tokens | `ClipScene.tsx` + `public/payoff.mp4` | 5 s |
| 6 | Built on NEAR | `NearTech.tsx` | 5 s |
| 7 | App demo (placeholder) | `AppDemoPlaceholder.tsx` | 4 s |
| 8 | Links | `CtaOutro.tsx` | 4 s |

Brand colors and font are in [`src/brand.ts`](src/brand.ts), taken from `web/src/app/globals.css`.

## Adding the app demo recording

1. Put the screen recording at `public/app-demo.mp4`.
2. Follow the comment at the top of `src/scenes/AppDemoPlaceholder.tsx`.
3. Set `APP_DEMO_DURATION` in `src/DemoVideo.tsx` to the clip length in frames (seconds x 30).

## Keeping the copy accurate

On-screen claims must match [docs/current-state.md](../docs/current-state.md). The "Built on NEAR" scene only describes what exists in the repo: the Rust arena contracts, Chain Signatures code for cross-chain custody, and autonomous player agents that choose plays with NEAR AI Cloud. Update the scene if that changes. Links shown at the end are in the `LINKS` constant of `CtaOutro.tsx`.

## Assets

`public/hook.mp4`, `public/mekanik.mp4` and `public/payoff.mp4` are AI-generated clips (Higgsfield image-to-video). `public/valtrum-logo.png` is a copy of `web/public/brand/valtrum-logo.png`.

## Remotion version

All `@remotion/*` packages must have the same version. They are pinned to 4.0.542.
