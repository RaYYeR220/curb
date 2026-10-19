import type { Address } from "viem";
import { ChannelChart } from "../components/ChannelChart";
import { PageHead } from "../components/PageHead";
import { AddrLink, Notice, Out, PhaseMark, TxLink } from "../components/ui";
import { deployments, IMD_JOB_URL, REPO_URL, type PoolDef } from "../lib/deployments";
import { formatAmount, formatClock, formatInt, formatRelative, formatSpan, formatTick, shortHex } from "../lib/format";
import { statusView } from "../lib/phase";
import { formatPercent, readablePrice, tickPercent, tokenPrice } from "../lib/price";
import { timeline } from "../lib/timeline";
import { useDesk, useLivePools, usePool } from "../state/feeds";
import { useNow } from "../state/hooks";

export function Board() {
  const pools = useLivePools();
  return (
    <>
      <PageHead
        title="Live board"
        lede="Every Curb pool on Robinhood Chain, read from its hook every ten seconds: the phase, the band, the clocks, and what the hook has said."
      />
      {pools.map((def) => (
        <PoolPanel key={def.hook} def={def} />
      ))}
      {!pools.some((p) => p.key === "launch") && <LaunchPending />}
    </>
  );
}

function Freshness({ updatedAt, head, error }: { updatedAt?: number; head?: bigint; error?: string }) {
  const now = useNow(0, 1000);
  if (error) return <Notice tone="error">Last read failed: {error}. Retrying.</Notice>;
  if (!updatedAt) return <Notice>Reading Robinhood Chain…</Notice>;
  return (
    <p className="fresh">
      <span className="fresh__dot" aria-hidden="true" />
      Block {head !== undefined ? formatInt(head) : "…"}, read {formatRelative(updatedAt / 1000, now)}
    </p>
  );
}

export function PoolPanel({ def }: { def: PoolDef & { hook: Address } }) {
  const s = usePool(def);
  const now = useNow(s.clock?.offset ?? 0);
  const headingId = `pool-${def.key}`;
  const ready = s.status && s.params && s.pair;

  return (
    <section className="pool" aria-labelledby={headingId}>
      <header className="pool__head">
        <div>
          <h2 id={headingId} className="pool__title">
            {def.title}
          </h2>
          <p className="pool__role">
            {def.role}, hook <AddrLink address={def.hook} />
          </p>
        </div>
        <Freshness updatedAt={s.updatedAt} head={s.clock?.head} error={s.error} />
      </header>

      {!ready ? (
        <div className="card pool__card pool__card--empty">
          {s.error ? <Notice tone="error">Could not read the hook: {s.error}</Notice> : <Notice>Reading the hook…</Notice>}
        </div>
      ) : (
        <PoolBody s={s as Required<typeof s>} now={now} />
      )}
    </section>
  );
}

function PoolBody({ s, now }: { s: Required<ReturnType<typeof usePool>>; now: number }) {
  const { status, params, pair } = s;
  const view = statusView(status, params, now);
  const price = readablePrice(tokenPrice(status.tick, pair), pair);
  const items = timeline(s.hookLogs, { paired: pair.paired }, 12);

  return (
    <>
      <div className="card pool__card">
        <div className="pool__state">
          <p className={`phase phase--${view.name}`}>
            <PhaseMark phase={view.name} />
            {view.title}
          </p>
          <p className="pool__sentence">{view.sentence}</p>
          {view.countdowns.length > 0 && (
            <dl className="clocks">
              {view.countdowns.map((c) => (
                <div key={c.key} className="clocks__item">
                  <dt>{c.label}</dt>
                  <dd>
                    <span className="clocks__rel">{formatRelative(c.at, now)}</span>
                    <span className="clocks__abs">{formatClock(c.at)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <dl className="facts">
            <div>
              <dt>Price</dt>
              <dd>{price.text}</dd>
            </div>
            <div>
              <dt>Tick</dt>
              <dd>
                <span className="mono">{formatTick(status.tick)}</span>{" "}
                <span className="muted">
                  {view.distance === 0 ? "on the reference" : `${view.distance} ticks from the reference${view.inEdge ? ", in the edge zone" : ""}`}
                </span>
              </dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd className="mono">{formatTick(status.ref)}</dd>
            </div>
            <div>
              <dt>Band</dt>
              <dd>
                ±{params.bandTicks} ticks ({formatPercent(tickPercent(params.bandTicks)).replace("+", "±")}), edge zone{" "}
                {params.edgeTicks}
              </dd>
            </div>
            <div>
              <dt>Window volume</dt>
              <dd>
                {formatAmount(status.windowVolume, pair.paired.decimals)} {pair.paired.symbol}
              </dd>
            </div>
          </dl>
        </div>
        <div className="pool__chart">
          <ChannelChart
            title={`${s.def.title} channel`}
            pair={pair}
            params={params}
            status={status}
            hookLogs={s.hookLogs}
            swaps={s.swaps}
            init={s.init}
            now={now}
            height={380}
          />
          <p className="legend-row">
            <span className="key key--wall">limit</span>
            <span className="key key--ref">reference</span>
            <span className="key key--edge">edge zone</span>
            <span className="key key--halt">halt</span>
            <span className="key key--price">price after each swap</span>
          </p>
        </div>
      </div>

      <div className="pool__below">
        <section className="params" aria-label="Parameters">
          <h3 className="sub-title">Parameters</h3>
          <dl className="facts facts--tight">
            <div>
              <dt>Band</dt>
              <dd>{params.bandTicks} ticks</dd>
            </div>
            <div>
              <dt>Edge zone</dt>
              <dd>{params.edgeTicks} ticks</dd>
            </div>
            <div>
              <dt>Reference window</dt>
              <dd>{formatSpan(params.refWindow)}</dd>
            </div>
            <div>
              <dt>Limit state</dt>
              <dd>{formatSpan(params.limitSeconds)}</dd>
            </div>
            <div>
              <dt>Halt, at most</dt>
              <dd>{formatSpan(params.haltSeconds)}</dd>
            </div>
            <div>
              <dt>Cooldown</dt>
              <dd>{formatSpan(params.cooldownSeconds)}</dd>
            </div>
            <div>
              <dt>No-market floor</dt>
              <dd>{formatAmount(params.minLiquidity, 18, 3)}e18 liquidity</dd>
            </div>
          </dl>
        </section>
        <section className="tape" aria-label="Recent events">
          <h3 className="sub-title">What the hook said</h3>
          {items.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <ol className="tape__list">
              {items.map((it) => (
                <li key={it.tx} className="tape__item">
                  <span className="tape__time">
                    {formatClock(it.timestamp)}
                    <span className="muted">{formatRelative(it.timestamp, now)}</span>
                  </span>
                  <ul className="tape__lines">
                    {it.lines.map((l, i) => (
                      <li key={i} className={`tape__line tape__line--${l.kind}`}>
                        <span className="tape__event">{l.event}</span> {l.text}
                      </li>
                    ))}
                  </ul>
                  <span className="tape__tx">
                    <TxLink hash={it.tx} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

const LAUNCH_STATES = ["not requested", "requested, in progress", "result delivered", "failed"];

/** What the desk's own launch request says, before there is a pool to read. */
function launchCopy(state: number | undefined): { title: string; mark: "launching" | "halted"; text: string } {
  if (state === 2) {
    return {
      title: "Not live yet",
      mark: "launching",
      text: "IMD has delivered its result for the CURB launch job. The job page carries the launch's admission status; this panel becomes the pool's live board as soon as the desk binds a launched pool.",
    };
  }
  if (state === 3) {
    return {
      title: "Not launched",
      mark: "halted",
      text: "IMD reported the launch request as failed. The drill pool above runs the same hook in the meantime.",
    };
  }
  return {
    title: "Launching",
    mark: "launching",
    text: "The desk has paid IMD to launch CURB with this hook. IMD's agents audit the imported code, then the launch factory deploys CURB and its hook and seeds the pool. This panel becomes the pool's live board once the desk binds it.",
  };
}

function LaunchPending() {
  const desk = useDesk();
  const l = deployments.launch;
  const copy = launchCopy(desk.launch?.state);
  return (
    <section className="pool" aria-labelledby="pool-launch">
      <header className="pool__head">
        <div>
          <h2 id="pool-launch" className="pool__title">
            CURB / IMD
          </h2>
          <p className="pool__role">The launch pool, through Identity MD</p>
        </div>
      </header>
      <div className="card pool__card pool__card--pending">
        <div className="pool__state">
          <p className="phase phase--launching">
            <PhaseMark phase={copy.mark} />
            {copy.title}
          </p>
          <p className="pool__sentence">{copy.text}</p>
        </div>
        <dl className="facts pool__launch-facts">
          {l?.job && (
            <div>
              <dt>IMD job</dt>
              <dd>
                <Out className="hex-link" href={IMD_JOB_URL(l.job)}>
                  {l.job}
                </Out>
              </dd>
            </div>
          )}
          <div>
            <dt>Desk's request</dt>
            <dd>{desk.launch ? LAUNCH_STATES[desk.launch.state] ?? String(desk.launch.state) : "reading…"}</dd>
          </div>
          {desk.launch?.uri && (
            <div>
              <dt>Result</dt>
              <dd className="mono">{desk.launch.uri}</dd>
            </div>
          )}
          {l?.payment && (
            <div>
              <dt>Payment</dt>
              <dd>
                <TxLink hash={l.payment} />
              </dd>
            </div>
          )}
          {l?.requestId && (
            <div>
              <dt>Request id</dt>
              <dd className="mono">{shortHex(l.requestId, 10, 6)}</dd>
            </div>
          )}
          {l?.baseCommit && (
            <div>
              <dt>Code</dt>
              <dd>
                <Out className="hex-link" href={`${REPO_URL}/tree/${l.baseCommit}`}>
                  {l.baseCommit.slice(0, 7)}
                </Out>
              </dd>
            </div>
          )}
          <div>
            <dt>Desk</dt>
            <dd>
              <AddrLink address={deployments.desk} />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
