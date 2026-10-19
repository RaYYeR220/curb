import { readFileSync } from "node:fs";
import { hexToString, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { curbLaunchManifest, normalizeRepo, validateParams, DEFAULT_PARAMS } from "../src/tools/manifest";
import { DESK, fakeClient, fakeContext } from "./fakes";

const repoManifest = JSON.parse(readFileSync(new URL("../../../launch.json", import.meta.url), "utf8"));
const OWNER = "0x00000000000000000000000000000000000A11CE";
const COMMIT = "c".repeat(40);

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("curb_launch_manifest", () => {
  it("rebuilds the repository's own launch.json for CURB", async () => {
    const out = await curbLaunchManifest(fakeContext(fakeClient()), { name: "Curb", symbol: "CURB", owner: DESK });
    const { notes, ...shape } = out.manifest;
    const { notes: repoNotes, ...repoShape } = repoManifest;
    expect(shape).toEqual(repoShape);
    expect(typeof repoNotes).toBe("string");
    expect(notes).toContain("name Curb, symbol CURB, 18 decimals, 1,000,000,000 tokens");
    expect(notes).toContain("int24 bandTicks 1000, int24 edgeTicks 100, uint32 refWindow 300");
    expect(notes).toContain("the key must hold CURB");
  });

  it("writes an IMD launch.open body of the expected shape", async () => {
    const out = await curbLaunchManifest(fakeContext(fakeClient()), {
      name: "Garden",
      symbol: "GRDN",
      owner: OWNER,
      params: { bandTicks: 600, haltSeconds: 600 },
      repoUrl: "https://github.com/alice/garden.git",
      baseCommit: COMMIT,
    });
    const body = out.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "objective",
      "repoUrl",
      "baseCommit",
      "references",
      "onchain",
      "chainId",
      "pairWith",
      "owner",
      "economics",
      "github",
      "shape",
      "steps",
    ]);
    expect(body).toMatchObject({
      repoUrl: "https://github.com/alice/garden",
      baseCommit: COMMIT,
      references: ["uniswap-v4-hooks", "uniswap-v4-security", "oracle-consumer"],
      onchain: "univ4_hook",
      chainId: 4663,
      pairWith: "imd",
      owner: OWNER.toLowerCase(),
      economics: { poolBps: 9000, remainderTo: OWNER.toLowerCase() },
      github: true,
      shape: "chain",
      steps: [{ skill: "audit-imported-code" }],
    });
    const objective = body.objective as string;
    expect(objective).toContain("Launch Garden (GRDN)");
    expect(objective).toContain("src/CurbHook.sol");
    expect(objective).toContain("Token: src/CurbToken.sol, name Garden, symbol GRDN");
    expect(objective).toContain("fixed 1,000,000,000 supply");
    expect(objective).toContain("the literals 600, 100, 300, 15, 600, 1800, 100000, true");
    expect(objective).toContain("at most 10 minutes");
    expect(objective.length).toBeLessThan(8000);
    expect(out.manifest.hook.constructorArgs).toEqual(["$poolManager", "$token", "$factory", "$owner", "600", "100", "300", "15", "600", "1800", "100000", "1"]);
    expect(out.manifest.token).toEqual({ contract: "CurbToken", name: "Garden", symbol: "GRDN", decimals: 18 });
    expect(JSON.parse(hexToString(out.payment.bodyHex as Hex))).toEqual(body);
    expect(out.payment.actionId).toBe("0x6c61756e63682e6f70656e406c61756e63682d31000000000000000000000000");
    expect(out.missing).toEqual([]);
    expect(out.readyToPay).toBe(false);
    expect(out.summary).toContain("Run with check: true");
  });

  it("imports the repository, then runs the free check on the resolved commit", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/requests/import")) {
        return jsonResponse(200, { ok: true, source: { kind: "contracts", repoUrl: "https://github.com/alice/garden", baseCommit: COMMIT } });
      }
      if (path.endsWith("/requests/check")) {
        const sent = JSON.parse(String(init?.body));
        expect(sent.action).toBe("launch.open");
        expect(sent.input.baseCommit).toBe(COMMIT);
        return jsonResponse(200, {
          action: "launch.open",
          kind: "hook",
          plan: [{ title: "Audit your contracts as they are, as another agent", skill: "audit-imported-code" }, { title: "Deploy on Robinhood Chain" }],
          facts: [],
          judged: false,
          blockers: [],
          suggestions: [],
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const ctx = fakeContext(fakeClient(), { fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await curbLaunchManifest(ctx, { name: "Garden", symbol: "GRDN", owner: OWNER, repoUrl: "https://github.com/alice/garden", check: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.imd.fun/requests/import");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ url: "https://github.com/alice/garden", kind: "contracts" });
    expect(out.body).toMatchObject({ baseCommit: COMMIT });
    expect(out.check).toEqual({
      blockers: [],
      suggestions: [],
      plan: ["Audit your contracts as they are, as another agent", "Deploy on Robinhood Chain"],
      facts: [],
      kind: "hook",
    });
    expect(out.readyToPay).toBe(true);
    expect(out.summary).toContain("no blockers");
  });

  it("stops at an import IMD refuses", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(422, { ok: false, problems: [{ code: "private_repo" }] }));
    const ctx = fakeContext(fakeClient(), { fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await curbLaunchManifest(ctx, {
      name: "Garden",
      symbol: "GRDN",
      owner: OWNER,
      repoUrl: "https://github.com/alice/garden",
      baseCommit: COMMIT,
      check: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      url: `https://github.com/alice/garden/commit/${COMMIT}`,
      kind: "contracts",
    });
    expect(out.import).toEqual({ ok: false, problems: [{ code: "private_repo" }] });
    expect(out).not.toHaveProperty("check");
    expect(out.readyToPay).toBe(false);
    expect(out.summary).toContain("could not import");
  });

  it("refuses parameters the hook's constructor would refuse, and bad inputs", async () => {
    expect(validateParams(DEFAULT_PARAMS)).toEqual([]);
    expect(validateParams({ ...DEFAULT_PARAMS, bandTicks: 101 })).toEqual(["bandTicks must exceed edgeTicks by at least 2"]);
    expect(validateParams({ ...DEFAULT_PARAMS, bandTicks: 30000, haltSeconds: 0 })).toEqual([
      "haltSeconds must be a positive integer",
      "bandTicks must be at most 20000",
    ]);
    const ctx = fakeContext(fakeClient());
    await expect(curbLaunchManifest(ctx, { name: "G", symbol: "G", owner: OWNER, params: { edgeTicks: 999 } })).rejects.toThrow(/params rejected/);
    await expect(curbLaunchManifest(ctx, { name: "G", symbol: "G", owner: "0x0000000000000000000000000000000000000000" })).rejects.toThrow(/zero/);
    await expect(curbLaunchManifest(ctx, { name: "G", symbol: "G", owner: "alice" })).rejects.toThrow(/not an address/);
    await expect(curbLaunchManifest(ctx, { name: "G", symbol: "G", owner: OWNER, check: true })).rejects.toThrow(/needs repoUrl/);
    const missing = await curbLaunchManifest(ctx, { name: "G", symbol: "G", owner: OWNER });
    expect(missing.missing).toEqual(["repoUrl", "baseCommit"]);
    expect(missing.body).not.toHaveProperty("repoUrl");
  });

  it("normalises GitHub URLs", () => {
    expect(normalizeRepo("https://github.com/RaYYeR220/curb.git")).toBe("https://github.com/RaYYeR220/curb");
    expect(normalizeRepo("https://github.com/a/b/")).toBe("https://github.com/a/b");
    expect(() => normalizeRepo("https://gitlab.com/a/b")).toThrow(/github/);
  });
});
