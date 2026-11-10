import { config } from "@/lib/config";

/** A submitted hash is viewable even when its outcome is still unconfirmed. */
export function TransactionLink({ hash }: { hash?: string | null }) {
  if (!hash) return null;
  return <a className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4" href={`${config.explorerUrl}/txns/${encodeURIComponent(hash)}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>;
}
