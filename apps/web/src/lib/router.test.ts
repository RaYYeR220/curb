import { describe, expect, it } from "vitest";
import { blockRanges } from "./logs";
import { href, parseHash } from "./router";

const HOOK = "0xeE60C95711F5650bbBBee421426820feC6e060c0";

describe("router", () => {
  it("parses every route", () => {
    expect(parseHash("")).toEqual({ name: "landing" });
    expect(parseHash("#/")).toEqual({ name: "landing" });
    expect(parseHash("#/board")).toEqual({ name: "board" });
    expect(parseHash("#/break/")).toEqual({ name: "break" });
    expect(parseHash("#/incidents")).toEqual({ name: "incidents" });
    expect(parseHash(`#/incidents/${HOOK}/0`)).toEqual({ name: "incident", hook: HOOK, nonce: 0 });
    expect(parseHash("#/launch")).toEqual({ name: "launch" });
    expect(parseHash("#/docs")).toEqual({ name: "docs" });
    expect(parseHash("#/incidents/0x12/0")).toEqual({ name: "notfound", path: "/incidents/0x12/0" });
    expect(parseHash("#/nope")).toEqual({ name: "notfound", path: "/nope" });
  });

  it("round-trips links", () => {
    for (const h of ["#/", "#/board", "#/break", "#/incidents", `#/incidents/${HOOK}/3`, "#/launch", "#/docs"]) {
      expect(href(parseHash(h))).toBe(h);
    }
  });
});

describe("blockRanges", () => {
  it("splits wide log queries under the RPC's cap", () => {
    expect(blockRanges(0n, 9n, 5n)).toEqual([
      [0n, 4n],
      [5n, 9n],
    ]);
    expect(blockRanges(92857000n, 92857000n)).toEqual([[92857000n, 92857000n]]);
    expect(blockRanges(10n, 9n)).toEqual([]);
    expect(blockRanges(0n, 20_000_000n)).toHaveLength(3);
  });
});
