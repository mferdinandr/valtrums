import Link from "next/link";
import type { ReactNode } from "react";
import {
  ChartLine,
  Coins,
  Info as InfoIcon,
  Lightbulb,
  LogIn,
  Plus,
  Rocket,
  StickyNote,
  Swords,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "chart-line": ChartLine,
  coins: Coins,
  "log-in": LogIn,
  plus: Plus,
  rocket: Rocket,
  swords: Swords,
};

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="steps">{children}</ol>;
}

export function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="step">
      <p className="step-title">{title}</p>
      <div className="step-body">{children}</div>
    </li>
  );
}

export function Columns({ cols = 2, children }: { cols?: number; children: ReactNode }) {
  return (
    <div className="columns" style={{ ["--cols" as string]: String(cols) }}>
      {children}
    </div>
  );
}

export function Card({
  title,
  icon,
  href,
  children,
}: {
  title: string;
  icon?: string;
  href?: string;
  children: ReactNode;
}) {
  const Icon = icon ? ICONS[icon] : undefined;
  const body = (
    <>
      {Icon && (
        <span className="card-icon" aria-hidden>
          <Icon size={18} />
        </span>
      )}
      <span className="card-title">{title}</span>
      <span className="card-body">{children}</span>
    </>
  );
  return href ? (
    <Link href={href} className="card card-link">
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  );
}

type CalloutKind = "note" | "info" | "tip" | "warning";

const CALLOUT_ICONS: Record<CalloutKind, LucideIcon> = {
  note: StickyNote,
  info: InfoIcon,
  tip: Lightbulb,
  warning: TriangleAlert,
};

function Callout({ kind, children }: { kind: CalloutKind; children: ReactNode }) {
  const Icon = CALLOUT_ICONS[kind];
  return (
    <div className={`callout callout-${kind}`} role={kind === "warning" ? "note" : undefined}>
      <Icon size={18} className="callout-icon" aria-hidden />
      <div className="callout-body">{children}</div>
    </div>
  );
}

export const Note = ({ children }: { children: ReactNode }) => <Callout kind="note">{children}</Callout>;
export const Info = ({ children }: { children: ReactNode }) => <Callout kind="info">{children}</Callout>;
export const Tip = ({ children }: { children: ReactNode }) => <Callout kind="tip">{children}</Callout>;
export const Warning = ({ children }: { children: ReactNode }) => <Callout kind="warning">{children}</Callout>;

export function AccordionGroup({ children }: { children: ReactNode }) {
  return <div className="accordion-group">{children}</div>;
}

export function Accordion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="accordion">
      <summary>{title}</summary>
      <div className="accordion-body">{children}</div>
    </details>
  );
}
