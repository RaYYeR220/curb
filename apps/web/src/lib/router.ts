import { isAddress, type Address } from "viem";

export type Route =
  | { name: "landing" }
  | { name: "board" }
  | { name: "break" }
  | { name: "incidents" }
  | { name: "incident"; hook: Address; nonce: number }
  | { name: "launch" }
  | { name: "docs" }
  | { name: "notfound"; path: string };

/** Reads a location hash such as `#/incidents/0xabc…/0`. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "landing" };
  const [head, a, b] = parts;
  if (parts.length === 1) {
    if (head === "board" || head === "break" || head === "incidents" || head === "launch" || head === "docs") {
      return { name: head };
    }
  }
  if (head === "incidents" && parts.length === 3 && a && b && isAddress(a) && /^\d+$/.test(b)) {
    return { name: "incident", hook: a, nonce: Number(b) };
  }
  return { name: "notfound", path };
}

export function href(route: Route): string {
  switch (route.name) {
    case "landing":
      return "#/";
    case "incident":
      return `#/incidents/${route.hook}/${route.nonce}`;
    case "notfound":
      return `#${route.path}`;
    default:
      return `#/${route.name}`;
  }
}
