import { useEffect, useRef, useState, type ReactNode } from "react";
import { deployments, REPO_URL } from "../lib/deployments";
import type { Route } from "../lib/router";
import { AddrLink, Link, Out, Wordmark } from "./ui";

const LINKS: { route: Route; label: string; match: Route["name"][] }[] = [
  { route: { name: "board" }, label: "Board", match: ["board"] },
  { route: { name: "break" }, label: "Try to break it", match: ["break"] },
  { route: { name: "incidents" }, label: "Incidents", match: ["incidents", "incident"] },
  { route: { name: "docs" }, label: "Docs", match: ["docs"] },
];

export function TopNav({ route, overlay = false }: { route: Route; overlay?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);
  return (
    <header className={overlay ? "topbar topbar--overlay" : "topbar"}>
      <Link to={{ name: "landing" }} className="topbar__home">
        <Wordmark />
        <span className="sr-only">home</span>
      </Link>
      <button
        type="button"
        className="topbar__menu"
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Close" : "Menu"}
      </button>
      <nav id="site-nav" className={open ? "topbar__nav is-open" : "topbar__nav"} aria-label="Site">
        {LINKS.map((l) => (
          <a
            key={l.label}
            href={`#/${l.route.name}`}
            className="topbar__link"
            aria-current={l.match.includes(route.name) ? "page" : undefined}
          >
            {l.label}
          </a>
        ))}
        <a className="topbar__launch" href="#/launch" aria-current={route.name === "launch" ? "page" : undefined}>
          Launch with Curb
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-foot__in">
        <p className="site-foot__line">
          <Wordmark />
          <span>Agents measure, contracts decide.</span>
        </p>
        <ul className="site-foot__links">
          <li>
            <Out href={REPO_URL}>Source on GitHub</Out>
          </li>
          <li>
            <Out href={`${REPO_URL}/blob/main/docs/VERIFICATION.md`}>Verification</Out>
          </li>
          <li>
            <Out href={`${REPO_URL}/blob/main/FAILURE-MODES.md`}>Failure modes</Out>
          </li>
          <li>
            Desk <AddrLink address={deployments.desk} />
          </li>
          <li>Robinhood Chain 4663 · MIT</li>
        </ul>
      </div>
    </footer>
  );
}

/** The app surface: nav, the page, and focus moved to the page on every route change. */
export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [route]);
  return (
    <div className="app">
      <div className="app__rules" aria-hidden="true" />
      <a className="skip" href="#main" onClick={(e) => (e.preventDefault(), main.current?.focus())}>
        Skip to content
      </a>
      <TopNav route={route} />
      <main id="main" ref={main} tabIndex={-1} className="app__main">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
