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
  // Open arena (D34): a start time, no community picker. The default start is filled from the client clock.
  const start = page.getByLabel(/Start time/);
  await expect(start).toBeVisible();
  await expect(start).not.toHaveValue("");
  await expect(page.getByPlaceholder("Search a token name (CASHCAT) or address")).toHaveCount(0);
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
  await expect(page.getByLabel("Exact arguments")).toContainText('"assets": []');
  await expect(page.getByLabel("Exact arguments")).toContainText('"start_at_ms"');
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

test.describe("lifecycle intent terminal", () => {
  const watchActions = (page: Page) => {
    const calls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/arena/actions") || r.url().includes("/api/arena/session")) calls.push(r.url());
    });
    return calls;
  };
  const ask = async (page: Page, prompt: string) => {
    await page.getByLabel("Terminal prompt").fill(prompt);
    await page.getByRole("button", { name: "Read my request" }).click();
  };

  test("a Bahasa Indonesia deposit prompt shows the exact reviewed call and sends no action request", async ({ page }) => {
    const problems = watch(page);
    const calls = watchActions(page);
    await page.goto("/terminal");
    await expect(page.getByRole("heading", { name: /A little help/ })).toBeVisible();
    await ask(page, "deposit 250 ke battle 1 komunitas 2");
    await expect(page.getByTestId("intent-summary")).toContainText("Deposit 250 base units into battle #1, community 2");
    const review = page.getByLabel("Reviewed call");
    // The receiving token is the battle's recorded community representation, not prompt text.
    await expect(review.getByText("c2.rep.testnet").first()).toBeVisible();
    await expect(review.getByText("ft_transfer_call", { exact: true })).toBeVisible();
    await expect(review.getByText("250 base units")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet to sign" })).toBeVisible();
    expect(calls).toEqual([]);
    expect(problems.filter((p) => !/favicon|hydrat/i.test(p))).toEqual([]);
  });

  test("register, an inexact amount and a locked battle are handled before any request", async ({ page }) => {
    const calls = watchActions(page);
    await page.goto("/terminal");
    await ask(page, "daftar di battle 1 komunitas 3");
    await expect(page.getByLabel("Reviewed call").getByText("register_lifecycle_position").first()).toBeVisible();
    await ask(page, "deposit 1.5 to battle 1 community 2");
    await expect(page.getByLabel("Clarification")).toContainText(/whole number/);
    await ask(page, "register in battle 2 community 1");
    await expect(page.getByText(/Battle #2 is locked/)).toBeVisible();
    await ask(page, "daftar di battle 1 komunitas 9");
    await expect(page.getByText(/community 9 does not exist/)).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("create asks for a start time and reviews an open arena with no communities", async ({ page }) => {
    const calls = watchActions(page);
    await page.goto("/terminal");
    await ask(page, "create price gain battle");
    await expect(page.getByText(/When should it start/)).toBeVisible();
    await ask(page, "create price gain battle in 15 minutes");
    const reviewed = page.getByLabel("Reviewed call");
    await expect(reviewed.getByText("create_lifecycle_battle").first()).toBeVisible();
    await expect(reviewed.getByText(/none: communities join before the start/)).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("a payout is reviewed but cannot be submitted, with the specific reason", async ({ page }) => {
    const calls = watchActions(page);
    await page.goto("/terminal");
    await ask(page, `payout 500 to 0x${"a".repeat(40)} from token.testnet`);
    await expect(page.getByRole("button", { name: "Payout cannot be submitted yet" })).toBeDisabled();
    await expect(page.getByText(/spendable custody \(#148\) is not proven/)).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("the terminal has no legacy USDC or side A/B flow", async ({ page }) => {
    await page.goto("/terminal");
    await expect(page.getByText(/USDC|side A|session key/i)).toHaveCount(0);
  });
});

test("the portfolio is wallet-gated, labels fixture data, keeps alerts readable and disables payouts with specific reasons", async ({ page }) => {
  const problems = watch(page);
  const sessionCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/arena/actions") || r.url().includes("/api/arena/session")) sessionCalls.push(r.url());
  });
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: /Your journey/ })).toBeVisible();
  await expect(page.getByText("unavailable for the selected application deployment")).toHaveCount(0);
  await expect(page.getByText(/Connect a wallet to read your positions/)).toBeVisible();
  // Account sections are not shown (and no demo/legacy data is invented) before a wallet session exists.
  await expect(page.getByText("Positions (deposits by original asset)")).toHaveCount(0);
  // Recovery alerts need no session: the FIXTURE ledger condition is visible and labeled.
  await expect(page.getByText("the backing ledger needs reconciliation")).toBeVisible();
  await expect(page.getByText(/FIXTURE \(not live\)/).first()).toBeVisible();
  // Payout requests are disabled with the specific unmet requirements; status reads stay available.
  const disabled = page.getByTestId("payout-disabled");
  await expect(disabled).toContainText("payout requests disabled");
  await expect(disabled).toContainText("connect a wallet");
  await expect(disabled).toContainText("#148");
  await expect(disabled).toContainText("your entitlements have not been read yet");
  await expect(page.getByRole("button", { name: "Connect wallet to request" })).toBeVisible();
  expect(sessionCalls).toEqual([]);
  expect(problems.filter((p) => !/favicon|hydrat/i.test(p))).toEqual([]);
});

test("the portfolio does not overflow horizontally on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: /Your journey/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("one application: every menu entry is present and the former A/B urls redirect into the arena", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const name of ["Arena", "Create", "Terminal", "Portfolio"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
  await page.goto("/battles/3");
  await expect(page).toHaveURL(/\/arena\/3$/);
  await page.goto("/battles/new");
  await expect(page).toHaveURL(/\/arena\/new$/);
  await page.goto("/arena/preview");
  await expect(page).toHaveURL(/\/arena$/);
  // No page of this app says "demo", "mock" or "legacy".
  await page.goto("/arena");
  await expect(page.getByText(/demo mode|simulated data/i)).toHaveCount(0);
});

test("the create page keeps the start-time form inside a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/arena/new");
  await expect(page.getByLabel(/Start time/)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
