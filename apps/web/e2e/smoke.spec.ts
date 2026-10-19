import { expect, test, type Page } from "@playwright/test";

const ROUTES: { hash: string; heading: RegExp }[] = [
  { hash: "#/", heading: /Some swaps\s*shouldn’t happen\./ },
  { hash: "#/board", heading: /Live board/ },
  { hash: "#/break", heading: /Try to break it/ },
  { hash: "#/incidents", heading: /Incidents/ },
  { hash: "#/launch", heading: /Launch with Curb/ },
  { hash: "#/docs", heading: /Docs/ },
];

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const r of ROUTES) {
  test(`renders ${r.hash}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(r.hash);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(r.heading);
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });
}

test("the board reads the drill pool's phase from the chain", async ({ page }) => {
  await page.goto("#/board");
  await expect(page.getByRole("heading", { name: "DRILL / ETH" })).toBeVisible();
  await expect(page.locator(".pool .phase").first()).toHaveText(/Open|Limit|Halted|Cooldown/);
  // The launch pool shows either its live phase or what the desk's launch request says.
  const launch = page.locator("section.pool").filter({ has: page.getByRole("heading", { name: "CURB / IMD" }) });
  await expect(launch.locator(".phase")).toHaveText(/Open|Limit|Halted|Cooldown|Launching|Not live yet|Not launched/);
});

test("a buy through the band is refused with OutsideBand", async ({ page }) => {
  await page.goto("#/break");
  await page.getByRole("button", { name: /A buy through the band/ }).click();
  const strip = page.locator(".strip");
  await expect(strip.locator(".verdict__word")).toHaveText("Refused");
  await expect(strip.locator(".revert")).toContainText("OutsideBand(ref:");
  await expect(strip.locator(".verdict__plain")).toContainText("Refused: the swap would end at tick");
});

test("a small buy would pass", async ({ page }) => {
  await page.goto("#/break");
  await page.getByRole("button", { name: /A small buy/ }).click();
  await expect(page.locator(".strip .verdict__word")).toHaveText("Would pass");
  await expect(page.locator(".strip .verdict__plain")).toContainText("ending at tick");
});

test("the drill's halt is told as an unfunded incident", async ({ page }) => {
  await page.goto("#/incidents");
  await page.getByRole("link", { name: "Halt 0" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Halt 0");
  await expect(page.getByText("Desk unfunded: not asked")).toBeVisible();
  await expect(page.locator(".question")).toContainText("rank the trader keys of the Trade(address indexed trader, uint256 volume) events");
});

test("the launch wizard builds the request and offers the check", async ({ page }) => {
  await page.goto("#/launch");
  await expect(page.locator(".code").filter({ hasText: '"kind": "univ4_hook"' })).toBeVisible();
  await page.getByLabel("Band").fill("50");
  await expect(page.getByText("The band must be at least 2 ticks wider than the edge zone.")).toBeVisible();
  await page.getByRole("button", { name: "Use CURB/IMD's parameters" }).click();
  await page.getByRole("button", { name: "Run the free check" }).click();
  await expect(page.locator(".check")).toContainText(/IMD's answer|Run the same check from a terminal/);
});
