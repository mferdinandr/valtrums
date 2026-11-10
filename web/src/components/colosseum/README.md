# Token Carnival × Toybox — stage 2

Open `/arena/preview` directly or use the preview link on `/arena`.

This is an isolated multi-community exhibition with five token-inspired GLBs,
2/3/5-participant rosters, and a six-unit layout fixture (one synthetic unit).
It includes 30-second rounds, four mode-specific score fixtures, repeated
leader-only overtime, elimination, evidence-pending, history, overview/follow
camera, pause and replay. It does not call wallet methods or battle APIs.
Live observations, financial integration and production identity resolution
belong to stage 3. All participants here are exhibition fixtures, not approvals.

The current art direction is a cream/pastel festival with matte toy mascots,
personal spring-mounted reactor stations, balloons, community signs and spectator
benches. Mascots have round silhouettes, faces, blink/wave clips and short
selection hops. Eliminated participants sit at the perimeter; a short confetti
celebration follows the verified fixture winner. Reduced motion suppresses hops,
station bounce, projectiles and confetti.

There is no player-versus-player damage: every actor targets only its own arena
station (`challengeAt(owner, count)`). Station impacts are cosmetic choreography;
they never change a score, lower a rival's performance or select a winner. Real
market-driven visual intensity remains deferred until reliable live data is
integrated. The UI explicitly separates this activity from the fixture scores.

Use **Exhibition setup** before starting to select roster, score mode, scenario
and playback speed. At 1× a round takes 30 real seconds; 3× is explicitly labelled
and takes 10 real seconds. The roster and mode controls disappear after start.
The default repeated-tie fixture resolves over three rounds: leaders tie in round
1, tie again with fresh scores in round 2, and a unique winner emerges in round 3.
The fixture resolves then; the leader resolver has no overtime cap. The pending
scenario stops at the boundary until **Supply demo evidence** is selected.
Missing evidence never becomes a zero, elimination, win, payout or refund.
Eliminated characters retreat to spectator benches and stop their challenges. All
original vaults stay visibly locked through overtime. Scores are revealed only
after fixture verification; they are not live market observations. Ranking uses
exact integer rational comparison, including signed gain/growth and lowest
drawdown ordering. Volume scores are percentages of initial market cap.

## Token identity and visual source

`characters.json` is the shared cosmetic definition used by the generator and UI.
It records the frontend demo token ID separately from the Robinhood mainnet
reference chain/address. Neither reference identity nor a model grants approval.

| Character  | Source                               | Original visual interpretation                                    |
| ---------- | ------------------------------------ | ----------------------------------------------------------------- |
| CASHCAT    | Research address + `cashcat.demo`    | Round cat, oversized paws, whiskers and curling tail              |
| BTCETHUSDT | Research address + `btcethusdt.demo` | One four-legged capsule robot with three colorful modules         |
| OAK        | Research address + `oak.demo`        | Little walking oak, round canopy, leafy mittens and root feet     |
| REBATE     | Research address + `rebate.demo`     | Smiling cash register, receipt scarf, candy buttons and coin halo |
| WIF        | Research address + `wif.demo`        | Friendly hatdog, oversized ribbed hat and pom-pom                 |

These are original art concepts, not verified official mascots. The November 7
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

Contender buttons duplicate mesh selection. Intro is skippable. Pause freezes
the exhibition clock; hidden tabs suspend it. Reduced motion skips the intro,
holds model poses and disables projectiles/impacts; the script and result remain
available in DOM. WebGL or asset failures switch to a semantic command view with
the same selection/start/reset controls and retry. No audio or camera shake.

Before the user requested stopping Playwright, the previous industrial version's Chromium checks covered desktop
1440×1000, mobile 390×844, roster switches (2/3/5/6), first overtime and the full
three-round result. No further browser testing is performed after that request.
The carnival redesign has not been visually tested in a browser, per request.
Physical low-end-device frame rates and real wallet/network behavior
are not verified. Unit tests cover finite poses for all modes/roster sizes,
exact ties, signed comparisons, drawdown, repeated overtime, no eliminated
re-entry, pending evidence, personal target ownership, no rival damage, score
independence from visual state and binary GLB/animation/identity checks.
