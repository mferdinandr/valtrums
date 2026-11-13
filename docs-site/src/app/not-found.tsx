import Link from "next/link";

export default function NotFound() {
  return (
    <div className="not-found">
      <p className="eyebrow">404</p>
      <h1>This page wandered off.</h1>
      <p className="doc-description">The page you are looking for doesn&apos;t exist or has moved.</p>
      <Link href="/" className="header-cta">
        Back to the docs
      </Link>
    </div>
  );
}
