import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Address } from "viem";
import { previewSwap } from "@curb/sdk";
import { ChannelChart, type Attempt } from "../components/ChannelChart";
import { PageHead } from "../components/PageHead";
import { Notice, PhaseMark } from "../components/ui";
import { client } from "../lib/chain";
import { deployments, IMD_JOB_URL, POOLS, type PoolDef } from "../lib/deployments";
import { formatAmount, formatInt, parseAmount } from "../lib/format";
import { exactInput, largestFit, payCurrency, previewView, zeroForOneFor, type PreviewView, type Side } from "../lib/preview";
import { useLivePools, usePool, type PoolState } from "../state/feeds";
import { useNow } from "../state/hooks";

/**
 * Sizes that show both answers on each pool as it stood when the drill ran. The pool can move, so
 * the labels say what the size is meant to do, and the answer below says what it actually does.
 */
const PRESETS: Record<string, Record<Side, { amount: string; label: string }[]>> = {
  drill: {
    buy: [
      { amount: "0.000001", label: "A small buy" },
      { amount: "0.0001", label: "A buy through the band" },
    ],
    sell: [
      { amount: "10000", label: "A small sell" },
      { amount: "100000", label: "A sell through the band" },
    ],
  },
  launch: {
    buy: [
      { amount: "10", label: "A small buy" },
      { amount: "2400", label: "A buy through the band" },
    ],
    sell: [
      { amount: "1000000", label: "A small sell" },
      { amount: "100000000", label: "A sell through the band" },
    ],
  },
};

interface Answer {
  view: PreviewView;
  side: Side;
  amount: bigint;
  block: bigint;
  attempt?: Attempt;
}

export function Break() {
  const pools = useLivePools();
  const [poolKey, setPoolKey] = useState<"drill" | "launch">("drill");
  const def = pools.find((p) => p.key === poolKey) ?? pools[0];
  return (
    <>
      <PageHead
        title="Try to break it"
        lede="Pick a side and a size. The pool answers through eth_call on Robinhood Chain, along the same code path a real swap takes: no wallet, no gas, nothing sent."
      />
      <PoolPicker value={def?.key ?? poolKey} live={pools.map((p) => p.key)} onChange={setPoolKey} />
      {def ? <Breaker key={def.key} def={def} /> : <Notice>No Curb pool is live yet.</Notice>}
    </>
  );
}

function PoolPicker({ value, live: liveKeys, onChange }: { value: string; live: string[]; onChange: (k: "drill" | "launch") => void }) {
  return (
    <fieldset className="picker">
      <legend className="field-label">Pool</legend>
      <div className="picker__row">
        {POOLS.map((p) => {
          const live = liveKeys.includes(p.key);
          return (
            <label key={p.key} className={live ? "picker__opt" : "picker__opt is-disabled"}>
              <input type="radio" name="pool" value={p.key} checked={value === p.key} disabled={!live} onChange={() => onChange(p.key)} />
              <span className="picker__title">{p.title}</span>
              <span className="picker__note">
                {live ? (
                  p.role
                ) : deployments.launch?.job ? (
                  <>
                    not live yet, IMD{" "}
                    <a href={IMD_JOB_URL(deployments.launch.job)} target="_blank" rel="noopener noreferrer">
                      job {deployments.launch.job.slice(0, 8)}
                    </a>
                  </>
                ) : (
                  "not live yet"
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Breaker({ def }: { def: PoolDef & { hook: Address } }) {
  const s = usePool(def);
  const now = useNow(s.clock?.offset ?? 0);
  const presets = PRESETS[def.key]!;
  const [side, setSide] = useState<Side>("buy");
  const [amountText, setAmountText] = useState(presets.buy[1]!.amount);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [fit, setFit] = useState<{ state: "idle" | "searching" | "done"; amount: bigint | null }>({ state: "idle", amount: null });
  const run = useRef(0);
  const auto = useRef(false);

  const pay = s.pair ? payCurrency(side, s.pair) : side === "buy" ? { symbol: def.pairedSymbol, decimals: 18 } : { symbol: def.tokenSymbol, decimals: 18 };
  const amount = parseAmount(amountText, pay.decimals);

  const ask = useCallback(
    async (sd: Side, value: bigint) => {
      if (!s.key || !s.pair || !s.status) return;
      const id = ++run.current;
      setAsking(true);
      setFit({ state: "idle", amount: null });
      const zeroForOne = zeroForOneFor(sd, s.pair.tokenIs0);
      const [p, block] = await Promise.all([
        previewSwap(client, deployments.router, s.key, zeroForOne, exactInput(value)),
        client.getBlockNumber().catch(() => 0n),
      ]);
      if (id !== run.current) return;
      const view = previewView(p, { side: sd, pair: s.pair, tick: s.status.tick, ref: s.status.ref });
      const attempt: Attempt | undefined =
        view.tickAfter !== undefined && (view.outcome === "pass" || view.outcome === "refused")
          ? { tickAfter: view.tickAfter, outcome: view.outcome }
          : undefined;
      setAnswer({ view, side: sd, amount: value, block, attempt });
      setAsking(false);
      if (view.outcome === "refused") {
        setFit({ state: "searching", amount: null });
        const key = s.key;
        const best = await largestFit(
          async (a) => (await previewSwap(client, deployments.router, key, zeroForOne, exactInput(a))).ok,
          value,
          { cancelled: () => id !== run.current },
        );
        if (id === run.current) setFit({ state: "done", amount: best });
      }
    },
    [s.key, s.pair, s.status],
  );

  // Leaving the page abandons any search still asking the pool; coming back asks afresh.
  useEffect(
    () => () => {
      run.current++;
      auto.current = false;
    },
    [],
  );

  // The page opens on a real attempt to break the pool, so the answer is on screen from the start.
  useEffect(() => {
    if (auto.current || !s.key || !s.pair || !s.status || amount === null) return;
    auto.current = true;
    void ask(side, amount);
  }, [s.key, s.pair, s.status, ask, side, amount]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (amount !== null) void ask(side, amount);
  };
  const choose = (sd: Side, text: string) => {
    setSide(sd);
    setAmountText(text);
    const v = parseAmount(text, s.pair ? payCurrency(sd, s.pair).decimals : 18);
    if (v !== null) void ask(sd, v);
  };

  const tokenSym = s.pair?.token.symbol ?? def.tokenSymbol;
  const ready = Boolean(s.key && s.pair && s.status && s.params);

  return (
    <>
      <form className="ask" onSubmit={submit} aria-describedby="ask-help">
        <fieldset className="ask__side">
          <legend className="field-label">Side</legend>
          <div className="segmented">
            {(["buy", "sell"] as const).map((sd) => (
              <label key={sd} className="segmented__opt">
                <input
                  type="radio"
                  name="side"
                  value={sd}
                  checked={side === sd}
                  onChange={() => {
                    setSide(sd);
                    setAmountText(presets[sd][1]!.amount);
                  }}
                />
                <span>
                  {sd === "buy" ? "Buy" : "Sell"} {tokenSym}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="ask__amount">
          <label className="field-label" htmlFor="amount">
            Pay exactly
          </label>
          <div className="amount">
            <input
              id="amount"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={amount === null}
              aria-describedby="amount-hint"
            />
            <span className="amount__unit">{pay.symbol}</span>
          </div>
          <p id="amount-hint" className={amount === null ? "hint hint--error" : "hint"}>
            {amount === null ? `Enter an amount of ${pay.symbol} above zero.` : "Exact input, no price limit: the way aggregators send it."}
          </p>
        </div>
        <button type="submit" className="cta cta--form" disabled={!ready || amount === null || asking}>
          {asking ? "Asking…" : "Ask the pool"}
        </button>
        <div className="ask__presets">
          <span id="ask-help" className="field-label">
            Or try
          </span>
          {(["buy", "sell"] as const).flatMap((sd) =>
            presets[sd].map((p) => (
              <button key={`${sd}${p.amount}`} type="button" className="preset" onClick={() => choose(sd, p.amount)} disabled={!ready}>
                <b>{p.label}</b>
                <span>
                  {Number(p.amount).toLocaleString("en-US", { maximumFractionDigits: 18 })}{" "}
                  {sd === "buy" ? (s.pair?.paired.symbol ?? def.pairedSymbol) : tokenSym}
                </span>
              </button>
            )),
          )}
        </div>
      </form>

      <AnswerStrip s={s} now={now} answer={answer} asking={asking} fit={fit} />
    </>
  );
}

function AnswerStrip({
  s,
  now,
  answer,
  asking,
  fit,
}: {
  s: PoolState;
  now: number;
  answer: Answer | null;
  asking: boolean;
  fit: { state: "idle" | "searching" | "done"; amount: bigint | null };
}) {
  if (!s.pair || !s.params || !s.status) {
    return (
      <div className="strip">
        <div className="card strip__card strip__card--empty">
          {s.error ? <Notice tone="error">Could not read the pool: {s.error}</Notice> : <Notice>Reading the pool…</Notice>}
        </div>
      </div>
    );
  }
  const pair = s.pair;
  const v = answer?.view;
  const pay = answer ? payCurrency(answer.side, pair) : null;
  const mark = v?.outcome === "pass" ? "pass" : v?.outcome === "halted" ? "halted" : "refused";
  return (
    <section className="strip" aria-live="polite" aria-busy={asking}>
      <div className="strip__head">
        <span>The pool's answer</span>
        <span>{s.def.title}, Robinhood Chain</span>
      </div>
      <div className={asking ? "card strip__card is-stale" : "card strip__card"}>
        <div className="verdict">
          {answer && v && pay ? (
            <>
              <p className="verdict__swap">
                {answer.side === "buy" ? "Buy" : "Sell"} {pair.token.symbol}
                {answer.side === "buy" ? " with " : ", paying "}
                <b>
                  {formatAmount(answer.amount, pay.decimals, 6)} {pay.symbol}
                </b>
              </p>
              <p className={`verdict__word verdict__word--${v.outcome}`}>
                <PhaseMark phase={mark} />
                {v.title}
              </p>
              <p className="verdict__plain">{v.sentence}</p>
              {v.detail && <p className="verdict__detail">{v.detail}</p>}
              {v.outcome === "refused" && fit.state !== "idle" && (
                <p className="fits">
                  {fit.state === "searching" ? (
                    "Finding the largest swap that fits…"
                  ) : fit.amount !== null ? (
                    <>
                      Largest swap that fits{" "}
                      <b>
                        {formatAmount(fit.amount, pay.decimals, 3)} {pay.symbol}
                      </b>
                    </>
                  ) : (
                    "Even the smallest size tried would leave the band."
                  )}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="verdict__swap">No swap asked yet</p>
              <p className="verdict__word verdict__word--idle">{asking ? "Asking…" : "Pick a size"}</p>
              <p className="verdict__plain">Choose a side and an amount, or one of the sizes above, and the pool will say what it would do.</p>
            </>
          )}
        </div>
        <div className="graph">
          <ChannelChart
            title={`${s.def.title} channel with the asked swap`}
            pair={pair}
            params={s.params}
            status={s.status}
            hookLogs={s.hookLogs}
            swaps={s.swaps}
            init={s.init}
            now={now}
            height={230}
            attempt={answer?.attempt}
          />
          {v?.revert && (
            <p className="revert">
              <span>revert</span> {v.revert}
            </p>
          )}
          {v?.outcome === "pass" && answer?.attempt && (
            <p className="revert revert--pass">
              <span>simulated</span> ends at tick {answer.attempt.tickAfter}
              {v.received ? `, receives ${v.received}` : ""}
            </p>
          )}
        </div>
      </div>
      <p className="strip__foot">
        {answer
          ? `Simulated with eth_call on the live pool, block ${formatInt(answer.block)}. No gas spent, nothing sent.`
          : "Answers come from eth_call on the live pool. No gas spent, nothing sent."}
      </p>
    </section>
  );
}
