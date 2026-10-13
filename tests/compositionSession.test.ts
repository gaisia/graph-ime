import assert from "node:assert/strict";
import test from "node:test";
import { CompositionSession, GraphImeError } from "../src/index.js";
import type { GraphicAsset, TextCandidate } from "../src/index.js";

const lexicon: Record<string, TextCandidate[]> = {
  shoudao: [
    { text: "受到", reading: "shoudao", score: 3 },
    { text: "收到", reading: "shoudao", score: 10 },
  ],
};

const graphics: Record<string, GraphicAsset[]> = {
  收到: [
    { kind: "emoji", id: "ok", label: "好的", source: "glyph", altText: "👌" },
    {
      kind: "sticker",
      id: "sticker-1",
      label: "收到贴纸",
      source: "C:\\assets\\shoudao.png",
      altText: "收到",
    },
  ],
};

function session(options: {
  text?: TextCandidate[] | (() => TextCandidate[]);
  graphics?: GraphicAsset[] | (() => GraphicAsset[]);
  maxTextCandidates?: number;
  maxGraphics?: number;
} = {}) {
  return new CompositionSession({
    text: {
      suggest: () => {
        if (typeof options.text === "function") return options.text();
        return options.text ?? lexicon.shoudao ?? [];
      },
    },
    graphics: {
      lookup: (text) => {
        if (typeof options.graphics === "function") return options.graphics();
        if (options.graphics) return options.graphics;
        return graphics[text] ?? [];
      },
    },
    maxTextCandidates: options.maxTextCandidates,
    maxGraphics: options.maxGraphics,
  });
}

test("ranks text candidates and focuses the best one", () => {
  const ime = session();
  const snapshot = ime.setComposition("shoudao");
  assert.deepEqual(
    snapshot.laneItems.map((item) => item.label),
    ["收到", "受到"],
  );
  assert.equal(snapshot.focusedId, snapshot.laneItems[0]?.id);
  assert.equal(snapshot.graph.coverage, "complete");
  assert.equal(snapshot.graph.rootId?.startsWith("composition:"), true);
});

test("switches to graphic candidates and commits emoji as text, stickers as images", () => {
  const ime = session();
  ime.setComposition("shoudao");
  const graphicsLane = ime.setLane("graphic");
  assert.deepEqual(
    graphicsLane.laneItems.map((item) => item.label),
    ["好的", "收到贴纸"],
  );

  const emoji = ime.commitFocused();
  assert.deepEqual(emoji.payload, { type: "text", text: "👌" });
  assert.equal(emoji.snapshot.graph.rootId, null);

  const again = session();
  again.setComposition("shoudao");
  again.setLane("graphic");
  again.focusStep(1);
  const sticker = again.commitFocused();
  assert.deepEqual(sticker.payload, {
    type: "image",
    source: "C:\\assets\\shoudao.png",
    altText: "收到",
  });
});

test("keeps the composition when the text provider fails and when graphics are unavailable", () => {
  const failed = session({
    text: () => {
      throw new Error("lexicon offline");
    },
  });
  const snapshot = failed.setComposition("shoudao");
  assert.equal(snapshot.graph.coverage, "unknown");
  assert.equal(snapshot.laneItems.length, 0);
  assert.equal(snapshot.graph.limitations[0]?.includes("lexicon offline"), true);
  assert.equal(snapshot.graph.nodes[0]?.kind, "composition");

  const degraded = session({
    graphics: () => {
      throw new Error("index closed");
    },
  });
  const partial = degraded.setComposition("shoudao");
  assert.equal(partial.graph.coverage, "partial");
  assert.equal(partial.laneItems[0]?.label, "收到");
  assert.equal(partial.graph.limitations.some((item) => item.includes("index closed")), true);
});

test("drops remote graphics and truncates the text page", () => {
  const ime = session({
    graphics: [
      { kind: "emoji", id: "ok", label: "好的", source: "glyph", altText: "👌" },
      { kind: "image", id: "remote", label: "远程", source: "https://example.com/a.png", altText: "远程" },
    ],
  });
  const snapshot = ime.setComposition("shoudao");
  ime.setLane("graphic");
  const labels = ime.current().laneItems.map((item) => item.label);
  assert.deepEqual(labels, ["好的", "好的"]);
  assert.equal(snapshot.graph.coverage, "partial");
  assert.equal(JSON.stringify(snapshot.graph).includes("https://"), false);

  const short = session({ maxTextCandidates: 1 });
  const page = short.setComposition("shoudao");
  assert.deepEqual(
    page.laneItems.map((item) => item.label),
    ["收到"],
  );
  assert.equal(page.graph.coverage, "partial");
});

test("stages generation off the key path, then commits only a finished result", () => {
  const ime = session();
  ime.setComposition("shoudao");
  ime.focusStep(1);
  const pending = ime.stageGeneration("polish", "把收到写得更正式");
  assert.equal(pending.activeLane, "generation");
  assert.equal(pending.laneItems[0]?.commit, null);
  const anchor = pending.graph.edges.find((edge) => edge.kind === "requests");
  assert.equal(anchor?.from.includes(encodeURIComponent("受到")), true);
  assert.throws(
    () => ime.commitFocused(),
    (error) => error instanceof GraphImeError && error.code === "generation_not_ready",
  );

  assert.throws(
    () =>
      ime.fulfillGeneration("req-1", {
        type: "image",
        source: "https://example.com/out.png",
        altText: "图",
        label: "图",
      }),
    (error) => error instanceof GraphImeError && error.code === "remote_source",
  );
  assert.equal(ime.current().laneItems[0]?.commit, null);

  const ready = ime.fulfillGeneration("req-1", { type: "text", text: "已收到。" });
  assert.equal(ready.laneItems[0]?.label, "已收到。");
  const committed = ime.commitFocused();
  assert.deepEqual(committed.payload, { type: "text", text: "已收到。" });
  assert.equal(committed.snapshot.activeLane, "text");
});

test("anchors generation to the word that owns the focused graphic", () => {
  const ime = session();
  ime.setComposition("shoudao");
  ime.setLane("graphic");
  ime.focusStep(1);
  const pending = ime.stageGeneration("sticker", "换一种收到");
  const word = pending.graph.nodes.find((node) => node.kind === "text" && node.text === "收到");
  const anchor = pending.graph.edges.find((edge) => edge.kind === "requests");
  assert.equal(anchor?.from, word?.id);
});

test("clears a pending generation when the composition changes and wraps focus", () => {
  const ime = session();
  ime.setComposition("shoudao");
  ime.stageGeneration("sticker", "一张收到的贴纸");
  const cleared = ime.setComposition("shoudao2");
  assert.equal(cleared.graph.nodes.some((node) => node.kind === "generation"), false);

  const fresh = session();
  fresh.setComposition("shoudao");
  const wrapped = fresh.focusStep(-1);
  assert.equal(wrapped.laneItems.at(-1)?.id, wrapped.focusedId);

  assert.throws(
    () => fresh.stageGeneration("translate", "   "),
    (error) => error instanceof GraphImeError && error.code === "empty_prompt",
  );
  assert.throws(
    () => fresh.setComposition("x".repeat(257)),
    (error) => error instanceof GraphImeError && error.code === "composition_too_long",
  );
});
