export const SCHEMA = "GraphImeCompositionGraph" as const;
export const SCHEMA_VERSION = 1 as const;

export type Coverage = "complete" | "partial" | "unknown";

export type Lane = "text" | "graphic" | "generation";

export type GenerationSkill = "continue" | "polish" | "translate" | "sticker";

export type GraphicKind = "emoji" | "sticker" | "image";

export type CommitPayload =
  | { type: "text"; text: string }
  | { type: "image"; source: string; altText: string };

export type TextOutput = { type: "text"; text: string };

export type ImageOutput = {
  type: "image";
  source: string;
  altText: string;
  label: string;
};

export type GenerationOutput = TextOutput | ImageOutput;

export type CompositionNode = {
  id: string;
  kind: "composition";
  raw: string;
};

export type TextNode = {
  id: string;
  kind: "text";
  text: string;
  reading: string;
  score: number;
  rank: number;
};

export type GraphicNode = {
  id: string;
  kind: "graphic";
  assetId: string;
  graphicKind: GraphicKind;
  label: string;
  source: string;
  altText: string;
  anchorId: string;
  rank: number;
};

export type GenerationNodeBase = {
  id: string;
  kind: "generation";
  requestId: string;
  skill: GenerationSkill;
  prompt: string;
  anchorId: string;
  rank: number;
};

export type GenerationNode =
  | (GenerationNodeBase & { status: "pending" })
  | (GenerationNodeBase & { status: "failed"; failureReason: string })
  | (GenerationNodeBase & { status: "ready"; output: GenerationOutput });

export type GraphNode = CompositionNode | TextNode | GraphicNode | GenerationNode;

export type EdgeKind = "proposes" | "illustrates" | "requests";

export type GraphEdge = {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
};

export type EdgeDraft = {
  kind: EdgeKind;
  from: string;
  to: string;
};

export type CompositionGraph = {
  schema: typeof SCHEMA;
  version: typeof SCHEMA_VERSION;
  rootId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverage: Coverage;
  limitations: string[];
};

export type TextCandidate = {
  text: string;
  reading: string;
  score: number;
};

export type GraphicAsset = {
  kind: GraphicKind;
  id: string;
  label: string;
  source: string;
  altText: string;
};

export interface TextProvider {
  suggest(composition: string): TextCandidate[];
}

export interface GraphicIndex {
  lookup(text: string): GraphicAsset[];
}

export type LaneItem = {
  id: string;
  lane: Lane;
  label: string;
  detail: string;
  commit: CommitPayload | null;
};

export type CompositionSnapshot = {
  graph: CompositionGraph;
  activeLane: Lane;
  focusedId: string | null;
  laneItems: LaneItem[];
};

export type CommitResult = {
  payload: CommitPayload;
  snapshot: CompositionSnapshot;
};
