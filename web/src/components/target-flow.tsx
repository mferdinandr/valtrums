import Link from "next/link";

const CONTENT = {
  arena: { label: "THE NEXT ARENA", title: "More communities. One winner.", description: "The planned arena brings two or more communities into 30-second rounds, with a scoring mode chosen by the creator.", steps: ["2+ communities", "4 scoring modes", "30-second rounds", "Overtime on ties"] },
  create: { label: "PLANNED CREATION FLOW", title: "Build a multi-community battle", description: "The target flow will let a creator choose at least two communities and one scoring mode, then make a backed deposit. No proposal bond is specified for the target.", steps: ["Choose communities", "Choose scoring mode", "Audit & verify", "Creator deposits"] },
  battle: { label: "PLANNED BATTLE FLOW", title: "From deposits to a final winner", description: "After verified deposits lock, a 30-second round is scored. Tied leaders continue in fresh rounds while all vaults remain locked.", steps: ["Audit & gather", "Lock vaults", "30-second round", "Overtime if tied"] },
  portfolio: { label: "PLANNED OUTCOME", title: "Rewards and principal follow separate paths", description: "Winners share each losing meme coin as a separate entitlement. Winning principal remains in DAO escrow until a decision to burn or return it; the governance rules are still open.", steps: ["Original-token rewards", "Payout status", "Principal in escrow", "DAO: burn or return"] },
  terminal: { label: "PLANNED AGENT FLOW", title: "Player-controlled participation", description: "The target includes user-funded player agents with explicit limits on assets, spending, destinations and time. This terminal currently uses the existing arena flow.", steps: ["Set permissions", "Choose a battle", "Review action", "Track outcome"] },
} as const;

export function TargetFlow({ page }: { page: keyof typeof CONTENT }) {
  const content = CONTENT[page];
  return <section className="target-flow" aria-label={content.label}>
    <div className="target-flow-top"><div><p className="eyebrow text-neon-green">{content.label} / PLANNED</p><h2 className="mt-3 text-2xl">{content.title}</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-mute">{content.description}</p></div><span className="target-flow-status">NOT AVAILABLE YET</span></div>
    <ol className="target-flow-steps">{content.steps.map((step, index) => <li key={step}><span>0{index + 1}</span>{step}</li>)}</ol>
    <p className="mt-4 text-xs leading-6 text-mute">Preview of the target product, not the rules of the current arena. <Link className="text-neon-green underline" href="/#product-flow">Explore the full flow</Link></p>
  </section>;
}
