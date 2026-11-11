import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { agentDirectory, resolveDevManifest, sharedManifest } from "./read-dev-config.mjs";

test("new and old development setups select the same tracked manifest", () => {
  for (const configured of [undefined, "", ".agent-state/arena.testnet.reads.json", "./.agent-state/arena.testnet.reads.json", path.resolve(agentDirectory, ".agent-state/arena.testnet.reads.json")])
    assert.equal(resolveDevManifest(configured), sharedManifest);
});
test("custom manifest overrides remain isolated", () => {
  assert.equal(resolveDevManifest("./custom.json"), path.resolve(agentDirectory, "custom.json"));
});
