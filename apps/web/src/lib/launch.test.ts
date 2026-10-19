import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  buildObjective,
  buildRequestBody,
  checkPayload,
  CURB_PARAMS,
  curlCheck,
  curlImport,
  describeParams,
  durationAdjective,
  durationWords,
  importTarget,
  liquidityFloor,
  shellQuote,
  validateLaunch,
  type LaunchInput,
} from "./launch";

const repoManifest = JSON.parse(readFileSync(new URL("../../../../launch.json", import.meta.url), "utf8"));

const DESK = "0xa4df8fbf3a1ab94795577c74ffae26e1d2083819";
const curb: LaunchInput = {
  name: "Curb",
  symbol: "CURB",
  owner: DESK,
  repoUrl: "https://github.com/RaYYeR220/curb.git",
  baseCommit: "faea5be40d0bc1a3125d756705b29ac76a12cb43",
  poolBps: 9000,
  remainderTo: DESK,
  params: CURB_PARAMS,
};

describe("launch manifest", () => {
  it("matches the repository's launch.json for CURB, key for key, in every field but the notes", () => {
    const m = buildManifest(curb);
    expect(Object.keys(m)).toEqual(Object.keys(repoManifest));
    expect(Object.keys(m.hook)).toEqual(Object.keys(repoManifest.hook));
    expect(m.kind).toBe(repoManifest.kind);
    expect(m.hook).toEqual(repoManifest.hook);
    expect(m.token).toEqual(repoManifest.token);
    expect(m.pool).toEqual(repoManifest.pool);
    expect(m.notes).toContain("The seven numeric settings are 1000, 100, 300, 15, 900, 1800 and 100000");
    expect(m.notes).toContain("scales to 1e23 in-range liquidity");
  });

  it("carries the parameters into the constructor arguments", () => {
    const m = buildManifest({ ...curb, name: "Gate", symbol: "GATE", params: { ...CURB_PARAMS, bandTicks: 2000, haltSeconds: 600 } });
    expect(m.hook.constructorArgs).toEqual(["$poolManager", "$token", "$factory", "$owner", "2000", "100", "300", "15", "600", "1800", "100000", "1"]);
    expect(m.token).toMatchObject({ name: "Gate", symbol: "GATE" });
    expect(m.notes).toContain("This manifest selects GATE/IMD");
  });

  it("states the liquidity floor in plain units", () => {
    expect(liquidityFloor(100000)).toBe("1e23");
    expect(liquidityFloor(1)).toBe("1e18");
    expect(liquidityFloor(25)).toBe("25e18");
  });
});

describe("launch.open body", () => {
  it("has the shape the desk paid for", () => {
    const b = buildRequestBody(curb);
    expect(Object.keys(b)).toEqual([
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
    expect(b).toMatchObject({
      onchain: "univ4_hook",
      chainId: 4663,
      pairWith: "imd",
      owner: DESK,
      economics: { poolBps: 9000, remainderTo: DESK },
      github: true,
      shape: "chain",
      steps: [{ skill: "audit-imported-code" }],
    });
    expect(checkPayload(b)).toEqual({ action: "launch.open", input: b });
  });

  it("writes the objective from the parameters", () => {
    const o = buildObjective(curb);
    expect(o).toContain("Launch Curb (CURB)");
    expect(o).toContain("the literals 1000, 100, 300, 15, 900, 1800, 100000, true");
    expect(o).toContain("a 1000-tick band around a 5-minute time-weighted reference");
    expect(o).toContain("for at most 15 minutes when the price holds at the band edge for 15 seconds");
  });

  it("imports the exact commit the body names", () => {
    expect(importTarget(curb.repoUrl, curb.baseCommit)).toBe(
      "https://github.com/RaYYeR220/curb/tree/faea5be40d0bc1a3125d756705b29ac76a12cb43",
    );
    expect(curlImport(curb.repoUrl, curb.baseCommit)).toContain(`"kind":"contracts"`);
  });

  it("quotes the curl body for a POSIX shell", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const c = curlCheck(buildRequestBody(curb));
    expect(c.startsWith("curl -s https://api.imd.fun/requests/check")).toBe(true);
    expect(c).toContain(`"action":"launch.open"`);
    expect(c).toContain(`factory'\\''s zero-liquidity`);
  });
});

describe("validation", () => {
  it("accepts the CURB launch", () => {
    expect(validateLaunch(curb)).toEqual({});
  });

  it("mirrors the constructor's BadParams checks", () => {
    const e = validateLaunch({ ...curb, params: { ...CURB_PARAMS, bandTicks: 101, edgeTicks: 100, haltSeconds: 0 } });
    expect(e.bandTicks).toMatch(/2 ticks wider/);
    expect(e.haltSeconds).toBeDefined();
    expect(validateLaunch({ ...curb, params: { ...CURB_PARAMS, bandTicks: 20001 } }).bandTicks).toBeDefined();
    expect(validateLaunch({ ...curb, params: { ...CURB_PARAMS, edgeTicks: 0 } }).edgeTicks).toBeDefined();
    expect(validateLaunch({ ...curb, params: { ...CURB_PARAMS, refWindow: 1.5 } }).refWindow).toBeDefined();
  });

  it("checks names, addresses and the commit", () => {
    const e = validateLaunch({ ...curb, name: " ", symbol: "curb", owner: "0x12", baseCommit: "main", poolBps: 10001, repoUrl: "git@x" });
    expect(Object.keys(e).sort()).toEqual(["baseCommit", "name", "owner", "poolBps", "repoUrl", "symbol"]);
  });
});

describe("words", () => {
  it("names spans", () => {
    expect(durationWords(300)).toBe("5 minutes");
    expect(durationWords(1)).toBe("1 second");
    expect(durationWords(3600)).toBe("1 hour");
    expect(durationAdjective(300)).toBe("5-minute");
    expect(durationAdjective(15)).toBe("15-second");
  });

  it("summarises the parameters", () => {
    const d = describeParams(CURB_PARAMS);
    expect(d[0]).toEqual({ label: "Band", value: "±10.5% around the reference" });
    expect(d.find((x) => x.label === "Halt")?.value).toBe("after 15 seconds at the edge, for at most 15 minutes");
  });
});
