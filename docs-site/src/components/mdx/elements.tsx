import Link from "next/link";
import { Link2 } from "lucide-react";
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode, TableHTMLAttributes } from "react";

export function Anchor({ href = "", children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

function heading(Tag: "h2" | "h3") {
  return function Heading({ id, children, ...rest }: HTMLAttributes<HTMLHeadingElement> & { children?: ReactNode }) {
    return (
      <Tag id={id} {...rest}>
        {id ? (
          <a href={`#${id}`} className="heading-anchor">
            {children}
            <Link2 size={14} aria-hidden className="heading-anchor-icon" />
          </a>
        ) : (
          children
        )}
      </Tag>
    );
  };
}

export const H2 = heading("h2");
export const H3 = heading("h3");

export function Table(props: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-wrap">
      <table {...props} />
    </div>
  );
}
