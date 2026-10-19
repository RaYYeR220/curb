import { lazy, Suspense, useEffect } from "react";
import { Shell } from "./components/Shell";
import { PageHead } from "./components/PageHead";
import { Landing } from "./pages/Landing";
import type { Route } from "./lib/router";
import { useRoute } from "./state/hooks";

// The landing ships alone; the app pages, which carry the chain client, load when visited.
const Board = lazy(() => import("./pages/Board").then((m) => ({ default: m.Board })));
const Break = lazy(() => import("./pages/Break").then((m) => ({ default: m.Break })));
const Incidents = lazy(() => import("./pages/Incidents").then((m) => ({ default: m.Incidents })));
const IncidentPage = lazy(() => import("./pages/Incidents").then((m) => ({ default: m.IncidentPage })));
const Launch = lazy(() => import("./pages/Launch").then((m) => ({ default: m.Launch })));
const Docs = lazy(() => import("./pages/Docs").then((m) => ({ default: m.Docs })));

const TITLES: Record<Route["name"], string> = {
  landing: "Curb: circuit breakers for Uniswap v4 pools",
  board: "Live board: Curb",
  break: "Try to break it: Curb",
  incidents: "Incidents: Curb",
  incident: "Incident: Curb",
  launch: "Launch with Curb",
  docs: "Docs: Curb",
  notfound: "Nothing here: Curb",
};

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "board":
      return <Board />;
    case "break":
      return <Break />;
    case "incidents":
      return <Incidents />;
    case "incident":
      return <IncidentPage key={`${route.hook}/${route.nonce}`} hook={route.hook} nonce={route.nonce} />;
    case "launch":
      return <Launch />;
    case "docs":
      return <Docs />;
    default:
      return (
        <PageHead
          title="Nothing here"
          lede={
            <>
              There is no page at <code>{route.name === "notfound" ? route.path : ""}</code>. The <a href="#/board">board</a> shows every
              live pool.
            </>
          }
        />
      );
  }
}

export function App() {
  const route = useRoute();
  useEffect(() => {
    document.title = route.name === "incident" ? `Halt ${route.nonce}: Curb` : TITLES[route.name];
  }, [route]);
  return (
    <>
      <div className="grain" aria-hidden="true" />
      {route.name === "landing" ? (
        <Landing />
      ) : (
        <Shell route={route}>
          <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
            <Page route={route} />
          </Suspense>
        </Shell>
      )}
    </>
  );
}
