# Integrated 3D battle arena

Open `/arena`, choose a battle, and follow its 3D scene and chart on the detail
page. There is no separate Play 3D menu. `/arena/preview` redirects to `/arena`.

`battle-arena.tsx` supplies the reusable viewport, overview/follow cameras, visual
pause, fullscreen, community selection, chart and loading/failure alternatives.
Gathering legacy battles retain their existing vault/deposit UI, then use this
arena when live, settling or finished. The multi-community demo uses the same
arena with explicitly simulated battle state. The old standalone exhibition UI
and stylesheet have been removed.

`battle-runtime.ts` adapts the recorded status, start/end interval and settled
winner into an external round snapshot. This overrides all exhibition resolution:
clock expiry cannot invent overtime, elimination, a score or a winner. Current
legacy A/B durations are preserved. Missing results remain pending; halted and
voided battles do not celebrate. A read-only cosmetic clock can pause without
pausing backend time or changing a deposit selection.

Character mapping uses exact demo-token IDs. Unknown contracts receive a neutral
3D token emblem with their actual symbol, never another token's mascot merely
because its ticker matches. Backend reference-registry integration remains deferred.

The current art direction is a cream/pastel festival with matte toy mascots,
personal spring-mounted reactor stations, balloons, community signs and spectator
benches. Mascots have round silhouettes, faces, blink/wave clips and short
selection hops. Eliminated participants sit at the perimeter; a short confetti
celebration follows the recorded settled winner. Reduced motion suppresses hops,
station bounce, projectiles and confetti.

There is no player-versus-player damage: every actor targets only its own arena
station (`challengeAt(owner, count)`). Station impacts are cosmetic choreography;
they never change a score, lower a rival's performance or select a winner. Real
market-driven visual intensity remains limited to available chart observations.
The selected chart community and a provisional leader ring are visual indicators,
not inputs to scoring or settlement.

Pure exhibition fixtures remain in `choreography.ts` and `score-series.ts` for
testing and the labeled demo chart. They exercise four modes, exact ties, repeated
overtime and missing evidence, but do not control a recorded battle. No new
financial behavior or backend scoring integration is implied by this renderer.

## Token identity and visual source

`characters.json` is the shared cosmetic definition used by the generator and UI.
The visible roster is now CASHCAT, WALLET, GOOD, VLAD and DEGEN (AI, Affair Inu, is hidden
since it left the joinable allowlist, D35),
matching the reference identities in the existing testnet registry. Lifecycle
matching uses chain/address, never ticker or roster position. WALLET is a stitched
pocket explorer; GOOD a sunshine pal; AI an Inu with a heart scarf; VLAD a forest
archer; DEGEN a violet top-hat showman. These five are original thematic designs,
not verified official logo reproductions. Each GLB embeds seven animation clips.
Legacy BTCETHUSDT, OAK, REBATE and WIF files remain on disk and in the generator
catalog with `hidden: true`; all displayed rosters use filtered `CONTENDERS`.
The historical artwork notes below describe the preserved legacy collection.
It records the frontend demo token ID separately from the Robinhood mainnet
reference chain/address. Neither reference identity nor a model grants approval.

| Character  | Source                                       | Original visual interpretation                                           |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| CASHCAT    | Contract-matched listing + `cashcat.demo`    | White/gray cat, large glossy eyes, pale paws and soft worried expression |
| BTCETHUSDT | Contract-matched listing + `btcethusdt.demo` | Gold coin with sunglasses, big grin, arms, white gloves and red sneakers |
| OAK        | Contract-matched listing + `oak.demo`        | Dark green canopy, branching wooden limbs, root feet and golden veins    |
| REBATE     | Contract-matched listing + `rebate.demo`     | White extruded R, violet return arrow, small face and toy limbs          |
| WIF        | Unverified interpretation + `wif.demo`       | Temporary hatdog; logo for the recorded contract has not been verified   |

Listing artwork was visually reviewed on November 10; URLs/status are recorded in
`characters.json`. Four models are original 3D adaptations, not official supplied
artwork or proof of authenticity. WIF remains explicitly unverified. The November 7
research in `docs/findings-and-decisions.md` describes potential pass for CASHCAT
and BTCETHUSDT, and blocked v4 liquidity verification for OAK. It explicitly does
not authenticate the tokens or establish present approval. REBATE has blocked
v4 liquidity verification and WIF has missing tax fields in that research.
Legacy PEPE/SHIB deployments and extra frontend mock tokens do not
define a production roster. Product/OpenSpec and `contracts/arena/src/lifecycle.rs`
identify participants by chain and contract, with audit/backing gates, rather
than a fixed symbol whitelist. Backend identity integration is deferred.

## Assets

Generate from the repository root:

`node web/scripts/build-colosseum-assets.mjs`

The generator uses Three.js and GLTFExporter, without Blender, external models,
textures or credentials. Output: `web/public/models/colosseum/*.glb` and a size/
triangle/mesh/animation manifest. Models contain PBR materials, rigid articulated
node hierarchies and embedded Idle, Attack, Selected, Victory, Defeat and Walk
clips. An unused Hit clip remains available for compatible asset consumers;
the carnival never plays rival-hit reactions. This is rigid toy articulation,
not a skin-weighted humanoid rig. Static geometry is merged by material within
each animated pivot. The frontend loads actual GLBs with useGLTF/GLTFLoader and
plays their clips through AnimationMixer. Choreography supplies stage placement
and impact timing. Shared cached geometry is retained on instance unmount;
instance mixers are stopped on unmount and released with their component.

## Controls and fallbacks

Community buttons duplicate mesh selection. A brief pointer-transparent entry
fade does not block controls or delay recorded state. Pause freezes only cosmetic
motion; hidden tabs suspend it. Reduced motion skips the fade, holds model poses
and disables projectiles/impacts. WebGL or asset failures leave the same community
buttons, chart, recorded status and financial controls available. No audio or
camera shake. Highlighting a community cannot alter the deposit form's locked side.

Before the user requested stopping Playwright, the previous industrial version's Chromium checks covered desktop
1440×1000, mobile 390×844, roster switches (2/3/5/6), first overtime and the full
three-round result. No further browser testing is performed after that request.
The carnival redesign has not been visually tested in a browser, per request.
Physical low-end-device frame rates and real wallet/network behavior
are not verified. Unit tests cover finite poses for all modes/roster sizes,
exact ties, signed comparisons, drawdown, repeated overtime, no eliminated
re-entry, pending evidence, personal target ownership, no rival damage, score
independence from visual state and binary GLB/animation/identity checks.
