import { GraphImeError } from "./errors.js";
import { compositionId, edgeId, generationId, graphicId, textId } from "./ids.js";
import type {
  CompositionGraph,
  Coverage,
  EdgeDraft,
  GenerationOutput,
  GenerationSkill,
  GraphEdge,
  GraphNode,
  GraphicKind,
} from "./types.js";
import { SCHEMA, SCHEMA_VERSION } from "./types.js";

const GRAPHIC_KINDS = new Set<GraphicKind>(["emoji", "sticker", "image"]);
const SKILLS = new Set<GenerationSkill>(["continue", "polish", "translate", "sticker"]);
const COVERAGES = new Set<Coverage>(["complete", "partial", "unknown"]);

export function createCompositionGraph(input: {
  nodes: GraphNode[];
  edges: EdgeDraft[];
  coverage: Coverage;
  limitations: string[];
}): CompositionGraph {
  if (!COVERAGES.has(input.coverage)) {
    throw new GraphImeError("invalid_graph", "coverage is not a known value");
  }

  const limitations = normalizeLimitations(input.limitations);
  if (input.coverage === "complete" && limitations.length > 0) {
    throw new GraphImeError("invalid_graph", "complete coverage cannot list limitations");
  }
  if (input.coverage !== "complete" && limitations.length === 0) {
    throw new GraphImeError("invalid_graph", "partial or unknown coverage needs a limitation");
  }

  const nodes = input.nodes.map((node) => normalizeNode(node));
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new GraphImeError("invalid_graph", `duplicate node id ${node.id}`);
    }
    byId.set(node.id, node);
  }

  const compositions = nodes.filter((node) => node.kind === "composition");
  if (nodes.length === 0 && compositions.length !== 0) {
    throw new GraphImeError("invalid_graph", "empty graph cannot contain a composition");
  }
  if (nodes.length > 0 && compositions.length !== 1) {
    throw new GraphImeError("invalid_graph", "a candidate graph needs exactly one composition node");
  }

  assertUniqueRanks(nodes, "text");
  assertUniqueRanks(nodes, "graphic");
  assertUniqueRanks(nodes, "generation");

  const edges: GraphEdge[] = input.edges.map((edge) => {
    if (edge.from === edge.to) {
      throw new GraphImeError("invalid_graph", "edges cannot connect a node to itself");
    }
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      throw new GraphImeError("invalid_graph", "edge endpoint is missing");
    }
    assertEdgePair(from, to, edge.kind);
    return {
      id: edgeId(edge.kind, edge.from, edge.to),
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
    };
  });

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      throw new GraphImeError("invalid_graph", `duplicate edge ${edge.id}`);
    }
    edgeIds.add(edge.id);
  }

  for (const node of nodes) {
    if (node.kind === "text") {
      assertSingleEdge(edges, "proposes", compositions[0]?.id, node.id);
    }
    if (node.kind === "graphic") {
      assertSingleEdge(edges, "illustrates", node.anchorId, node.id);
    }
    if (node.kind === "generation") {
      assertSingleEdge(edges, "requests", node.anchorId, node.id);
    }
  }

  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const root = compositions[0];
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    rootId: root ? root.id : null,
    nodes,
    edges,
    coverage: input.coverage,
    limitations,
  };
}

function normalizeLimitations(limitations: string[]): string[] {
  if (!Array.isArray(limitations)) {
    throw new GraphImeError("invalid_graph", "limitations must be a list");
  }
  const seen = new Set<string>();
  for (const limitation of limitations) {
    if (typeof limitation !== "string" || limitation.trim() === "" || limitation.length > 500) {
      throw new GraphImeError("invalid_graph", "limitations must be short non-empty strings");
    }
    if (seen.has(limitation)) {
      throw new GraphImeError("invalid_graph", `duplicate limitation ${limitation}`);
    }
    seen.add(limitation);
  }
  return [...limitations];
}

function normalizeNode(node: GraphNode): GraphNode {
  switch (node.kind) {
    case "composition":
      assertExactKeys(node, ["id", "kind", "raw"], "composition");
      if (typeof node.raw !== "string" || node.raw.length === 0) {
        throw new GraphImeError("invalid_graph", "composition raw text must be non-empty");
      }
      if (node.id !== compositionId(node.raw)) {
        throw new GraphImeError("invalid_graph", "composition id does not match its raw text");
      }
      return { id: node.id, kind: "composition", raw: node.raw };
    case "text":
      assertExactKeys(node, ["id", "kind", "text", "reading", "score", "rank"], "text");
      assertNonEmpty(node.text, "text");
      assertNonEmpty(node.reading, "reading");
      assertRank(node.rank);
      if (typeof node.score !== "number" || !Number.isFinite(node.score)) {
        throw new GraphImeError("invalid_graph", "text score must be a finite number");
      }
      if (node.id !== textId(node.rank, node.reading, node.text)) {
        throw new GraphImeError("invalid_graph", "text id does not match its reading and text");
      }
      return {
        id: node.id,
        kind: "text",
        text: node.text,
        reading: node.reading,
        score: node.score,
        rank: node.rank,
      };
    case "graphic":
      assertExactKeys(
        node,
        ["id", "kind", "assetId", "graphicKind", "label", "source", "altText", "anchorId", "rank"],
        "graphic",
      );
      assertNonEmpty(node.assetId, "asset id");
      assertNonEmpty(node.label, "graphic label");
      assertNonEmpty(node.altText, "graphic alt text");
      assertLocalSource(node.source);
      assertRank(node.rank);
      if (!GRAPHIC_KINDS.has(node.graphicKind)) {
        throw new GraphImeError("invalid_graph", "graphic kind is not known");
      }
      if (node.id !== graphicId(node.anchorId, node.assetId)) {
        throw new GraphImeError("invalid_graph", "graphic id does not match its anchor and asset");
      }
      return {
        id: node.id,
        kind: "graphic",
        assetId: node.assetId,
        graphicKind: node.graphicKind,
        label: node.label,
        source: node.source,
        altText: node.altText,
        anchorId: node.anchorId,
        rank: node.rank,
      };
    case "generation":
      return normalizeGeneration(node);
    default:
      throw new GraphImeError("invalid_graph", "node kind is not known");
  }
}

function normalizeGeneration(node: GraphNode & { kind: "generation" }): GraphNode {
  assertNonEmpty(node.prompt, "generation prompt");
  assertRank(node.rank);
  if (!/^[-A-Za-z0-9_]+$/.test(node.requestId)) {
    throw new GraphImeError("invalid_graph", "generation request id has unsupported characters");
  }
  if (!SKILLS.has(node.skill)) {
    throw new GraphImeError("invalid_graph", "generation skill is not known");
  }
  if (node.id !== generationId(node.requestId)) {
    throw new GraphImeError("invalid_graph", "generation id does not match its request id");
  }

  const shared = {
    id: node.id,
    kind: "generation" as const,
    requestId: node.requestId,
    skill: node.skill,
    prompt: node.prompt,
    anchorId: node.anchorId,
    rank: node.rank,
  };

  if (node.status === "pending") {
    assertExactKeys(
      node,
      ["id", "kind", "requestId", "skill", "prompt", "anchorId", "rank", "status"],
      "generation",
    );
    return { ...shared, status: "pending" };
  }
  if (node.status === "failed") {
    assertExactKeys(
      node,
      ["id", "kind", "requestId", "skill", "prompt", "anchorId", "rank", "status", "failureReason"],
      "generation",
    );
    assertNonEmpty(node.failureReason, "failure reason");
    return { ...shared, status: "failed", failureReason: node.failureReason };
  }
  if (node.status === "ready") {
    assertExactKeys(
      node,
      ["id", "kind", "requestId", "skill", "prompt", "anchorId", "rank", "status", "output"],
      "generation",
    );
    return { ...shared, status: "ready", output: normalizeOutput(node.output) };
  }
  throw new GraphImeError("invalid_graph", "generation status is not known");
}

function normalizeOutput(output: unknown): GenerationOutput {
  if (!output || typeof output !== "object") {
    throw new GraphImeError("invalid_graph", "generation output is missing");
  }
  const record = output as { type?: unknown; text?: unknown; source?: unknown; altText?: unknown; label?: unknown };
  if (record.type === "text") {
    assertExactKeys(record, ["type", "text"], "text output");
    if (typeof record.text !== "string" || record.text.length === 0) {
      throw new GraphImeError("invalid_graph", "text output must be non-empty");
    }
    return { type: "text", text: record.text };
  }
  if (record.type === "image") {
    assertExactKeys(record, ["type", "source", "altText", "label"], "image output");
    if (typeof record.altText !== "string" || record.altText.length === 0) {
      throw new GraphImeError("invalid_graph", "image alt text must be non-empty");
    }
    if (typeof record.label !== "string" || record.label.length === 0) {
      throw new GraphImeError("invalid_graph", "image label must be non-empty");
    }
    if (typeof record.source !== "string") {
      throw new GraphImeError("invalid_graph", "image source must be a string");
    }
    assertLocalSource(record.source);
    return { type: "image", source: record.source, altText: record.altText, label: record.label };
  }
  throw new GraphImeError("invalid_graph", "generation output type is not known");
}

function assertEdgePair(from: GraphNode, to: GraphNode, kind: string): void {
  if (kind === "proposes" && from.kind === "composition" && to.kind === "text") return;
  if (
    kind === "illustrates" &&
    from.kind === "text" &&
    to.kind === "graphic" &&
    to.anchorId === from.id
  ) {
    return;
  }
  if (
    kind === "requests" &&
    (from.kind === "composition" || from.kind === "text") &&
    to.kind === "generation" &&
    to.anchorId === from.id
  ) {
    return;
  }
  throw new GraphImeError("invalid_graph", `edge ${kind} is not allowed between these nodes`);
}

function assertSingleEdge(edges: GraphEdge[], kind: GraphEdge["kind"], from: string | undefined, to: string): void {
  const matches = edges.filter((edge) => edge.kind === kind && edge.to === to);
  if (matches.length !== 1 || matches[0]?.from !== from) {
    throw new GraphImeError("invalid_graph", `${kind} edge for ${to} is missing or ambiguous`);
  }
}

function assertUniqueRanks(nodes: GraphNode[], kind: "text" | "graphic" | "generation"): void {
  const ranks = new Set<number>();
  for (const node of nodes) {
    if (node.kind !== kind) continue;
    if (ranks.has(node.rank)) {
      throw new GraphImeError("invalid_graph", `duplicate ${kind} rank ${node.rank}`);
    }
    ranks.add(node.rank);
  }
}

function assertExactKeys(value: object, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new GraphImeError("invalid_graph", `${label} fields do not match the contract`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphImeError("invalid_graph", `${label} must be non-empty`);
  }
}

function assertRank(rank: number): void {
  if (!Number.isInteger(rank) || rank < 0) {
    throw new GraphImeError("invalid_graph", "rank must be a non-negative integer");
  }
}

export function assertLocalSource(source: string): void {
  if (typeof source !== "string" || source.length === 0 || source !== source.trim()) {
    throw new GraphImeError("invalid_graph", "source must be a non-empty local reference");
  }
  if (source.startsWith("//")) {
    throw new GraphImeError("remote_source", "source must be a local path or file URL");
  }
  if (/^[a-z]:[\\/]/i.test(source) || source.startsWith("\\\\")) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.toLowerCase().startsWith("file:")) {
    throw new GraphImeError("remote_source", "source must be a local path or file URL");
  }
}
