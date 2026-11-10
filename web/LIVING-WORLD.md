# Valtrum living world — implementation handoff

The home route is one persistent full-screen 3D journey. The previous standalone
feature cards, mechanics sections, roadmap block and finale below the canvas
have been removed. Their useful information lives in the journey or field notes.
The shared footer remains on other routes; home includes its links/context in the
final overlay. No wallet, backend, settlement or schema behavior is changed.

## Delivered sequence

| Scroll interval | Place           | Camera / object response                                               | Existing destination                                           |
| --------------- | --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0–12%           | Arrival         | Elevated town view, hero in the sky, camera approaches entrance        | Arena and standalone 3D preview                                |
| 12–25%          | Gateway         | Hinged gates open before crossing; CASHCAT/WIF walk into the plaza     | Direct navigation remains available                            |
| 25–40%          | Community plaza | Fixed vista, original five mascots, selectable descriptions            | Mascot selection is decorative; not a token eligibility check  |
| 40–54%          | Create Battle   | Two capsules approach, assembly arm moves, gear turns, receipt extends | Existing two-contract/duration/bond proposal form              |
| 54–73%          | Arena overlook  | Two hosts act on separate personal spring reactors                     | Existing Arena / scripted preview                              |
| 73–89%          | Your Vault      | Door unlocks/opens, then claim and withdraw drawers extend separately  | Portfolio and Terminal                                         |
| 89–100%         | Final vista     | Wide town composition; ambient life continues at the end               | Arena, preview, Create Battle, Portfolio, Terminal and roadmap |

Chapter navigation and Skip journey use native window scrolling. No wheel handler,
body lock or forced completion controls the main journey. Body overflow is locked
only while the field-notes modal is open, then restored on close or route unmount.

## Visual and asset work

- Existing cream/coral/mint/lilac system, matte surfaces and soft daylight.
- Original GLB environment plus independent Create Battle and Vault GLBs, authored
  in the checked-in Three.js generator without Blender or external downloaded art.
- Connected paths, signposts, inset markers, visible internal machinery, capsules,
  conveyor rollers, gripper, gear teeth, ticket slot, interior shelves and drawers.
- Capsule glazing is translucent. Structural materials are shared, static geometry
  is indexed and batched, while animated pivots remain independently addressable.
- Five existing mascot GLBs and embedded animation clips are reused. Host position
  is a pure function of scroll, allowing forward/backward travel. Walking responds
  to actual displacement; heading uses the shortest angular path.
- BTCETHUSDT has three alternating modules, REBATE has receipt/halo motion,
  CASHCAT has tail motion, WIF uses its existing toy animation and OAK its idle/greeting.

Generate with `node web/scripts/build-landing-world.mjs` from the repository root.
See `public/models/carnival/landing-world.manifest.json` for generated asset costs.

## Renderer and controls

One R3F canvas owns the bounded cubic camera path, shared damped scroll state,
ambient clock, shadow lighting, cloned asset hierarchies and independent mascot
mixers. Adjacent chapter poses share velocity; deliberate repeated poses create
fixed vistas. The camera horizon remains stable. The response to wheel steps is
110 ms exponential damping, with delta capped for a resumed/slow frame.

GSAP animates chapter text, without overriding the camera or native scroll. All
headings, descriptions, selection buttons and route actions are semantic HTML.
Building sign meshes have matching HTML actions. The chapter strip scrolls its
active item into horizontal view without moving the document vertically.

Detailed zones request their assets in advance of their chapter. They show a
labeled preparation platform during loading, rather than a fake percentage or
claim that loading is guaranteed seamless. Rendering/asset failure switches to
the local SVG illustration and readable normal document flow.

The canvas caps DPR at 1.3, uses one shadow light/map, avoids postprocessing, and
uses demand rendering while paused, hidden, offscreen or in simplified mode.
Cached geometry/materials are shared; each mascot instance owns and stops its mixer.

## Responsive and accessibility behavior

| State                              | Behavior                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Desktop                            | Twelve viewport scroll rail; side-aligned annotations leave the scene visible                               |
| Portrait <=700px wide              | Shorter 8.5 viewport rail, pulled-back camera, bottom annotations and horizontally scrollable chapter strip |
| Viewport <=500px high              | Simplified still view with all chapters in normal readable flow                                             |
| Reduced motion                     | Still vista, no ambient animation, no GSAP reveals, all chapter content available                           |
| Ambient pause                      | Character/prop clock freezes; camera can still settle toward user-selected scroll position                  |
| Field notes open                   | Native modal focus handling/Escape, scene paused, readable scrollable notes                                 |
| Keyboard                           | Direct links, chapter/skip controls, mascot buttons, visible focus styles and native modal close            |
| Unsupported WebGL or asset failure | Local illustration; all feature explanations and destination links remain available                         |

`#product-flow` and `#mechanics` open target/current notes respectively. The legacy
`#welcome-details` target moves to the final scene instead of a deleted section.

## Verification and limits

Unit checks cover reversible/bounded scroll, camera corridor clearance, finite
positions, continuous waypoint velocity, deliberate vista holds, damping at
30/60/120 Hz, host clearance around the central hub and community booth, separate
reactor endpoints, self-contained GLB buffers, movable node contracts and budgets.
The production build checks TypeScript and page generation.

No Playwright or other browser automation is used, as requested. The responsive
rows above describe implemented behavior, not tested-device claims. Camera
composition, real-device frame rate, touch/keyboard runtime behavior and wallet
flows still require visual/runtime review; passing unit tests cannot establish
those qualities. No deployment or new commit/push is included.
