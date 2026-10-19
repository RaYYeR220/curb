import type { ReactNode } from "react";

export function PageHead({ title, lede, aside, back }: { title: string; lede?: ReactNode; aside?: ReactNode; back?: ReactNode }) {
  return (
    <section className="page-head">
      {back && <p className="page-head__back">{back}</p>}
      <div className="page-head__row">
        <h1 className="page-head__title">{title}</h1>
        {aside && <div className="page-head__aside">{aside}</div>}
      </div>
      {lede && <p className="page-head__lede">{lede}</p>}
    </section>
  );
}
