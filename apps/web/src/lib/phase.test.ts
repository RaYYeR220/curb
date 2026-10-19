import { describe, expect, it } from "vitest";
import { Phase, Verdict, type Status } from "@curb/sdk";
import { phaseAt, statusView, type HookParams } from "./phase";

const params: HookParams = {
  bandTicks: 300,
  edgeTicks: 60,
  refWindow: 120,
  limitSeconds: 10,
  haltSeconds: 300,
  cooldownSeconds: 300,
  minLiquidity: 10n ** 18n,
  arbBlocks: true,
};

const base: Status = {
  phase: Phase.Open,
  phaseName: "open",
  nonce: 0,
  ref: 230400,
  lower: 230100,
  upper: 230700,
  tick: 230400,
  edgeSince: 0,
  haltStart: 0,
  reopensAt: 0,
  cooldownEnd: 0,
  pinUntil: 0,
  verdict: Verdict.None,
  fromBlock: 0n,
  toBlock: 0n,
  windowVolume: 0n,
};

// The drill's own numbers: limit entered at 1792437689, halt 1792437699 to 1792437999.
const limited: Status = { ...base, tick: 230129, edgeSince: 1792437689, haltStart: 1792437699, reopensAt: 1792437999 };

describe("phase", () => {
  it("walks limit, halted, cooldown and open from one status read", () => {
    expect(phaseAt(limited, params, 1792437690)).toBe(Phase.Limit);
    expect(phaseAt(limited, params, 1792437699)).toBe(Phase.Halted);
    expect(phaseAt(limited, params, 1792437998)).toBe(Phase.Halted);
    expect(phaseAt(limited, params, 1792437999)).toBe(Phase.Cooldown);
    expect(phaseAt(limited, params, 1792438299)).toBe(Phase.Open);
  });

  it("reads a cooldown from cooldownEnd once the halt is closed", () => {
    const closed = { ...base, nonce: 1, cooldownEnd: 1792438299 };
    expect(phaseAt(closed, params, 1792438200)).toBe(Phase.Cooldown);
    expect(phaseAt(closed, params, 1792438300)).toBe(Phase.Open);
  });

  it("follows an early reopen", () => {
    const resolved = { ...limited, reopensAt: 1792437800 };
    expect(phaseAt(resolved, params, 1792437801)).toBe(Phase.Cooldown);
  });
});

describe("statusView", () => {
  it("counts down to the halt while in the limit state", () => {
    const v = statusView(limited, params, 1792437690);
    expect(v.name).toBe("limit");
    expect(v.title).toBe("Limit");
    expect(v.inEdge).toBe(true);
    expect(v.distance).toBe(271);
    expect(v.countdowns).toEqual([{ key: "halt", label: "Halts", at: 1792437699 }]);
    expect(v.sentence).toContain("19:21:39 UTC");
  });

  it("shows the reopen and the cooldown during a halt", () => {
    const v = statusView(limited, params, 1792437800);
    expect(v.name).toBe("halted");
    expect(v.countdowns.map((c) => [c.key, c.at])).toEqual([
      ["reopen", 1792437999],
      ["cooldown", 1792438299],
    ]);
    expect(v.sentence).toMatch(/^Halted both ways after 10 s at the edge/);
  });

  it("says when the next halt can start during a cooldown", () => {
    const v = statusView({ ...base, nonce: 1, cooldownEnd: 1792438299 }, params, 1792438100);
    expect(v.name).toBe("cooldown");
    expect(v.sentence).toContain("19:31:49 UTC");
  });

  it("mentions a pin while it lasts", () => {
    const v = statusView({ ...base, pinUntil: 1792438500, cooldownEnd: 1792438500 }, params, 1792438100);
    expect(v.sentence).toContain("pinned");
    expect(v.countdowns.at(-1)?.key).toBe("pin");
  });

  it("is plain when open", () => {
    const v = statusView(base, params, 1792438100);
    expect(v.name).toBe("open");
    expect(v.countdowns).toEqual([]);
    expect(v.inEdge).toBe(false);
  });
});
