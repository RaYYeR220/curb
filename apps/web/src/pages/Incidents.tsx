import type { ReactNode } from "react";
import type { Address } from "viem";
import { deskQuestion, oracleBody, questionDocument, questionHash, VERDICT_NAMES } from "@curb/sdk";
import { PageHead } from "../components/PageHead";
import { AddrLink, CodeBlock, Link, Notice, Out, PhaseMark, TxLink } from "../components/ui";
import { blockUrl } from "../lib/chain";
import { deployments, type PoolDef } from "../lib/deployments";
import { formatAmount, formatClock, formatDateTime, formatDuration, formatInt, formatSpan, formatTick, shortHex } from "../lib/format";
import { buildIncidents, CONCENTRATED_MIN_BPS, ORGANIC_MAX_BPS, type Incident } from "../lib/incidents";
import { findPool, useDesk, useLivePools, usePool, type DeskState, type PoolState } from "../state/feeds";
import { useNow } from "../state/hooks";

function useIncidents(def: PoolDef & { hook: Address }): { s: PoolState; desk: DeskState; list: Incident[] | null } {
  const s = usePool(def);
  const desk = useDesk();
  const now = useNow(s.clock?.offset ?? 0, 5000);
  if (!s.params || !s.updatedAt || !desk.updatedAt) return { s, desk, list: null };
  const list = buildIncidents({
    hook: def.hook,
    params: s.params,
    hookLogs: s.hookLogs,
    deskLogs: desk.logs,
    initBlock: s.init?.block,
    status: s.status,
    now,
    failedFilings: desk.failedFilings,
  });
  return { s, desk, list };
}

export function Incidents() {
  const pools = useLivePools();
  return (
    <>
      <PageHead
        title="Incidents"
        lede="Every halt on a Curb pool, the question the desk asks the IMD oracle about it, and what was decided. Nothing here is hand-written: it is rebuilt from the hook's and the desk's logs."
      />
      <Treasury />
      {pools.map((def) => (
        <PoolIncidents key={def.hook} def={def} />
      ))}
    </>
  );
}

function Treasury() {
  const desk = useDesk();
  const t = desk.treasury;
  const price = t?.questionPrice ?? null;
  const ratio = t && price ? Math.min(1, Number(t.balance) / Number(price)) : 0;
  const funded = t && price !== null && t.balance >= price;
  return (
    <section className="treasury" aria-labelledby="treasury-title">
      <div className="treasury__text">
        <h2 id="treasury-title" className="sub-title">
          The desk's treasury
        </h2>
        {!t ? (
          desk.error ? <Notice tone="error">Could not read the desk: {desk.error}</Notice> : <Notice>Reading the desk…</Notice>
        ) : (
          <p className="treasury__line">
            <b>{formatAmount(t.balance, 18)} IMD</b>
            {price !== null && <> of the {formatAmount(price, 18)} IMD one question costs.</>}{" "}
            {funded
              ? "The next halt can be put to the oracle."
              : "Until it holds one question's price, a halt cannot be put to the oracle and runs its full length."}
          </p>
        )}
        <p className="muted treasury__how">
          The desk is funded by its share of the launch pool's LP fees and by anyone's <code>fund()</code>. It has no
          withdraw function. Desk <AddrLink address={deployments.desk} />
        </p>
      </div>
      <div className="meter" role="img" aria-label={`Treasury at ${Math.round(ratio * 100)}% of one question's price`}>
        <div className="meter__track">
          <div className="meter__fill" style={{ width: `${ratio * 100}%` }} />
        </div>
        <div className="meter__scale">
          <span>0</span>
          <span>one question{price !== null ? `, ${formatAmount(price, 18)} IMD` : ""}</span>
        </div>
      </div>
    </section>
  );
}

function PoolIncidents({ def }: { def: PoolDef & { hook: Address } }) {
  const { s, list } = useIncidents(def);
  return (
    <section className="incident-pool" aria-labelledby={`inc-${def.key}`}>
      <header className="pool__head">
        <div>
          <h2 id={`inc-${def.key}`} className="pool__title">
            {def.title}
          </h2>
          <p className="pool__role">
            {def.role}, hook <AddrLink address={def.hook} />
          </p>
        </div>
      </header>
      {list === null ? (
        s.error ? <Notice tone="error">Could not read the pool: {s.error}</Notice> : <Notice>Reading the logs…</Notice>
      ) : list.length === 0 ? (
        <p className="empty">This pool has not halted. Its board shows how close it is.</p>
      ) : (
        <ol className="incidents">
          {list.map((inc) => (
            <li key={inc.nonce} className="incident-row">
              <div className="incident-row__name">
                <Link to={{ name: "incident", hook: def.hook, nonce: inc.nonce }} className="incident-row__link">
                  Halt {inc.nonce}
                </Link>
                <span className="muted">{formatDateTime(inc.haltStart)}</span>
              </div>
              <div className="incident-row__span">
                <span className="mono">
                  {formatClock(inc.haltStart).slice(0, 8)} → {formatClock(inc.haltEnd)}
                </span>
                <span className="muted">
                  {inc.state === "halted" ? "in progress" : `${formatDuration(inc.haltEnd - inc.haltStart)}${inc.ranFull ? ", full length" : ", ended early"}`}
                </span>
              </div>
              <p className={`incident-row__decision decision decision--${inc.decision.kind}`}>{inc.decision.label}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function IncidentPage({ hook, nonce }: { hook: Address; nonce: number }) {
  const pools = useLivePools();
  const desk = useDesk();
  const def = findPool(pools, hook);
  if (!def && !desk.updatedAt) return <PageHead title={`Halt ${nonce}`} back={<Link to={{ name: "incidents" }}>All incidents</Link>} lede="Reading the desk…" />;
  if (!def) {
    return (
      <>
        <PageHead title="Unknown pool" back={<Link to={{ name: "incidents" }}>All incidents</Link>} />
        <p className="empty">
          No Curb pool on this site has the hook <span className="mono">{hook}</span>.
        </p>
      </>
    );
  }
  return <IncidentDetail def={def} nonce={nonce} />;
}

function IncidentDetail({ def, nonce }: { def: PoolDef & { hook: Address }; nonce: number }) {
  const { s, list } = useIncidents(def);
  const back = <Link to={{ name: "incidents" }}>All incidents</Link>;
  if (list === null) {
    return (
      <>
        <PageHead title={`Halt ${nonce}`} back={back} lede={`${def.title}, ${def.role.toLowerCase()}`} />
        {s.error ? <Notice tone="error">Could not read the pool: {s.error}</Notice> : <Notice>Reading the logs…</Notice>}
      </>
    );
  }
  const inc = list.find((i) => i.nonce === nonce);
  if (!inc) {
    return (
      <>
        <PageHead title={`Halt ${nonce}`} back={back} lede={`${def.title}, ${def.role.toLowerCase()}`} />
        <p className="empty">This pool has no halt {nonce}. It has had {list.length}.</p>
      </>
    );
  }
  const pair = s.pair;
  const p = s.params!;
  const mark = inc.decision.kind === "pending" ? "halted" : inc.decision.kind === "organic" ? "pass" : "refused";

  return (
    <>
      <PageHead title={`Halt ${inc.nonce}`} back={back} lede={`${def.title}, ${def.role.toLowerCase()}. Halt maximum ${formatSpan(p.haltSeconds)}, cooldown ${formatSpan(p.cooldownSeconds)}.`} />
      <div className="incident">
        <section className="card incident__decision" aria-labelledby="decision-title">
          <p className="verdict__swap">Decision</p>
          <h2 id="decision-title" className={`verdict__word verdict__word--small decision--${inc.decision.kind}`}>
            <PhaseMark phase={mark} />
            {inc.decision.label}
          </h2>
          <p className="verdict__plain">{inc.decision.sentence}</p>
          <dl className="facts facts--tight">
            <div>
              <dt>Halted</dt>
              <dd>
                {formatDateTime(inc.haltStart)} for {formatDuration(inc.haltEnd - inc.haltStart)}
                {inc.state === "halted" ? " so far" : inc.ranFull ? ", its full length" : ", ended early"}
              </dd>
            </div>
            {inc.closed && (
              <>
                <div>
                  <dt>Reopened on</dt>
                  <dd className="mono">reference {formatTick(inc.closed.newRef)}</dd>
                </div>
                <div>
                  <dt>Cooldown until</dt>
                  <dd>{formatClock(inc.closed.cooldownEnd)}</dd>
                </div>
              </>
            )}
          </dl>
        </section>

        <section className="incident__seq" aria-labelledby="seq-title">
          <h2 id="seq-title" className="sub-title">
            What happened
          </h2>
          <ol className="seq">
            {inc.limit && (
              <Step at={inc.limit.timestamp} tx={inc.limit.tx}>
                The price entered the edge zone at tick {formatTick(inc.limit.tick)}, {Math.abs(inc.limit.tick - inc.limit.ref)} ticks from the
                reference {formatTick(inc.limit.ref)}. The limit clock started.
              </Step>
            )}
            <Step at={inc.haltStart}>The price was still at the edge after {formatSpan(p.limitSeconds)}: the pool halted both ways.</Step>
            {inc.failedFilings.map((f) => (
              <Step key={f.hash} at={f.timestamp} tx={f.hash}>
                Someone asked the desk to file the incident. <code>fileIncident</code> reverted with <b>{f.error}</b>
                {f.error === "TreasuryShort" ? ": the desk had no IMD to pay the oracle." : "."}
              </Step>
            ))}
            {inc.filed && (
              <Step at={inc.filed.timestamp} tx={inc.filed.tx}>
                The desk filed the incident and paid the oracle for its question (request{" "}
                <span className="mono">{shortHex(inc.filed.requestId, 10, 6)}</span>).
              </Step>
            )}
            {inc.answer && (
              <Step at={inc.answer.timestamp} tx={inc.answer.tx}>
                The signed answer arrived: <AddrLink address={inc.answer.leader} /> did {(inc.answer.shareBps / 100).toFixed(2)}% of the window's volume.
                Verdict <b>{VERDICT_NAMES[inc.answer.verdict]}</b>, {inc.answer.applied ? "applied" : "not applied"}.
              </Step>
            )}
            {inc.requestFailed && (
              <Step at={inc.requestFailed.timestamp} tx={inc.requestFailed.tx}>
                IMD reported the request failed (status {inc.requestFailed.status}). The desk does not ask twice.
              </Step>
            )}
            {inc.resolved && (
              <Step at={inc.resolved.timestamp} tx={inc.resolved.tx}>
                The hook applied the verdict: trading reopens by {formatClock(inc.resolved.reopensAt)}.
              </Step>
            )}
            {inc.state !== "halted" && <Step at={inc.haltEnd}>The halt ended.</Step>}
            {inc.closed && (
              <Step at={inc.closed.timestamp} tx={inc.closed.tx}>
                The first swap after the halt passed and closed the incident: reference {formatTick(inc.closed.newRef)}, cooldown until{" "}
                {formatClock(inc.closed.cooldownEnd)}.
              </Step>
            )}
            {inc.postMortem && (
              <Step tx={inc.postMortem.tx}>
                The desk commissioned a post-mortem from IMD
                {inc.postMortem.delivered ? (
                  <>
                    : <Out href={inc.postMortem.delivered.uri}>read it</Out>.
                  </>
                ) : (
                  "; it has not been delivered yet."
                )}
              </Step>
            )}
          </ol>
        </section>

        <Question inc={inc} hook={def.hook} pairSymbol={pair?.paired.symbol ?? def.pairedSymbol} pairDecimals={pair?.paired.decimals ?? 18} />
      </div>
    </>
  );
}

function Step({ at, tx, children }: { at?: number; tx?: string; children: ReactNode }) {
  return (
    <li className="seq__step">
      <span className="seq__time">{at !== undefined ? formatClock(at) : ""}</span>
      <p className="seq__text">{children}</p>
      <span className="seq__tx">{tx ? <TxLink hash={tx} /> : null}</span>
    </li>
  );
}

function Question({ inc, hook, pairSymbol, pairDecimals }: { inc: Incident; hook: Address; pairSymbol: string; pairDecimals: number }) {
  const w = inc.window;
  const asked = Boolean(inc.filed);
  const share = inc.answer ? inc.answer.shareBps : inc.tape ? inc.tape.shareBps : null;
  return (
    <>
      <section className="incident__question" aria-labelledby="q-title">
        <div className="question__text">
          <h2 id="q-title" className="sub-title">
            {asked ? "The question the desk asked" : "The question the desk would have asked"}
          </h2>
          {!w ? (
            <p className="muted">The incident window could not be rebuilt from the logs this site has read.</p>
          ) : (
            <>
              <p className="question__lede">
                Built from the hook's address and the incident's block window alone, L2 blocks{" "}
                <a className="hex-link" href={blockUrl(w.fromBlock)} target="_blank" rel="noopener noreferrer">
                  {formatInt(w.fromBlock)}
                </a>{" "}
                to{" "}
                <a className="hex-link" href={blockUrl(w.toBlock)} target="_blank" rel="noopener noreferrer">
                  {formatInt(w.toBlock)}
                </a>
                {w.source === "rebuilt" ? ", rebuilt here from the hook's logs exactly as incidentWindow() reported it." : ", as filed."}
              </p>
              <blockquote className="question">{deskQuestion(hook, w.fromBlock, w.toBlock).question}</blockquote>
              <p className="question__hash">
                Question hash <span className="mono">{shortHex(questionHash(hook, w.fromBlock, w.toBlock), 12, 8)}</span>
                {inc.filed &&
                  (inc.filed.questionHash.toLowerCase() === questionHash(hook, w.fromBlock, w.toBlock).toLowerCase()
                    ? ", the same hash the desk pinned when it filed"
                    : ", which differs from the hash the desk filed")}
                . Only an answer signed over this hash is ever acted on.
              </p>
            </>
          )}
        </div>
        {w && (
          <div className="question__code">
            <CodeBlock label="Canonical question document" code={questionDocument(hook, w.fromBlock, w.toBlock)} />
            <CodeBlock label="oracle.request body: 7 seats, 5 must agree" code={oracleBody(hook, w.fromBlock, w.toBlock)} />
          </div>
        )}
      </section>

      <section className="incident__rule" aria-labelledby="rule-title">
        <h2 id="rule-title" className="sub-title">
          The rule
        </h2>
        <p>
          The oracle returns the top trader and their summed volume; the desk divides by the hook's own on-chain total for the window. Code
          decides, not the panel:
        </p>
        <RuleScale share={share} />
        {inc.answer ? (
          <p className="muted">
            Attested: {formatAmount(inc.answer.figure, pairDecimals)} of {formatAmount(inc.answer.total, pairDecimals)} {pairSymbol}.
          </p>
        ) : inc.tape ? (
          <p className="muted">
            Not attested, measured here from the Trade tape: {inc.tape.trades} trade{inc.tape.trades === 1 ? "" : "s"} by{" "}
            {inc.tape.traders} trader{inc.tape.traders === 1 ? "" : "s"}, {formatAmount(inc.tape.total, pairDecimals)} {pairSymbol} in all
            {inc.tape.leader && (
              <>
                , led by <AddrLink address={inc.tape.leader} />
              </>
            )}
            . {asked ? "" : "Had the desk been able to pay, this is the share the rule would have judged."}
          </p>
        ) : null}
      </section>
    </>
  );
}

/** The verdict scale: organic up to 30%, concentrated from 60%, and the share on it. */
function RuleScale({ share }: { share: number | null }) {
  const pct = share !== null ? share / 100 : null;
  return (
    <figure className="rule" aria-label={`Rule: up to ${ORGANIC_MAX_BPS / 100}% organic, from ${CONCENTRATED_MIN_BPS / 100}% concentrated${pct !== null ? `; this incident ${pct.toFixed(2)}%` : ""}`}>
      <div className="rule__bar">
        <div className="rule__zone rule__zone--organic" style={{ width: `${ORGANIC_MAX_BPS / 100}%` }}>
          <span>Organic: reopen now</span>
        </div>
        <div className="rule__zone rule__zone--mid" style={{ width: `${(CONCENTRATED_MIN_BPS - ORGANIC_MAX_BPS) / 100}%` }}>
          <span>No change</span>
        </div>
        <div className="rule__zone rule__zone--conc" style={{ width: `${100 - CONCENTRATED_MIN_BPS / 100}%` }}>
          <span>Concentrated: keep the halt, pin the price</span>
        </div>
        {pct !== null && (
          <div className="rule__needle" style={{ left: `${Math.min(100, pct)}%` }}>
            <span>{pct.toFixed(pct % 1 === 0 ? 0 : 2)}%</span>
          </div>
        )}
      </div>
      <div className="rule__ticks" aria-hidden="true">
        <span style={{ left: "0%" }}>0</span>
        <span style={{ left: "30%" }}>30%</span>
        <span style={{ left: "60%" }}>60%</span>
        <span style={{ left: "100%" }}>100%</span>
      </div>
    </figure>
  );
}
