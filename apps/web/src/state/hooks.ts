import { useEffect, useState } from "react";
import { parseHash, type Route } from "../lib/router";

/** The current hash route. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Chain time in seconds, ticking once a second. `offset` is chain time minus local time. */
export function useNow(offset = 0, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000 + offset);
  useEffect(() => {
    setNow(Date.now() / 1000 + offset);
    const id = setInterval(() => setNow(Date.now() / 1000 + offset), everyMs);
    return () => clearInterval(id);
  }, [offset, everyMs]);
  return now;
}

export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** An element's content width, following resizes. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}
