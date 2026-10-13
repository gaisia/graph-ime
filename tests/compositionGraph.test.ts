import assert from "node:assert/strict";
import test from "node:test";
import { compositionId, createCompositionGraph, GraphImeError, graphicId, textId } from "../src/index.js";
import type { CompositionNode, GraphicNode, TextNode } from "../src/index.js";

function composition(raw = "nihao"): CompositionNode {
  return { id: compositionId(raw), kind: "composition", raw };
}

function textNode(rank = 0): TextNode {
  return {
    id: textId(rank, "nihao", "你好"),
    kind: "text",
    text: "你好",
    reading: "nihao",
    score: 2,
    rank,
  };
}

test("accepts an empty candidate graph", () => {
  const graph = createCompositionGraph({ nodes: [], edges: [], coverage: "complete", limitations: [] });
  assert.equal(graph.rootId, null);
  assert.equal(graph.schema, "GraphImeCompositionGraph");
  assert.equal(graph.version, 1);
});

test("accepts text proposed from a composition and keeps local graphic paths", () => {
  const root = composition();
  const word = textNode();
  const sticker: GraphicNode = {
    id: graphicId(word.id, "sticker-1"),
    kind: "graphic",
    assetId: "sticker-1",
    graphicKind: "sticker",
    label: "收到",
    source: "C:\\assets\\shoudao.png",
    altText: "收到",
    anchorId: word.id,
    rank: 0,
  };
  const fileSticker: GraphicNode = {
    ...sticker,
    id: graphicId(word.id, "sticker-2"),
    assetId: "sticker-2",
    source: "file:///C:/assets/shoudao.png",
    rank: 1,
  };
  const graph = createCompositionGraph({
    nodes: [word, root, fileSticker, sticker],
    edges: [
      { kind: "illustrates", from: word.id, to: fileSticker.id },
      { kind: "proposes", from: root.id, to: word.id },
      { kind: "illustrates", from: word.id, to: sticker.id },
    ],
    coverage: "complete",
    limitations: [],
  });

  assert.equal(graph.rootId, root.id);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    [root.id, fileSticker.id, sticker.id, word.id].sort(),
  );
  assert.equal(graph.edges[0]?.kind, "illustrates");
});

test("rejects a self-edge, a dangling edge, and an illegal pair", () => {
  const root = composition();
  const word = textNode();
  assert.throws(
    () =>
      createCompositionGraph({
        nodes: [root],
        edges: [{ kind: "proposes", from: root.id, to: root.id }],
        coverage: "complete",
        limitations: [],
      }),
    (error) => error instanceof GraphImeError && error.message.includes("itself"),
  );
  assert.throws(
    () =>
      createCompositionGraph({
        nodes: [root],
        edges: [{ kind: "proposes", from: root.id, to: "text:missing" }],
        coverage: "complete",
        limitations: [],
      }),
    (error) => error instanceof GraphImeError && error.message.includes("missing"),
  );
  assert.throws(
    () =>
      createCompositionGraph({
        nodes: [root, word],
        edges: [{ kind: "illustrates", from: root.id, to: word.id }],
        coverage: "complete",
        limitations: [],
      }),
    (error) => error instanceof GraphImeError && error.message.includes("not allowed"),
  );
});

test("requires limitations to match coverage and rejects remote sources", () => {
  const root = composition();
  assert.throws(
    () => createCompositionGraph({ nodes: [root], edges: [], coverage: "complete", limitations: ["note"] }),
    (error) => error instanceof GraphImeError && error.code === "invalid_graph",
  );
  assert.throws(
    () => createCompositionGraph({ nodes: [root], edges: [], coverage: "partial", limitations: [] }),
    (error) => error instanceof GraphImeError && error.code === "invalid_graph",
  );

  const word = textNode();
  const remote: GraphicNode = {
    id: graphicId(word.id, "remote"),
    kind: "graphic",
    assetId: "remote",
    graphicKind: "image",
    label: "远程",
    source: "https://example.com/a.png",
    altText: "远程",
    anchorId: word.id,
    rank: 0,
  };
  assert.throws(
    () =>
      createCompositionGraph({
        nodes: [root, word, remote],
        edges: [
          { kind: "proposes", from: root.id, to: word.id },
          { kind: "illustrates", from: word.id, to: remote.id },
        ],
        coverage: "complete",
        limitations: [],
      }),
    (error) => error instanceof GraphImeError && error.code === "remote_source",
  );
});
