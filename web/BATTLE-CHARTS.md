# Battle charts

The integrated 3D battle arena, view-only multi-community demo and wallet battle page
share a lightweight SVG chart. It supports community selection, sample inspection
by pointer or keyboard slider, an accessible legend, and an expanded native dialog.
Selecting a chart never changes a deposit amount, deposit side, score or winner.

## Scripted sample fixtures

`colosseum/score-series.ts` produces explicitly scripted visual sample series from
the same fixture endpoint scores used by the existing round resolver. Gain/growth
series can change provisional leaders; volume is cumulative, and maximum drawdown
is nondecreasing. Every complete endpoint matches the fixture score. Volume is
displayed as 100 × round quote volume / initial market cap, and lower drawdown is
better. No random values, market feed or financial authority are introduced.

The plot reveals only samples up to the exhibition clock, uses a fixed per-mode
vertical domain and resets baselines each overtime round. Eliminated participants
have no new-round observations. Missing close evidence is a null endpoint, which
breaks the line and suppresses a result. Verified scores and outcomes still come
from `roundAt` and its integer/rational resolver, never the floating-point chart.

The chart legend uses the same selected community as the integrated 3D arena. A display-only
leader field highlights that participant's reactor with a colored ring, without
changing character targeting or resolution. Reduced motion removes ring pulsation
and leader-change animation. Pausing the exhibition freezes the chart clock.

The chart appears beneath the 3D viewport in the battle detail page on desktop
and mobile. Expand provides a larger native modal view. There is no separate
exhibition route or start button; the former `/arena/preview` route redirects
to the battle list. Pure fixture overtime helpers remain test/demo utilities,
not an authority for recorded battle outcomes.

## Current wallet battle

The legacy API has initial/final contract prices and an optional spot-price method,
not observation history. The NEAR adapter currently returns null for spot prices.
The page therefore plots disconnected start/available-snapshot markers, without
inventing timestamps or intermediate price movement. Missing observations remain
missing. Mock adapter snapshots are labeled simulated, and spot snapshots disclose
that provider timestamps are unavailable. The existing spot call is refreshed every
ten seconds during Live; superseded requests use the existing useAsync cancellation
guard. No new endpoint, history cache or database migration is added.

After deposits close, chart selection highlights the corresponding scene vault.
While deposits are open, the transaction form and scene retain their existing
selected/locked side. Chart inspection cannot switch the user's deposit side.
Recorded winner/status takes precedence over provisional chart comparisons.

## View-only multi-community demo

Its chart is a separately labeled fixture aligned to the demo's elapsed clock.
It stops at thirty seconds and does not calculate or submit the demo battle's
result. Communities are matched by exact demo-token ID. If the roster cannot be
matched completely, the chart shows missing observations rather than inventing
mascots/scores. All deposit/payout limitations of this page remain intact.

## Verification

Unit checks cover missing-data line gaps, negative/tied and lower-is-better display
comparisons, snapshot-only behavior, final-price precedence, all four fixture
endpoints, monotonic volume/drawdown, fresh overtime baselines and missing close
evidence. Production build checks TypeScript and routes. No Playwright/browser QA
was run; overlay composition, touch and expanded-dialog runtime need visual review.

## Lifecycle observation chart (issue #146)

`battle-chart/observation-chart.tsx` charts persisted observation evidence served by
`GET /api/arena/v1/battles/{id}/observations` and is shown from the application battle list
for locked and decided battles. It draws only what the backend returned: plotted points sit at
the provider's observation time; a missing start sample means no baseline (no values), a missing
close sample or a reported coverage gap is a null point that breaks the line, and samples without a
provider time are counted but not plotted. Exact provisional scores are listed as fractions from the
backend; float chart coordinates are display geometry only. The contract's recorded winner is a
separate line and a provisional leader never changes it. The source label (fixture, recorded or
live) is taken from the samples. If the observation service is unavailable the component shows that
and no sample data; it never falls back to the scripted demo series. Polling is cancel-safe delta
polling (default two seconds, a display choice and not the provider's cadence); a revision change
reloads the evidence, and hiding the tab pauses only these refreshes.

While a round is live, lines are played back behind the newest sample so they draw continuously at
real-time speed instead of jumping once per sample. The delay follows the widest recent gap between
samples plus 0.6 s (1.2 to 4.5 s). Between two recorded samples the line head moves along the straight
segment joining them; nothing is drawn past the newest sample, and if samples stop, playback eases
into the newest one and rests there.

When the tokens' exact scores differ at all (even in the 13th or 14th decimal), the chart switches to
the race view: the leader sits on the top line and every other token is drawn below by how far it
trails (computed from exact integers, magnified on an eased asinh scale). Legend chips show up to 14
decimals in a column reserved at full width from the start, so they never resize. The legend, leader text and recorded winner
always use the newest data, not the delayed drawing. Once a winner is recorded (or with reduced motion)
the full evidence is shown at once.
