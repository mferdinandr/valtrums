# Kinetic Arena

> Historical notes for the earlier graphite/mechanical redesign. The current
> Token Carnival implementation, route matrix, GLB pipeline and verification
> limits are documented in [CARNIVAL-UI.md](CARNIVAL-UI.md). The old Machine and
> BattleMachine renderers referenced below have been replaced.

Local UI redesign of the existing Valtrum application. No deployment, migration, contract change or new economic feature is included.

## Visual system

Graphite surfaces, lime accents, muted lavender for the opposing side, Space Grotesk headings and Inter body copy. The procedural arena uses matte metal, raised token podiums, illuminated perimeter markers and orbital rings. Models are authored in `src/components/kinetic/machine.tsx`; there are no downloaded models, external textures or runtime model-generation dependencies.

React Three Fiber / Three.js render the scene, Drei provides rounded geometry and lines, and GSAP animates route entrances. Geometry is deterministic. Important information and controls are HTML, independent of WebGL.

## Routes

| Route           | Scene / camera                                                 | User interaction and content                                                                                                                |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | Interactive practice chamber; elevated perspective             | Wallet-free scripted walkthrough, mechanics, current economics and entry to `/arena`. Fictional tokens and a disclosed fixed result.        |
| `/arena`        | Two token sculptures on an orbital arena; elevated perspective | Existing battle list, status filters, create and portfolio links, moved from the former home route.                                         |
| `/battles/[id]` | Interactive two-contender chamber; selection-following camera  | Podium selection, animated vault preview, review and verified-position feedback, alongside existing battle data.                            |
| `/battles/new`  | Assembly rings around the token sculptures                     | Existing two-token proposal, duration and configured bond.                                                                                  |
| `/terminal`     | Rotating mechanical core and orbital rings                     | Existing command, preview, funding, confirmation and session-key controls. The core does not imply autonomous agent capability.             |
| `/portfolio`    | Three mechanical vault sculptures                              | Existing balances, credit, positions, claim, refund, funding and withdrawal. Vault sculptures are decorative, not a count of actual assets. |

The shared route frame keeps non-home scene instances mounted between related routes. Home has its own larger composition. Each route is independently addressable.

## Motion and fallback

- Token spin and levitation, perimeter rotation, core/vault motion and subtle pointer parallax.
- GSAP route entrance; card and button hover/press transitions.
- A pause/resume button controls each sculpture. System reduced-motion preference stops scene motion and CSS/GSAP transitions.
- Offscreen and background-tab scenes switch to on-demand rendering. DPR is capped at 1.5; no shadow maps, postprocessing, fetched textures or environment maps.
- WebGL detection, context-loss handling and a React error boundary preserve the orbital illustration and the full HTML application if 3D fails.
- Portrait compositions put content before a fixed-height scene. Demo provenance remains visible on mobile.

## Feature boundary

This redesign uses the current frontend `ArenaApi`: A/B communities, configured durations and bond, existing settlement/credit behavior and existing terminal authorization. It does not expose planned multi-community rounds, overtime, four scoring modes, DAO voting, autonomous agent management, or Robinhood payout states.

The NEAR adapter currently returns no spot-price feed. Existing unavailable-data displays are retained. Simulated data is labeled demo data; browser transaction checks use the mock provider, not a live wallet.

## Verification

### Motion and usability polish

- Graphite-blue neutral surfaces and brighter muted text separate the lime/lilac teams from their surroundings. Shared buttons use bounded color/press transitions; touch controls have a 44px minimum height.
- Camera gaze and position ease together. Available podiums lift on hover with a pointer cursor and damped rim light; small fasteners and ventilation slots give the vaults clearer construction. Capsule-side movement is damped. Battle bobbing uses accumulated active time to avoid elapsed-clock jumps after an inactive interval.
- The live timer reveals a fixed ring geometry instead of allocating new geometry for every progress update. It remains tied to provided progress, not invented price data. Tab visibility and viewport intersection are tracked independently.
- Practice steps have an explicit progress indicator, selected checkmark, reserved content height, and brief entrance transition. Keyboard focus proceeds from Load to Start to the result link without scrolling the user away. Reduced motion removes the entrance and hides the unnecessary animation toggle. Locked scenes no longer invite podium selection.
- Chromium QA: 1440 × 1000 desktop and 390 × 844 mobile; complete practice cycle, pause/resume, keyboard progression, reduced-motion cycle, forced no-WebGL cycle, and mobile overflow checks on Arena, Battle, Create, Portfolio and Terminal. Screenshots: `polished-landing-desktop.png`, `polished-live.png`, `polished-landing-mobile.png`, `polished-battle-mobile.png` in `output/playwright/`. Production build and all 172 existing tests passed. This is functional/visual verification, not a physical-device frame-rate benchmark.

### Landing page

The home route introduces Valtrum without requiring a wallet. Its six-second practice sequence is isolated React state: choose a fictional tribe, load capsule previews, start the shortened round, see the disclosed scripted LIME win, and reset. No wallet methods or transaction APIs are called. The result explains both winning and losing choices; it is not market data or a real battle.

The list moved to `/arena`; navbar, empty-state, battle-not-found and proposal-success links now point there. A nonblocking split-door arrival plays once per session in the arena lobby, with reduced-motion support. Direct access remains available.

Landing QA: Chromium at 1440 × 1000 and 390 × 844, complete practice result, losing-side explanation, reset during a round with timer cleanup, no transaction requests during practice, arena navigation and return home, reduced motion and no-WebGL controls. Screenshot artifacts are `landing-desktop.png`, `landing-mobile.png`, and `landing-demo-result.png` under `output/playwright/`. Build and the existing 172 web tests passed.

### Interactive battle update

Battle detail now replaces its decorative hero with a playable chamber. Podium selection updates the actual deposit side, selected podium elevation and camera framing. The two HTML selector sets provide equivalent touch and keyboard controls and respect existing account-side locks. A short GSAP split-door entrance introduces the chamber, with a camera dolly and staggered control-panel reveal; it never intercepts input or scrolling and is skipped for reduced motion.

| Trigger                          | 3D response                                             | Actual state / alternative                                    |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Select podium or button          | Camera follows selection; podium rises                  | Deposit token changes; unavailable sides remain locked        |
| Valid amount                     | Vault lid opens; translucent capsules orbit             | Explicit preview, no send                                     |
| Review                           | Preview remains visible                                 | Amount and side locked; Edit returns to input                 |
| Confirm                          | Capsules wait in orbit                                  | Existing wallet/API call runs                                 |
| Position credit verified         | Capsules enter vault and lid closes                     | Successful call plus matching-side position increase required |
| Call succeeds, credit unverified | No success capsule sequence                             | Submitted message asks the player to inspect their position   |
| Error                            | Capsules disperse                                       | Error remains visible; no payment claim                       |
| Live / settled / halted          | Real interval ring / winner podium lift / stopped rotor | No simulated score or invented winner                         |

Active battle state is refreshed every 10 seconds through the existing read API. Mobile, reduced motion, pause and WebGL fallback retain the deposit controls. New Playwright checks exercised actual mesh selection, side-lock behavior, review/confirm, invalid amount, verified mock credit and closed-deposit statuses. A Drei HTML label cleanup error observed during QA was removed by using locally generated token-label textures.

- Web tests: 12 files, 172 tests passed.
- TypeScript and production build passed.
- Playwright Chromium: all five primary routes rendered at 1440 × 1000 and 390 × 844 with a WebGL canvas and no document horizontal overflow.
- Mock browser flows: wallet connection, token deposit, battle proposal, terminal preview/cancel, claim, refund and withdrawal.
- Pause/resume, system reduced-motion rendering, and forced no-WebGL fallback were exercised. Terminal preview remained usable with WebGL unavailable.
- Screenshots are saved under `output/playwright/` at the repository root.
- Real wallet/network execution and physical low-end-device performance are not verified. Three.js emits a dependency-level Clock deprecation warning in development; no runtime failure was observed from it.
