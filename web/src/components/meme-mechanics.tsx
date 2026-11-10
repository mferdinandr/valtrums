import Link from "next/link";

/** An illustrative scenario, not derived from a battle or wallet. */
export function MemeMechanics({ compact = false }: { compact?: boolean }) {
  return (
    <section className="meme-mechanics" aria-label="Planned meme coin mechanics">
      <div className="target-flow-top">
        <div><p className="eyebrow text-neon-green">MEME COINS WITH MECHANICS / PLANNED</p><h2 className="mt-3 text-2xl">Your tribe wins. Rival tokens become rewards.</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-mute">Each losing vault is allocated in its own token. A winner’s share is proportional to their locked stake in the winning community.</p></div>
        <span className="target-flow-status">ILLUSTRATIVE EXAMPLE</span>
      </div>
      {!compact && <div className="meme-example">
        <div className="meme-example-intro"><span>YOUR POSITION</span><strong>50% of the winning vault</strong><small>Example only · user-created battle · default fee</small></div>
        <div className="meme-example-row"><span>Rival vault A <small>100,000 token A</small></span><strong>49,950 token A</strong></div>
        <div className="meme-example-row"><span>Rival vault B <small>200,000 token B</small></span><strong>99,900 token B</strong></div>
        <p className="meme-example-note">The winning community shares 99.9% of each losing vault. At default settings, 0.05% goes to the creator and 0.05% to the protocol; rounding applies. Fees can change for future battles.</p>
      </div>}
      <div className="meme-paths"><div><span>01 / RIVAL TOKENS</span><p>Separate reward entitlements, paid in original tokens. Available does not mean paid.</p></div><div><span>02 / YOUR PRINCIPAL</span><p>Winning principal enters DAO escrow. Burn or return requires a DAO decision; governance rules remain open.</p></div></div>
      <p className="mt-4 text-xs leading-6 text-mute">Planned mechanics, not current settlement. Deposited tokens can be lost. <Link href="/#product-flow" className="text-neon-green underline">See the planned flow</Link></p>
    </section>
  );
}
