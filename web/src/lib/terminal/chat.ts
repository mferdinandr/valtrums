// The Terminal conversation: a list of turns, each a prompt of the user and the Terminal's answer. Kept free of React so
// the rules that matter for safety can be tested: only the latest answered turn is interactive (its review, signing and
// choice buttons are live); every earlier turn is a static summary, so a stale review can never be signed by accident.

import type { LifecycleIntent, LifecycleParseResult } from "./lifecycle-intent";

export interface Turn {
  id: number;
  /** What the user typed, or the label of the choice they made ("Use arena #12"). */
  prompt: string;
  /** Null while the Terminal is still reading the prompt. */
  result: LifecycleParseResult | null;
}

export interface Chat {
  turns: Turn[];
  nextId: number;
}

/** Older turns are dropped past this many, so a long session cannot grow without bound. */
export const MAX_TURNS = 30;
export const emptyChat = (): Chat => ({ turns: [], nextId: 1 });

const cap = (turns: Turn[]): Turn[] => (turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns);

/** Adds the user's prompt with the answer still pending. */
export function ask(chat: Chat, prompt: string): { chat: Chat; id: number } {
  const id = chat.nextId;
  return { chat: { turns: cap([...chat.turns, { id, prompt, result: null }]), nextId: id + 1 }, id };
}

/** Fills in the answer of a pending turn. A turn that is gone or already answered is left alone. */
export function answer(chat: Chat, id: number, result: LifecycleParseResult): Chat {
  return { ...chat, turns: chat.turns.map((t) => (t.id === id && t.result === null ? { ...t, result } : t)) };
}

/**
 * A choice made inside an answer (a different arena, "join first"): it becomes a new turn with its own answer, which
 * makes the turn it came from static. The intent was already validated by the parser or built from validated parts.
 */
export function followUp(chat: Chat, label: string, intent: LifecycleIntent, via?: string): Chat {
  const id = chat.nextId;
  const result: LifecycleParseResult = { ok: true, intent, ...(via ? { via } : {}) };
  return { turns: cap([...chat.turns, { id, prompt: label, result }]), nextId: id + 1 };
}

/** True only for the last turn, and only once it has an answer: the single place with live action buttons. */
export function isInteractive(chat: Chat, id: number): boolean {
  const last = chat.turns[chat.turns.length - 1];
  return !!last && last.id === id && last.result !== null;
}

/** True while the Terminal is reading a prompt. */
export const isThinking = (chat: Chat): boolean => chat.turns.some((t) => t.result === null);
