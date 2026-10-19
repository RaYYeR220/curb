import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { Phase, curbHookAbi, decodeCurbError, wrappedErrorAbi } from "@curb/sdk";
import { healthGate } from "../src/gate";
import { attestationTuple, decide, runActions, CLAIM_EVERY, type Action, type PoolView } from "../src/keeper";
import { formatPreview } from "../src/format";
import { importUrl, type AttestationDoc } from "../src/imd";

const HOOK = "0xeE60C95711F5650bbBBee421426820feC6e060c0" as const;

describe("the pre-payment gate", () => {
  const chain = { chainId: 4663, rpc: { reachable: true }, writer: { address: "0x3d3c" }, lag: 12 };
  it("passes a healthy chain", () => {
    expect(healthGate({ intake: { chains: [chain] } })).toEqual({ ok: true, reasons: [] });
  });
  it("refuses an unreachable chain, a missing writer, a lagging processor or a missing chain", () => {
    expect(healthGate({ intake: { chains: [{ ...chain, rpc: { reachable: false } }] } }).ok).toBe(false);
    expect(healthGate({ intake: { chains: [{ ...chain, writer: null }] } }).ok).toBe(false);
    expect(healthGate({ intake: { chains: [{ ...chain, lag: 5000 }] } }).reasons[0]).toContain("5000 blocks behind");
    expect(healthGate({ intake: { chains: [{ ...chain, chainId: 1 }] } }).reasons[0]).toContain("no Intake on chain 4663");
  });
});

describe("the keeper's decisions", () => {
  const base: PoolView = {
    hook: HOOK,
    kind: "drill",
    phase: Phase.Open,
    nonce: 0,
    incidentState: 0,
    treasury: 0n,
    questionPrice: 5n * 10n ** 17n,
    sinceClaim: 0,
    now: 1_000,
  };
  it("waits on an open pool", () => {
    expect(decide(base)).toEqual([{ kind: "wait", why: "phase open" }]);
  });
  it("files a halt it can pay for, once", () => {
    const drill = { ...base, phase: Phase.Halted, treasury: 10n ** 18n, fileDrill: true };
    expect(decide(drill)).toEqual([{ kind: "file", hook: HOOK, nonce: 0 }]);
    expect(decide({ ...drill, incidentState: 1 })[0]?.kind).toBe("wait");
  });
  it("leaves drill halts alone unless asked, so a demo pool never spends the launch pool's fees", () => {
    expect(decide({ ...base, phase: Phase.Halted, treasury: 10n ** 18n })).toEqual([
      { kind: "wait", why: "drill halt: not filed without --file-drill" },
    ]);
  });
  it("does not file a drill halt the desk cannot pay for", () => {
    expect(decide({ ...base, phase: Phase.Halted, fileDrill: true })[0]).toEqual({
      kind: "wait",
      why: "halted, but the desk cannot pay for a question",
    });
    expect(decide({ ...base, phase: Phase.Halted, treasury: 10n ** 17n, fileDrill: true })[0]?.kind).toBe("wait");
  });
  it("files a launch-pool halt even with an empty treasury, since filing sweeps the pool's fees first", () => {
    expect(decide({ ...base, kind: "launch", phase: Phase.Halted })[0]?.kind).toBe("file");
  });
  it("pushes an answer the callback did not deliver, and sweeps fees hourly", () => {
    const attestation = answer({});
    const actions = decide({
      ...base,
      kind: "launch",
      pending: { requestId: "0x01", attestation },
      sinceClaim: CLAIM_EVERY,
    });
    expect(actions.map((a) => a.kind)).toEqual(["push", "claim"]);
  });
});

describe("answers the desk would reject", () => {
  const view: PoolView = {
    hook: HOOK,
    kind: "launch",
    phase: Phase.Open,
    nonce: 0,
    incidentState: 1,
    treasury: 0n,
    questionPrice: 5n * 10n ** 17n,
    sinceClaim: 0,
    now: 1_000,
  };
  const push = (over: Record<string, number>) => decide({ ...view, pending: { requestId: "0x01", attestation: answer(over) } });
  it("are not pushed: expired, a small panel, a low quorum, or fewer agreeing than the quorum", () => {
    expect(push({ expiresAt: 1_000 })[0]).toEqual({ kind: "wait", why: "the answer expired at 1000" });
    expect(push({ panelSize: 6 })[0]).toEqual({ kind: "wait", why: "the desk needs a panel of 7, got 6" });
    expect(push({ quorum: 4 })[0]).toEqual({ kind: "wait", why: "the desk needs a quorum of 5, got 4" });
    expect(push({ agreed: 4 })[0]).toEqual({ kind: "wait", why: "4 agreed, short of the quorum of 5" });
    expect(push({})[0]?.kind).toBe("push");
  });
});

describe("the keeper loop", () => {
  it("logs a failed action and carries on with the next", async () => {
    const sent: string[] = [];
    const logged: string[] = [];
    const actions: Action[] = [{ kind: "file", hook: HOOK, nonce: 0 }, { kind: "claim" }];
    await runActions(
      actions,
      async (a) => {
        if (a.kind === "file") throw new Error("TreasuryShort");
        sent.push(a.kind);
      },
      (line) => logged.push(line),
    );
    expect(sent).toEqual(["claim"]);
    expect(logged[0]).toContain("file failed: TreasuryShort");
  });
});

describe("IMD's attestation document", () => {
  it("becomes the tuple submitAttestation takes", () => {
    const doc = JSON.parse(readFileSync(new URL("../../../test/fixtures/oracle_attestation_sample.json", import.meta.url), "utf8"));
    const t = attestationTuple(doc as AttestationDoc);
    expect(t.answerType).toBe(3);
    expect(t.figure).toBe(2172993762529630n);
    expect(t.panelSize).toBe(100);
    expect(t.agreed).toBe(68);
    expect(t.questionHash).toBe("0x2fe76f0542b845e9a2f2e33dfc1317c70a25ef1b62759d1ed0f177ffaa2dcc47");
  });
});

describe("previews", () => {
  it("prints a refusal the way a trader reads it", () => {
    const reason = encodeErrorResult({ abi: curbHookAbi, errorName: "OutsideBand", args: [230400, 229000, 230100, true] });
    const raw = encodeErrorResult({
      abi: wrappedErrorAbi,
      errorName: "WrappedError",
      args: [HOOK, "0xb47b2fb1", reason, "0xa9e35b2f"],
    });
    const text = formatPreview({ ok: false, error: decodeCurbError(raw), raw });
    expect(text).toBe(
      "OutsideBand: Refused: the swap would end at tick 229000, past the band's lower limit 230100 (reference 230400). Split the order or set a price limit inside the band.",
    );
  });
  it("prints a pass with amounts", () => {
    expect(formatPreview({ ok: true, amount0: -(10n ** 15n), amount1: 10n ** 18n, tickAfter: 230300 })).toBe(
      "would pass: amount0 -0.001, amount1 1, ending at tick 230300",
    );
  });
});

describe("the import gate", () => {
  it("imports the body's exact commit, not the default branch", () => {
    const commit = "335beee060cfb27416112a33ac480983d2b6e5c2";
    expect(importUrl("https://github.com/RaYYeR220/curb.git", commit)).toBe(`https://github.com/RaYYeR220/curb/tree/${commit}`);
    expect(importUrl("https://github.com/RaYYeR220/curb", commit)).toBe(`https://github.com/RaYYeR220/curb/tree/${commit}`);
  });
});

function answer(over: Record<string, number>): AttestationDoc {
  const message = { expiresAt: 2_000, panelSize: 7, quorum: 5, agreed: 6, ...over };
  return { message, signature: "0x" } as unknown as AttestationDoc;
}
