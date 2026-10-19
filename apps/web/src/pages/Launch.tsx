import { useMemo, useState, type ChangeEvent } from "react";
import { PageHead } from "../components/PageHead";
import { CodeBlock, Out } from "../components/ui";
import { txUrl } from "../lib/chain";
import { deployments, REPO_URL } from "../lib/deployments";
import {
  buildManifest,
  buildRequestBody,
  checkPayload,
  CURB_PARAMS,
  curlCheck,
  curlImport,
  describeParams,
  IMD_CHECK_URL,
  validateLaunch,
  type LaunchErrors,
  type LaunchInput,
  type LaunchParams,
} from "../lib/launch";

type Form = Omit<LaunchInput, "params" | "poolBps"> & { poolBps: string; params: Record<keyof LaunchParams, string> };

const PARAM_FIELDS: { key: keyof LaunchParams; label: string; unit: string; hint: string }[] = [
  { key: "bandTicks", label: "Band", unit: "ticks", hint: "How far from the reference a swap may end." },
  { key: "edgeTicks", label: "Edge zone", unit: "ticks", hint: "The outer part of the band where the limit clock runs." },
  { key: "refWindow", label: "Reference window", unit: "s", hint: "The time-weighted average the band centres on." },
  { key: "limitSeconds", label: "Limit state", unit: "s", hint: "How long at the edge before the pool halts." },
  { key: "haltSeconds", label: "Halt, at most", unit: "s", hint: "A halt ends on its own after this." },
  { key: "cooldownSeconds", label: "Cooldown", unit: "s", hint: "Spacing before the next halt can start." },
  { key: "minLiquidityE18", label: "No-market floor", unit: "×1e18", hint: "In-range liquidity below this counts as no market." },
];

const stringParams = (p: LaunchParams) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])) as Record<keyof LaunchParams, string>;

const initial: Form = {
  name: "Curb",
  symbol: "CURB",
  owner: deployments.desk,
  remainderTo: deployments.desk,
  poolBps: "9000",
  repoUrl: `${REPO_URL}.git`,
  baseCommit: deployments.launch?.baseCommit ?? "",
  params: stringParams(CURB_PARAMS),
};

function toInput(f: Form): LaunchInput {
  const params = Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, v.trim() === "" ? NaN : Number(v)])) as unknown as LaunchParams;
  return { ...f, poolBps: f.poolBps.trim() === "" ? NaN : Number(f.poolBps), params };
}

type Check = { state: "idle" } | { state: "checking" } | { state: "ok"; body: string } | { state: "blocked"; reason: string };

export function Launch() {
  const [form, setForm] = useState<Form>(initial);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const input = useMemo(() => toInput(form), [form]);
  const errors: LaunchErrors = useMemo(() => validateLaunch(input), [input]);
  const valid = Object.keys(errors).length === 0;
  const manifest = valid ? JSON.stringify(buildManifest(input), null, 2) : null;
  const body = valid ? buildRequestBody(input) : null;

  const set = (k: keyof Omit<Form, "params">) => (e: ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setCheck({ state: "idle" });
  };
  const setParam = (k: keyof LaunchParams) => (e: ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, params: { ...f.params, [k]: e.target.value } }));
    setCheck({ state: "idle" });
  };

  const runCheck = async () => {
    if (!body) return;
    setCheck({ state: "checking" });
    try {
      const res = await fetch(IMD_CHECK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkPayload(body)),
      });
      const text = await res.text();
      if (res.status === 403 && text.includes("origin_not_allowed")) {
        setCheck({ state: "blocked", reason: "IMD's API answered origin_not_allowed: it only takes requests from its own sites." });
      } else {
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Not JSON; show it as sent.
        }
        setCheck({ state: "ok", body: `HTTP ${res.status}\n${pretty}` });
      }
    } catch {
      setCheck({ state: "blocked", reason: "The browser blocked the request: IMD's API does not allow calls from other sites." });
    }
  };

  const download = () => {
    if (!manifest) return;
    const url = URL.createObjectURL(new Blob([manifest + "\n"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "launch.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <PageHead
        title="Launch with Curb"
        lede="Your token, Curb's hook, launched through Identity MD. Fill this in to get the launch.json manifest for your repository and the launch.open request IMD charges for, then run IMD's free check before paying anything."
      />
      <div className="wizard">
        <form className="wizard__form" onSubmit={(e) => e.preventDefault()} noValidate>
          <fieldset className="group">
            <legend className="group__title">Token</legend>
            <Field id="name" label="Name" value={form.name} onChange={set("name")} error={errors.name} />
            <Field id="symbol" label="Symbol" value={form.symbol} onChange={set("symbol")} error={errors.symbol} mono />
            <p className="hint">
              src/CurbToken.sol writes its name and symbol into its constructor. Change them there in your fork to match.
            </p>
          </fieldset>

          <fieldset className="group">
            <legend className="group__title">Who controls it</legend>
            <Field
              id="owner"
              label="Hook owner"
              value={form.owner}
              onChange={set("owner")}
              error={errors.owner}
              mono
              hint="The one address that may resolve halts: a CurbDesk, or your own contract. It can shorten a halt or pin a price, never lengthen a halt or move funds."
            />
            <Field
              id="remainderTo"
              label="Fee remainder to"
              value={form.remainderTo}
              onChange={set("remainderTo")}
              error={errors.remainderTo}
              mono
            />
            <Field id="poolBps" label="Pool share" value={form.poolBps} onChange={set("poolBps")} error={errors.poolBps} unit="bps" numeric />
          </fieldset>

          <fieldset className="group">
            <legend className="group__title">Breaker</legend>
            <div className="group__grid">
              {PARAM_FIELDS.map((p) => (
                <Field
                  key={p.key}
                  id={p.key}
                  label={p.label}
                  value={form.params[p.key]}
                  onChange={setParam(p.key)}
                  error={errors[p.key]}
                  unit={p.unit}
                  hint={p.hint}
                  numeric
                />
              ))}
            </div>
            <button
              type="button"
              className="chip-button"
              onClick={() => setForm((f) => ({ ...f, params: stringParams(CURB_PARAMS) }))}
            >
              Use CURB/IMD's parameters
            </button>
          </fieldset>

          <fieldset className="group">
            <legend className="group__title">Source</legend>
            <Field id="repoUrl" label="Repository" value={form.repoUrl} onChange={set("repoUrl")} error={errors.repoUrl} mono />
            <Field id="baseCommit" label="Commit" value={form.baseCommit} onChange={set("baseCommit")} error={errors.baseCommit} mono />
          </fieldset>
        </form>

        <div className="wizard__out">
          {!valid ? (
            <div className="card wizard__blocked">
              <p className="verdict__word verdict__word--small">Not ready</p>
              <p>
                Fix the {Object.keys(errors).length === 1 ? "field" : `${Object.keys(errors).length} fields`} marked on the left; the hook's
                constructor would refuse these values.
              </p>
            </div>
          ) : (
            <>
              <section className="summary" aria-labelledby="summary-title">
                <h2 id="summary-title" className="sub-title">
                  What this pool will do
                </h2>
                <dl className="facts facts--tight">
                  {describeParams(input.params).map((d) => (
                    <div key={d.label}>
                      <dt>{d.label}</dt>
                      <dd>{d.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <ol className="steps">
                <li className="steps__item">
                  <h3 className="steps__title">Commit launch.json to your repository's root</h3>
                  <CodeBlock label="launch.json" code={manifest!} />
                  <button type="button" className="chip-button" onClick={download}>
                    Download launch.json
                  </button>
                </li>
                <li className="steps__item">
                  <h3 className="steps__title">Run IMD's free checks</h3>
                  <p>
                    <code>POST /requests/check</code> answers with any blockers before you pay. IMD's admission parks about 29% of hook launches
                    after payment, with no refund, so do not skip it.
                  </p>
                  <div className="check">
                    <button type="button" className="cta cta--form" onClick={runCheck} disabled={check.state === "checking"}>
                      {check.state === "checking" ? "Checking…" : "Run the free check"}
                    </button>
                    {check.state === "ok" && <CodeBlock label="IMD's answer" code={check.body} />}
                    {check.state === "blocked" && (
                      <p className="hint hint--error" role="status">
                        {check.reason} Run the same check from a terminal:
                      </p>
                    )}
                  </div>
                  <CodeBlock label="The same check with curl" code={curlCheck(body!)} />
                  <p>
                    Then have IMD import the exact commit the body names; the <code>baseCommit</code> it reports back must
                    be the same one.
                  </p>
                  <CodeBlock label="Import the commit" code={curlImport(input.repoUrl, input.baseCommit)} />
                </li>
                <li className="steps__item">
                  <h3 className="steps__title">Send launch.open</h3>
                  <p>
                    Pay for the launch with this body through IMD's Intake, the way the CurbDesk did for CURB in{" "}
                    {deployments.launch?.payment ? (
                      <Out className="hex-link" href={txUrl(deployments.launch.payment)}>
                        this transaction
                      </Out>
                    ) : (
                      "its launch transaction"
                    )}
                    .
                  </p>
                  <CodeBlock label="launch.open request body" code={JSON.stringify(body, null, 2)} />
                </li>
              </ol>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  unit,
  mono,
  numeric,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  hint?: string;
  unit?: string;
  mono?: boolean;
  numeric?: boolean;
}) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={error ? "field has-error" : "field"}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="amount">
        <input
          id={id}
          className={mono ? "mono" : undefined}
          value={value}
          onChange={onChange}
          inputMode={numeric ? "numeric" : undefined}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
        />
        {unit && <span className="amount__unit">{unit}</span>}
      </div>
      {error && (
        <p id={`${id}-error`} className="hint hint--error">
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}
