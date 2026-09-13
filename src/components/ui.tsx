import { useState, type ReactNode } from 'react';

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Mono({ value, max = 18 }: { value: string; max?: number }) {
  const short = value.length > max ? `${value.slice(0, max)}…${value.slice(-6)}` : value;
  return (
    <span className="mono" title={value}>
      {short}
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls =
    tone === 'ok' ? 'pill pill-ok' : tone === 'warn' ? 'pill pill-warn' : tone === 'bad' ? 'pill pill-bad' : 'pill';
  return <span className={cls}>{children}</span>;
}

export function Banner({
  tone,
  children,
  'data-testid': testId,
}: {
  tone: Tone;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const cls = tone === 'bad' ? 'banner banner-bad' : tone === 'warn' ? 'banner banner-warn' : 'banner';
  return (
    <div className={cls} role={tone === 'bad' ? 'alert' : undefined} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * A labelled disclosure. Used for "what am I signing": the canonical challenge text is the
 * thing the wallet will actually sign, so it must be available byte for byte, but it is nine
 * lines of protocol on a phone screen and it must not be the first thing a buyer meets.
 */
export function Disclosure({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="disclose"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
      >
        {open ? `Hide — ${label}` : label}
      </button>
      {open ? children : null}
    </div>
  );
}

export interface Step {
  label: string;
  sub?: string;
  status: 'done' | 'now' | 'todo' | 'bad';
}

export function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ul className="timeline">
      {steps.map((step) => (
        <li key={step.label}>
          <span
            className={
              step.status === 'done'
                ? 'dot dot-done'
                : step.status === 'now'
                  ? 'dot dot-now'
                  : step.status === 'bad'
                    ? 'dot dot-bad'
                    : 'dot'
            }
          />
          <span>
            <span className="label">{step.label}</span>
            {step.sub ? (
              <>
                <br />
                <span className="sub">{step.sub}</span>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function toneForState(state: string): Tone {
  if (state === 'REFUNDED' || state === 'PAID') return 'ok';
  if (state === 'REFUND_FAILED' || state === 'REJECTED' || state === 'EXPIRED') return 'bad';
  return 'warn';
}

export function timeAgo(ms: number | null, nowMs = Date.now()): string {
  if (ms === null) return 'never';
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
