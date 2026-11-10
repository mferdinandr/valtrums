# Lifecycle toy-world UX (issue 149)

The lifecycle routes `/arena`, `/arena/new` and `/arena/[battleId]` now share the
existing carnival visual system. The battle detail scene uses the published GLBs
and generic emblems through `RecordedArena`, also used by legacy battle detail.
There is no separate Play 3D flow or new rendering library/model format.

## Authority and interactions

| Trigger                        | Presentation                                     | Authority / fallback                                                     |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Open detail                    | Arena loads with crew roster and current round   | Lifecycle DTO only; no legacy conversion or fixture result resolver      |
| Recorded window opens          | Cosmetic reactor attacks and overview camera     | Only the recorded window/candidates; the wall clock cannot pick a winner |
| Window expires                 | Pending resolution                               | No synthetic overtime, history, scores or result                         |
| Recorded candidates change     | Eliminated crews move to benches                 | Tied-leader progression follows source records                           |
| Recorded winner appears        | Existing victory/defeat clips and short confetti | No change to rewards, held principal or transaction authority            |
| Highlight / follow             | Scene and DOM highlight a crew                   | Separate from participation community; keyboard buttons remain available |
| Pause / hidden tab / offscreen | Render animation pauses                          | Backend collection/state and DOM timers continue independently           |
| Reduced motion / WebGL failure | Static/fallback scene, readable controls/chart   | Essential reads and actions remain in DOM                                |

Model identity binds the source or committed reference chain/address. Unknown
contracts use a generic emblem; ticker similarity is never a mapping. WIF artwork
keeps its unverified interpretation label. Sixteen crews get wider spacing and an
expanded overview. These are source/layout checks, not measured visual quality.

## Wallet and data limitations

Preview scope binds account, deployment, request and exact reviewed call. Draft
changes invalidate old responses immediately, including A -> B -> A; guards run
before wallet authorization and broadcasting. A step unmount cancels its authority
to prompt. Position baseline is read before deposit authorization and credit reads
cannot overwrite another draft/action. No automatic broadcast retry is added.

The registry still lacks trusted representation/custody and decimal metadata.
Advanced setup stays explicit, and vault/deposit base units are never disguised
as token quantities. No smart contract, backend API or economic rule changes are
included. Real-wallet, FT storage/receipt/representation claim and live custody
handoffs remain open in issue 149.

## Verification

Unit checks exercise lifecycle candidates/window/outcome isolation, exact identity,
16-crew spacing and preview epoch/wallet guards. SSR checks exercise readable crew,
pending result, fixture and chart content before WebGL loads. Existing Brave e2e
assertions are updated for the human-readable copy; the suite is not run under the
user's no-Playwright instruction. Computer Use permission is unavailable, so camera
framing, touch, reduced-motion/WebGL failure and responsive visual composition
still need actual browser review.
