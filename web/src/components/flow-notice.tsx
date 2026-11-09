import Link from "next/link";

export function FlowNotice({ compact = false }: { compact?: boolean }) {
  return (
    <aside className="flow-notice" aria-label="Current application capabilities">
      <span className="flow-notice-badge">CURRENT EXPERIENCE</span>
      <div>
        <p className="font-semibold text-ink">You are using the existing two-community arena.</p>
        {!compact && <p className="mt-1 text-xs leading-6 text-mute">Battles here use the current bond, deposit and settlement rules. Multi-community rounds, original-token rewards and DAO escrow are planned and are not available in this interface yet.</p>}
      </div>
      {compact && <Link href="/#product-flow" className="text-xs text-neon-green underline">See the planned flow</Link>}
    </aside>
  );
}
