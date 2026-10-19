import { useEffect, useRef, useState, type ReactNode } from "react";
import { addressUrl, txUrl } from "../lib/chain";
import { shortHex } from "../lib/format";
import type { PhaseName } from "../lib/phase";
import { href, type Route } from "../lib/router";

export function Link({ to, className, children }: { to: Route; className?: string; children: ReactNode }) {
  return (
    <a className={className} href={href(to)}>
      {children}
    </a>
  );
}

/** A link that leaves the site, opened beside it. */
export function Out({ href: url, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
    </a>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <Out className="hex-link" href={txUrl(hash)} title={`Transaction ${hash} on the Robinhood Chain explorer`}>
      {label ?? shortHex(hash)}
    </Out>
  );
}

export function AddrLink({ address, label }: { address: string; label?: string }) {
  return (
    <Out className="hex-link" href={addressUrl(address)} title={`${address} on the Robinhood Chain explorer`}>
      {label ?? shortHex(address)}
    </Out>
  );
}

export function Wordmark() {
  return (
    <span className="mark">
      <i aria-hidden="true" />
      Curb
    </span>
  );
}

/** The phase as a mark that does not rely on colour: ring, half, solid, dashed. */
export function PhaseMark({ phase }: { phase: PhaseName | "refused" | "pass" | "launching" }) {
  return <i className={`phase-mark phase-mark--${phase}`} aria-hidden="true" />;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button type="button" className="chip-button" onClick={copy}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}</span>
    </button>
  );
}

/** A code block with its own copy button. */
export function CodeBlock({ code, label, copyLabel }: { code: string; label: string; copyLabel?: string }) {
  return (
    <figure className="code">
      <figcaption className="code__bar">
        <span>{label}</span>
        <CopyButton text={code} label={copyLabel} />
      </figcaption>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** A loading or failure line that holds its place, so data never jumps in. */
export function Notice({ tone = "quiet", children }: { tone?: "quiet" | "error"; children: ReactNode }) {
  return (
    <p className={`notice notice--${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}
