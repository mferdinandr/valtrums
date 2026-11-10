import { expect, test, type Page } from "@playwright/test";

/** Collects console errors and failed requests so a page that "renders" but is broken still fails. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test("battle list is searched on the backend and labeled as fixture data", async ({
  page,
}) => {
  const problems = watch(page);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/arena/v1/")) requests.push(r.url());
  });
  await page.goto("/arena");
  await expect(page.getByRole("heading", { name: /Battle #2/ })).toBeVisible();
  await expect(page.getByText(/fixture/i).first()).toBeVisible();
  expect(requests.some((u) => u.includes("/battles?"))).toBe(true);
  expect(problems.filter((p) => !/favicon|hydrat/i.test(p))).toEqual([]);
});

test("a locked battle shows recorded state, readiness blockers and never a timer winner", async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto("/arena/2");
  await expect(
    page.getByRole("heading", { name: "Biggest price climb" }).first(),
  ).toBeVisible();
  // The recorded window ended two minutes ago and no winner is recorded: it must say so, not pick one.
  await expect(
    page.getByRole("status").filter({ hasText: "Awaiting resolution" }),
  ).toBeVisible();
  await expect(page.getByText("recorded winner")).toHaveCount(0);
  await expect(page.getByText("fixture data").first()).toBeVisible();
  // Exact u64 vault stays exact.
  await expect(
    page.getByText("18,446,744,073,709,551,615", { exact: true }),
  ).toBeVisible();
  expect(problems.filter((p) => !/favicon|hydrat/i.test(p))).toEqual([]);
});

test("an open battle lists the specific reason a community is not ready", async ({
  page,
}) => {
  await page.goto("/arena/1");
  await expect(
    page.getByText(
      "The battle is still open for deposits; no round has started.",
    ),
  ).toBeVisible();
  await expect(page.getByText("no audit approval recorded")).toBeVisible();
});

test("a decided battle shows the contract's recorded winner", async ({
  page,
}) => {
  await page.goto("/arena/3");
  await expect(page.getByText(/Recorded winner: Crew 02/)).toBeVisible();
  await expect(
    page.getByText("recorded winner", { exact: true }),
  ).toBeVisible();
});

test("persisted observations draw a chart that leaves the missing close as a gap", async ({
  page,
}) => {
  await page.goto("/arena/2");
  await expect(
    page.getByRole("heading", { name: "Round observations" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Persisted observations · fixture/),
  ).toBeVisible();
  await expect(
    page.getByText(/community 3: no closing sample yet/),
  ).toBeVisible();
  await expect(
    page.getByText(/Provisional exact scores \(not a result\)/),
  ).toBeVisible();
  await expect(page.locator("svg[role='img']").first()).toBeVisible();
});

test("a backend outage is an explicit error with no demo data", async ({
  page,
}) => {
  await page.route("**/api/arena/v1/battles/2?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "arena-application-v1",
        error: {
          code: "upstream_unavailable",
          message: "read source unavailable",
        },
      }),
    }),
  );
  await page.goto("/arena/2");
  const alert = page.locator("[role=alert]", { hasText: "could not be read" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("No demo or legacy data");
  await expect(
    page.getByRole("heading", { name: "Biggest price climb" }),
  ).toHaveCount(0);
});

test("creation is review-only without a wallet and sends no action request", async ({
  page,
}) => {
  const problems = watch(page);
  const actionCalls: string[] = [];
  page.on("request", (r) => {
    if (
      r.url().includes("/api/arena/actions") ||
      r.url().includes("/api/arena/session")
    )
      actionCalls.push(r.url());
  });
  await page.goto("/arena/new");
  await expect(
    page.getByRole("heading", { name: /Bring your crews/ }),
  ).toBeVisible();
  const pickers = page.getByPlaceholder("Search registered token address");
  await expect(pickers.first()).toBeVisible();
  // Pick one registered asset per community from the backend-searched registry.
  for (const i of [0, 1]) {
    const card = page.locator("div.pixel-frame", {
      has: page.getByRole("heading", {
        name: `02 / Community ${i + 1}`,
        exact: true,
      }),
    });
    await card
      .getByRole("button", { name: /Token 0x/ })
      .nth(i)
      .click();
    await card.getByLabel(/Representation/).fill(`c${i + 1}.rep.testnet`);
    await card.getByLabel("Custody domain").fill("custody-e2e");
  }
  const review = page.getByLabel("Transaction review");
  await expect(
    review.getByText("create_lifecycle_battle").first(),
  ).toBeVisible();
  await review
    .getByText("Exact transaction arguments", { exact: true })
    .click();
  await expect(page.getByLabel("Exact arguments")).toContainText(
    '"mode": "PriceGain"',
  );
  await expect(page.getByText(/storage payment, not a stake/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect wallet to sign" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Nothing was sent|review-only|stays review-only/),
  ).toBeVisible();
  expect(actionCalls).toEqual([]);
  expect(problems.filter((p) => !/favicon|hydrat/i.test(p))).toEqual([]);
});

test("the battle detail does not overflow horizontally on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/arena/2");
  await expect(
    page.getByRole("heading", { name: "Biggest price climb" }).first(),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("an open battle shows the exact register and deposit calls and sends no action request before the user asks", async ({
  page,
}) => {
  const actionCalls: string[] = [];
  page.on("request", (r) => {
    if (
      r.url().includes("/api/arena/actions") ||
      r.url().includes("/api/arena/session")
    )
      actionCalls.push(r.url());
  });
  await page.goto("/arena/1");
  await expect(
    page.getByText("1 · REGISTER A POSITION (STORAGE, NOT A STAKE)"),
  ).toBeVisible();
  await expect(page.getByText("register_lifecycle_position")).toBeVisible();
  await expect(
    page.getByText("The deposit pays for storage; it is not a stake."),
  ).toBeVisible();
  // The deposit review stays blocked until a valid exact integer amount is typed.
  await expect(
    page.getByText("amount must be a positive integer in token base units"),
  ).toBeVisible();
  await page.getByLabel("Deposit amount").fill("1.5");
  await expect(
    page.getByText("amount must be a positive integer in token base units"),
  ).toBeVisible();
  await page.getByLabel("Deposit amount").fill("250");
  await expect(
    page.getByText("ft_transfer_call", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("250 base units")).toBeVisible();
  await expect(
    page
      .getByText("A confirmed transaction is not a credited position", {
        exact: false,
      })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Crew 02", exact: true }).click();
  await expect(page.getByText("#1 / community 2").first()).toBeVisible();
  expect(actionCalls).toEqual([]);
});

test("a locked battle offers no registration or deposit", async ({ page }) => {
  await page.goto("/arena/2");
  await expect(
    page.getByText(
      "This battle is locked. Positions can no longer be registered",
    ),
  ).toBeVisible();
  await expect(page.getByText("register_lifecycle_position")).toHaveCount(0);
  await expect(page.getByLabel("Deposit amount")).toHaveCount(0);
});

test("the landing page renders in application mode with its 3D canvas and no unavailable card", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("unavailable for the selected application deployment")).toHaveCount(0);
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  // Create links point at the lifecycle review page, not the blocked legacy one.
  await expect(page.locator('a[href="/battles/new"]')).toHaveCount(0);
});
