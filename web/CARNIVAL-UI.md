# Token Carnival — site-wide UI

The visual system uses cream paper, coral actions, mint/lilac accents and original
toy mascots. A full landing world and six generated GLB installations replace the old
mechanical illustrations. The existing Next/React/R3F/GSAP stack is preserved.

## Route and scene matrix

| Route             | Goal and layout                                                                                                 | Local 3D subject                                                         | Interaction / alternative                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `/`               | One full-screen journey from arrival to the final town vista; no subsequent landing sections or separate footer | Connected plaza, animated Create Battle machine, arena and cutaway Vault | Chapter controls, skip to final vista, HTML links and in-world field notes |
| `/arena`          | Fairground introduction, lineup toolbar, existing status/search controls and ticket-like cards                  | Arch, schedule board, toy hosts                                          | Normal battle links; illustration conveys no eligibility                   |
| `/battles/new`    | Form workspace beside assembly host; token/duration inputs and bond review remain intact                        | Workbench, capsule docks, assembly arm, wrench                           | Existing proposal flow and wallet confirmation                             |
| `/battles/[id]`   | Community booth beside deposit/review controls, status and actual vault data below                              | Two hinged toy vaults, identity-specific mascot or generic token emblem  | Existing side lock and deposit phases; HTML selector alternatives          |
| Demo multi-battle | View-only community/vault cards with decorative fairground                                                      | Toy stage                                                                | Existing simulated timing; no invented result or new financial action      |
| `/terminal`       | Main command/review area with a separate help kiosk and session settings                                        | Smiling monitor, keyboard, joystick and speech bubble                    | Existing terminal parser, funding review and explicit confirmation         |
| `/portfolio`      | Cabinet introduction, separate credit/liquid columns, funding and position cards                                | Hinged keepsake cabinet and shelves                                      | Existing claim/refund/withdraw and wallet checks                           |
| `/arena/preview`  | Existing standalone carnival exhibition                                                                         | Toy mascots, personal spring targets, festival stage                     | Isolated scripted fixture; no actual battle integration                    |

## Data boundaries

The current wallet arena still uses its existing two-community proposal, audit,
deposit, bond, settlement, claim, credit and withdrawal contracts. The landing
separates that experience from the wallet-free multi-community exhibition and
the planned Robinhood/DAO flow. Decorative hosts are not selected communities;
cabinet coins are not account amounts. Actor identity in actual battle booths
requires an exact known demo-token ID; unknown IDs receive a generic emblem with
the actual symbol rather than a falsely assigned mascot. Source-chain production
registry integration remains deferred.

Deposit visual responses retain preview/review/pending/submitted/success/error
phases. Success comes from the owning form's verified position-credit check.
Lids and capsules do not assert credit independently. The live interval ring
uses provided recorded progress and does not imply live price observations.

## Assets and motion

Generate originals from the repository root:

- `node web/scripts/build-colosseum-assets.mjs` — five mascot GLBs.
- `node web/scripts/build-carnival-props.mjs` — welcome, arena, create, terminal,
  portfolio and battle installations, with a transfer/triangle manifest.
- `node web/scripts/build-landing-world.mjs` — the separate full-size landing
  environment, Create Battle installation and Vault, with movable pivots and a
  size/triangle manifest. Outputs three independently loadable GLBs.

Static parts are merged by material within movable pivots, then duplicate
vertices are indexed. Triangle counts and animation tracks are retained; current
page props and mascots are roughly 0.2–0.63 MB each, without external texture or decoder fetches.
The renderer clones node hierarchies while sharing cached geometry/materials.
Each mascot instance owns its mixer; mixers stop on unmount. The old Machine
and BattleMachine renderers have been removed. KineticScene is a compatibility
entry point for current feature components.

Scenes load near the viewport, defer heavy modules, respect system reduced
motion, offer pause, and use demand rendering offscreen or in hidden tabs. The
important controls and explanations remain semantic HTML. WebGL/context/asset
failures fall back to a static ticket illustration. Page routes remain directly
navigable; no cinematic intro gates a form or transaction.

## Landing journey

The landing uses a twelve-viewport native scroll rail (8.5 on mobile) with a sticky full-screen
canvas and semantic HTML hero text. Camera positions follow bounded, reversible
scroll progress: arrival, gateway, community plaza, Create Battle, arena overlook,
Vault, then a final town vista. The full landing remains within this one renderer;
the old lower sections are removed and the shared footer is hidden only on home.
Gates open
before the camera passes them. CASHCAT and WIF accompany the middle section,
then follow curved footpaths to separate spring reactors in the overlook. Each
demonstration is cosmetic and affects no other community. BTCETHUSDT walks to
the Create Battle machine and gently animates its three modules; REBATE takes
a curved route behind the booths to the Vault, with receipt/halo motion. OAK
remains in the plaza. Their existing GLBs are reused,
while the environment is a new original GLB, generated without Blender.

The shell is 1,967,164 bytes, 63,742 triangles and 51 meshes. The Create Battle
zone is 300,272 bytes, 8,756 triangles and 23 meshes. The Vault is 521,752 bytes,
16,968 triangles and 24 meshes. Zone loading starts earlier in the journey and
each zone remains mounted once requested. Suspense shows a labeled preparation
platform if the user reaches a zone before its asset is ready. Static parts
are batched by material across the world, preserving movable groups. The canvas
loads on first visibility, caps DPR at 1.3 and pauses ambient rendering offscreen.
The camera uses a continuous cubic path with shared waypoint velocities and a
short 110 ms exponential response to soften wheel steps. Deliberate fixed vistas
at the plaza, Create Battle machine, arena and Vault give visitors time to watch
the hosts. GSAP staggers semantic text reveals without controlling document scroll.
Hosts walk only
while their position changes, face their direction of travel (including reverse
scroll), and take the shortest rotation toward their next heading.
Chapter buttons use normal scrolling; navigation and Skip journey remain available.
Pause freezes ambient motion while camera movement stays under scroll control;
the demand renderer wakes only until the new scroll position settles.
Reduced motion or a viewport at most 500 pixels high replaces the scroll journey
with normal stacked content and one
fixed vista. A local SVG illustration stays visible during loading or on rendering
failure; text and destination links work independently of the canvas. Rendering
failure also switches the chapters to normal document flow.

Current rules and the target roadmap are available in a native modal dialog above
the world. Escape/close restores access to the scene, body overflow is restored,
and ambient rendering pauses while the notes are open. Existing `#product-flow`
and `#mechanics` links open their corresponding notes; `#welcome-details` moves
to the final vista. The current two-community/bond/credit wallet flow remains
distinct from the scripted preview and planned multi-community Robinhood/DAO flow.

| Trigger                            | Visible response                                                              | Keyboard / touch alternative                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Native scroll                      | Camera follows the path, gates open before entry, hosts move between stations | Chapter buttons select the same destinations; native touch scroll remains available |
| Plaza / overlook section           | Camera holds a vista while ambient activity continues                         | Pause stops the ambient activity; preview link is ordinary HTML                     |
| Mascot selection                   | Selected mascot greets the visitor and its description updates                | Matching HTML buttons expose pressed state and a text description                   |
| Skip / route link                  | Moves to the final vista or opens the selected app route                      | Always available without completing the journey                                     |
| Reduced motion / rendering failure | One fixed vista or illustration with all chapters stacked                     | All copy and links remain available in document order                               |

## Verification limits

Validation uses the production build, TypeScript, existing unit tests and GLB
contract tests (binary structure, local buffers, indexed geometry, size budget
and movable-node names). No Playwright or other browser QA was performed for
this redesign, per the user's request. Desktop/mobile layouts, camera composition,
physical-device performance and real-wallet flows need visual/runtime review.
