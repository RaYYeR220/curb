import { useRef } from "react";
import { ChannelField } from "../components/ChannelField";
import { SiteFooter, TopNav } from "../components/Shell";
import { Out, TxLink } from "../components/ui";
import { deployments, DRILL_STEPS, REPO_URL } from "../lib/deployments";

const VERBS = [
  {
    title: "Refuse past the band",
    body: "A swap that would end more than 1,000 ticks (about 10.5%) from the pool's five-minute reference, further from it than it started, reverts whole. The revert names the reference, where the swap would have ended and the limit it crossed. A swap back toward the reference always passes.",
    fact: "OutsideBand(ref, tickAfter, limit, zeroForOne)",
  },
  {
    title: "Halt at the edge",
    body: "A price that holds in the band's outer 100 ticks for 15 seconds halts the pool in both directions, for at most 15 minutes. Nobody has to press a button: the halt ends on its own, and a 30-minute cooldown spaces the next one.",
    fact: "Halted(nonce, reopensAt)",
  },
  {
    title: "Let the swarm shorten it",
    body: "During a halt the desk asks the IMD oracle one question about the pool's own trade tape: which trader moved the most volume. If that trader did 30% or less, the move was organic and the pool reopens now. At 60% or more, one actor drove it: the pool sits out the halt and keeps the pre-move price.",
    fact: "≤ 30% reopen now · ≥ 60% keep the halt",
  },
];

export function Landing() {
  const hero = useRef<HTMLElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const proofs = deployments.proofs?.drill ?? {};
  const toHow = () => {
    const el = document.getElementById("how");
    el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  };

  return (
    <div className="landing">
      <header className="hero" ref={hero}>
        <div className="hero__rules" aria-hidden="true" />
        <ChannelField host={hero} clearOf={col} />
        <TopNav route={{ name: "landing" }} overlay />
        <div className="hero__col" ref={col}>
          <p className="eyebrow rise d1">Circuit breakers for Uniswap v4 · Robinhood Chain</p>
          <h1 className="hero__title">
            <span className="ln">Some swaps</span>
            <span className="ln">shouldn’t happen.</span>
          </h1>
          <p className="hero__sub rise d2">
            Curb puts exchange-style limit bands on Uniswap v4 pools on Robinhood Chain. A swap that would leave the band
            is refused on-chain, with the reason. A price pinned at the edge halts the pool, then it reopens on its own.
          </p>
          <div className="hero__actions rise d3">
            <a className="cta" href="#/break">
              Try to break it <span aria-hidden="true">→</span>
            </a>
            <button type="button" className="quiet" onClick={toHow}>
              How it works
            </button>
          </div>
        </div>
        <div className="hero__foot">
          <span>Agents measure, contracts decide.</span>
          <span className="legend">
            <b>limit ±10.5%</b>
            <b className="legend__ref">reference</b>
          </span>
        </div>
        <div className="hero__ruler" aria-hidden="true" />
      </header>

      <section id="how" className="section how" tabIndex={-1} aria-labelledby="how-title">
        <div className="section__in">
          <h2 id="how-title" className="section__title">
            How it works
          </h2>
          <p className="section__lede">
            Stock exchanges have run Limit Up–Limit Down since 2013. Curb is that rule inside a v4 hook: three steps, each
            one enforced by the pool itself.
          </p>
          <ol className="verbs">
            {VERBS.map((v, i) => (
              <li key={v.title} className="verbs__item">
                <span className="verbs__n">{i + 1}</span>
                <h3 className="verbs__title">{v.title}</h3>
                <p className="verbs__body">{v.body}</p>
                <p className="verbs__fact">{v.fact}</p>
              </li>
            ))}
          </ol>
          <p className="how__note">
            The swarm can shorten a halt or decline to bless a price level. It can never lengthen a halt or touch funds.
          </p>
        </div>
      </section>

      <section className="section proof" aria-labelledby="proof-title">
        <div className="section__in">
          <h2 id="proof-title" className="section__title">
            The drill, on mainnet
          </h2>
          <p className="section__lede">
            Five transactions on the DRILL/ETH drill pool walk the whole path on Robinhood Chain. Each one opens on the
            explorer.
          </p>
          <ol className="drill">
            {DRILL_STEPS.map((s, i) => {
              const hash = proofs[s.key];
              return (
                <li key={s.key} className="drill__step">
                  <span className="drill__n">{i + 1}</span>
                  <div className="drill__text">
                    <h3 className="drill__title">{s.title}</h3>
                    <p className="drill__body">{s.body}</p>
                  </div>
                  <div className="drill__tx">
                    <span className={`outcome outcome--${s.outcome}`}>{s.outcome === "refused" ? "Reverted" : "Passed"}</span>
                    {hash ? <TxLink hash={hash} /> : <span className="muted">not recorded</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="section onward" aria-labelledby="onward-title">
        <div className="section__in onward__in">
          <h2 id="onward-title" className="section__title">
            Watch it, then use it
          </h2>
          <ul className="onward__links">
            <li>
              <a href="#/board">
                <b>Live board</b>
                <span>Each pool's phase, band and countdowns, read from its hook every ten seconds.</span>
              </a>
            </li>
            <li>
              <a href="#/incidents">
                <b>Incidents</b>
                <span>Every halt, the question the desk asks about it, and what was decided.</span>
              </a>
            </li>
            <li>
              <a href="#/launch">
                <b>Launch with Curb</b>
                <span>Your token, Curb's hook: the manifest and the IMD request, checked for free.</span>
              </a>
            </li>
            <li>
              <a href="#/docs">
                <b>Docs</b>
                <span>Parameters, how to read a refusal, verification, the MCP server.</span>
              </a>
            </li>
            <li>
              <Out href={REPO_URL}>
                <b>Source</b>
                <span>Contracts and their tests, the SDK, the CLI and this site. MIT.</span>
              </Out>
            </li>
          </ul>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
