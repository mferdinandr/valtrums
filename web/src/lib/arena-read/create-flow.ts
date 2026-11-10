import { previewMismatches, type CallReview } from "./create-review";
import { previewTerminalAction, type ActionClientDeps, type PreviewedAction } from "@/lib/terminal/actions";

export type PreviewOutcome =
  | { step: "previewed"; previewed: PreviewedAction }
  | { step: "blocked"; reasons: string[] };

/**
 * Asks the action service for the canonical preview and compares it with the call the user reviewed. It
 * never authorizes or signs: the caller may continue to `executeTerminalAction` only on `previewed`, so a
 * preview that differs in account, contract, method, arguments or deposit stops the flow before the wallet
 * is asked for anything.
 */
export async function previewCreate(
  request: Record<string, unknown>, review: CallReview, account: string, deps: ActionClientDeps,
): Promise<PreviewOutcome> {
  const previewed = await previewTerminalAction(request, deps);
  const reasons = previewMismatches(previewed.record.preview as never, review, account);
  return reasons.length > 0 ? { step: "blocked", reasons } : { step: "previewed", previewed };
}
