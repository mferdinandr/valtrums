import { describe, expect, it } from "vitest";
import { MAX_TURNS, answer, ask, emptyChat, followUp, isInteractive, isThinking } from "./chat";
import type { LifecycleIntent, LifecycleParseResult } from "./lifecycle-intent";

const ok = (intent: LifecycleIntent): LifecycleParseResult => ({ ok: true, intent });
const list: LifecycleIntent = { kind: "list_battles", status: "open" };
const join = (battleId: number): LifecycleIntent => ({ kind: "join_battle", battleId, tokenRef: "CASHCAT" });

describe("the conversation", () => {
  it("adds a pending turn, then fills in its answer", () => {
    const a = ask(emptyChat(), "which arenas are open?");
    expect(a.chat.turns).toEqual([{ id: 1, prompt: "which arenas are open?", result: null }]);
    expect(isThinking(a.chat)).toBe(true);
    const b = answer(a.chat, a.id, ok(list));
    expect(b.turns[0]!.result).toEqual(ok(list));
    expect(isThinking(b)).toBe(false);
  });

  it("answers each prompt in its own turn, in order, even when answers arrive out of order", () => {
    const first = ask(emptyChat(), "one");
    const second = ask(first.chat, "two");
    const c = answer(answer(second.chat, second.id, ok(list)), first.id, ok(join(7)));
    expect(c.turns.map((t) => [t.prompt, t.result && t.result.ok ? t.result.intent.kind : null])).toEqual([["one", "join_battle"], ["two", "list_battles"]]);
  });

  it("never overwrites an answer that already exists, nor invents one for a missing turn", () => {
    const a = ask(emptyChat(), "x");
    const b = answer(a.chat, a.id, ok(list));
    expect(answer(b, a.id, ok(join(1))).turns[0]!.result).toEqual(ok(list));
    expect(answer(b, 99, ok(join(1)))).toEqual(b);
  });
});

describe("which turn is interactive", () => {
  it("only the latest answered turn; earlier ones are static", () => {
    let chat = emptyChat();
    const t1 = ask(chat, "join 7 with cashcat");
    chat = answer(t1.chat, t1.id, ok(join(7)));
    expect(isInteractive(chat, t1.id)).toBe(true);
    const t2 = ask(chat, "which arenas are open?");
    chat = answer(t2.chat, t2.id, ok(list));
    expect(isInteractive(chat, t1.id)).toBe(false); // the old review can no longer be signed
    expect(isInteractive(chat, t2.id)).toBe(true);
  });

  it("a pending turn is not interactive yet, and an unknown turn never is", () => {
    const a = ask(emptyChat(), "x");
    expect(isInteractive(a.chat, a.id)).toBe(false);
    expect(isInteractive(a.chat, 42)).toBe(false);
    expect(isInteractive(emptyChat(), 1)).toBe(false);
  });

  it("a choice made inside an answer becomes the new live turn and freezes the one it came from", () => {
    const t1 = ask(emptyChat(), "deposit 100 CASHCAT to the open arena");
    let chat = answer(t1.chat, t1.id, ok({ kind: "deposit", battleId: null, community: null, tokenRef: "CASHCAT", amount: "1" }));
    chat = followUp(chat, "Use arena #12", { kind: "deposit", battleId: 12, community: null, tokenRef: "CASHCAT", amount: "1" }, "near-ai");
    expect(chat.turns.map((t) => t.prompt)).toEqual(["deposit 100 CASHCAT to the open arena", "Use arena #12"]);
    expect(isInteractive(chat, t1.id)).toBe(false);
    expect(isInteractive(chat, chat.turns[1]!.id)).toBe(true);
    expect(chat.turns[1]!.result).toMatchObject({ ok: true, via: "near-ai" });
  });
});

describe("a long session", () => {
  it("keeps only the most recent turns and keeps ids unique", () => {
    let chat = emptyChat();
    for (let i = 0; i < MAX_TURNS + 10; i++) chat = answer(ask(chat, `p${i}`).chat, chat.nextId, ok(list));
    expect(chat.turns).toHaveLength(MAX_TURNS);
    expect(chat.turns[0]!.prompt).toBe("p10");
    expect(chat.turns.at(-1)!.prompt).toBe(`p${MAX_TURNS + 9}`);
    expect(new Set(chat.turns.map((t) => t.id)).size).toBe(MAX_TURNS);
    expect(isInteractive(chat, chat.turns.at(-1)!.id)).toBe(true);
  });
});
