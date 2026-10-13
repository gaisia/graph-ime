import { assertLocalSource, createCompositionGraph } from "../domain/compositionGraph.js";
import { GraphImeError } from "../domain/errors.js";
import { compositionId, generationId, graphicId, textId } from "../domain/ids.js";
import type {
  CommitResult,
  CompositionNode,
  CompositionSnapshot,
  Coverage,
  GenerationOutput,
  GenerationSkill,
  GraphicAsset,
  GraphicIndex,
  GraphicNode,
  GraphNode,
  Lane,
  TextCandidate,
  TextNode,
  TextProvider,
} from "../domain/types.js";
import { projectLane } from "./projectLane.js";

const MAX_COMPOSITION_LENGTH = 256;
const LANES: Lane[] = ["text", "graphic", "generation"];
const SKILLS = new Set<GenerationSkill>(["continue", "polish", "translate", "sticker"]);

type GenerationRecord = {
  requestId: string;
  skill: GenerationSkill;
  prompt: string;
  anchorId: string;
  status: "pending" | "ready" | "failed";
  failureReason?: string;
  output?: GenerationOutput;
};

export type SessionDependencies = {
  text: TextProvider;
  graphics: GraphicIndex;
  maxTextCandidates?: number;
  maxGraphics?: number;
};

export class CompositionSession {
  private readonly text: TextProvider;
  private readonly graphics: GraphicIndex;
  private readonly maxTextCandidates: number;
  private readonly maxGraphics: number;
  private raw = "";
  private lane: Lane = "text";
  private focusedId: string | null = null;
  private generations: GenerationRecord[] = [];
  private sequence = 0;
  private snapshot: CompositionSnapshot;

  constructor(dependencies: SessionDependencies) {
    this.text = dependencies.text;
    this.graphics = dependencies.graphics;
    this.maxTextCandidates = positiveInteger(dependencies.maxTextCandidates, 9, "maxTextCandidates");
    this.maxGraphics = positiveInteger(dependencies.maxGraphics, 8, "maxGraphics");
    this.snapshot = this.rebuild();
  }

  current(): CompositionSnapshot {
    return this.snapshot;
  }

  setComposition(raw: string): CompositionSnapshot {
    if (typeof raw !== "string") {
      throw new GraphImeError("invalid_composition", "composition must be a string");
    }
    if (raw.length > MAX_COMPOSITION_LENGTH) {
      throw new GraphImeError(
        "composition_too_long",
        `composition is limited to ${MAX_COMPOSITION_LENGTH} characters`,
      );
    }
    if (raw !== this.raw) {
      this.raw = raw;
      this.generations = [];
      this.focusedId = null;
    }
    return this.rebuild();
  }

  clear(): CompositionSnapshot {
    return this.setComposition("");
  }

  setLane(lane: Lane): CompositionSnapshot {
    if (!LANES.includes(lane)) {
      throw new GraphImeError("invalid_lane", "lane is not known");
    }
    this.lane = lane;
    this.focusedId = null;
    return this.rebuild();
  }

  cycleLane(): CompositionSnapshot {
    const index = LANES.indexOf(this.lane);
    const next = LANES[(index + 1) % LANES.length] ?? "text";
    return this.setLane(next);
  }

  focusStep(delta: number): CompositionSnapshot {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new GraphImeError("invalid_focus", "focus step must be a non-zero integer");
    }
    const items = this.snapshot.laneItems;
    if (items.length === 0) return this.snapshot;
    const current = items.findIndex((item) => item.id === this.focusedId);
    const origin = current === -1 ? (delta > 0 ? -1 : 0) : current;
    const modulo = (origin + delta) % items.length;
    const index = modulo < 0 ? modulo + items.length : modulo;
    const item = items[index];
    if (!item) return this.snapshot;
    this.focusedId = item.id;
    return this.rebuild();
  }

  stageGeneration(skill: GenerationSkill, prompt: string): CompositionSnapshot {
    if (!SKILLS.has(skill)) {
      throw new GraphImeError("invalid_skill", "generation skill is not known");
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new GraphImeError("empty_prompt", "generation prompt must be non-empty");
    }
    if (this.raw.length === 0) {
      throw new GraphImeError("nothing_to_generate", "composition is empty");
    }
    const anchorId = this.anchorId();
    const requestId = `req-${++this.sequence}`;
    this.generations.push({
      requestId,
      skill,
      prompt,
      anchorId,
      status: "pending",
    });
    this.lane = "generation";
    this.focusedId = generationId(requestId);
    return this.rebuild();
  }

  fulfillGeneration(requestId: string, output: GenerationOutput): CompositionSnapshot {
    return this.replaceGeneration(requestId, (record) => ({
      requestId: record.requestId,
      skill: record.skill,
      prompt: record.prompt,
      anchorId: record.anchorId,
      status: "ready",
      output: copyOutput(output),
    }));
  }

  failGeneration(requestId: string, reason: string): CompositionSnapshot {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new GraphImeError("empty_failure", "failure reason must be non-empty");
    }
    return this.replaceGeneration(requestId, (record) => ({
      requestId: record.requestId,
      skill: record.skill,
      prompt: record.prompt,
      anchorId: record.anchorId,
      status: "failed",
      failureReason: reason,
    }));
  }

  commitFocused(): CommitResult {
    const item = this.snapshot.laneItems.find((candidate) => candidate.id === this.focusedId);
    if (!item) {
      throw new GraphImeError("nothing_to_commit", "there is no focused candidate");
    }
    if (!item.commit) {
      throw new GraphImeError("generation_not_ready", "the focused generation cannot be committed");
    }
    const payload = item.commit;
    this.raw = "";
    this.generations = [];
    this.focusedId = null;
    this.lane = "text";
    return { payload, snapshot: this.rebuild() };
  }

  private anchorId(): string {
    const focused = this.snapshot.graph.nodes.find((candidate) => candidate.id === this.focusedId);
    if (focused?.kind === "text") return focused.id;
    if (focused?.kind === "graphic") return focused.anchorId;
    return compositionId(this.raw);
  }

  private replaceGeneration(
    requestId: string,
    next: (record: GenerationRecord) => GenerationRecord,
  ): CompositionSnapshot {
    const index = this.generations.findIndex((record) => record.requestId === requestId);
    const current = this.generations[index];
    if (!current) {
      throw new GraphImeError("unknown_generation", "generation request was not found");
    }
    if (current.status !== "pending") {
      throw new GraphImeError("generation_not_pending", "generation request is no longer pending");
    }
    const previous = this.generations;
    const replacement = next(current);
    this.generations = this.generations.map((record, recordIndex) =>
      recordIndex === index ? replacement : record,
    );
    try {
      return this.rebuild();
    } catch (error) {
      this.generations = previous;
      throw error;
    }
  }

  private rebuild(): CompositionSnapshot {
    if (this.raw.length === 0) {
      const graph = createCompositionGraph({
        nodes: [],
        edges: [],
        coverage: "complete",
        limitations: [],
      });
      this.focusedId = null;
      this.snapshot = { graph, activeLane: this.lane, focusedId: null, laneItems: [] };
      return this.snapshot;
    }

    const limitations: string[] = [];
    const composition: CompositionNode = {
      id: compositionId(this.raw),
      kind: "composition",
      raw: this.raw,
    };
    const nodes: GraphNode[] = [composition];
    const edges: { kind: "proposes" | "illustrates" | "requests"; from: string; to: string }[] = [];

    const texts = this.collectText(limitations);
    let coverage: Coverage = texts.failed ? "unknown" : "complete";
    if (texts.invalid || texts.reduced) coverage = degrade(coverage, "partial");

    const graphicCount = { value: 0, omitted: false, failed: false };
    for (const candidate of texts.candidates) {
      const textNode: TextNode = {
        id: textId(candidate.rank, candidate.reading, candidate.text),
        kind: "text",
        text: candidate.text,
        reading: candidate.reading,
        score: candidate.score,
        rank: candidate.rank,
      };
      nodes.push(textNode);
      edges.push({ kind: "proposes", from: composition.id, to: textNode.id });
      this.attachGraphics(textNode, nodes, edges, limitations, graphicCount);
    }
    if (graphicCount.omitted || graphicCount.failed) coverage = degrade(coverage, "partial");
    if (texts.reduced) limitations.push("text candidates were deduplicated or truncated");

    const kept: GenerationRecord[] = [];
    let droppedGeneration = false;
    const present = new Set(nodes.map((node) => node.id));
    for (const record of this.generations) {
      if (!present.has(record.anchorId)) {
        droppedGeneration = true;
        continue;
      }
      const rank = kept.length;
      kept.push(record);
      const generation = generationNode(record, rank);
      nodes.push(generation);
      edges.push({ kind: "requests", from: record.anchorId, to: generation.id });
    }
    this.generations = kept;
    if (droppedGeneration) {
      limitations.push("a generation was dropped because its anchor left the candidate list");
      coverage = degrade(coverage, "partial");
    }

    const graph = createCompositionGraph({ nodes, edges, coverage, limitations });
    const laneItems = projectLane(graph, this.lane);
    if (!this.focusedId || !laneItems.some((item) => item.id === this.focusedId)) {
      this.focusedId = laneItems[0]?.id ?? null;
    }
    this.snapshot = {
      graph,
      activeLane: this.lane,
      focusedId: this.focusedId,
      laneItems,
    };
    return this.snapshot;
  }

  private collectText(limitations: string[]): {
    candidates: RankedText[];
    invalid: boolean;
    reduced: boolean;
    failed: boolean;
  } {
    let suggested: TextCandidate[];
    try {
      const value = this.text.suggest(this.raw);
      if (!Array.isArray(value)) throw new Error("text provider returned a non-array");
      suggested = value;
    } catch (error) {
      limitations.push(`text provider failed: ${clip(errorText(error))}`);
      return { candidates: [], invalid: false, reduced: false, failed: true };
    }

    const best = new Map<string, TextCandidate>();
    let invalid = false;
    let duplicate = false;
    for (const candidate of suggested) {
      if (!isTextCandidate(candidate)) {
        invalid = true;
        continue;
      }
      const key = `${candidate.reading}\0${candidate.text}`;
      const existing = best.get(key);
      if (!existing) {
        best.set(key, candidate);
        continue;
      }
      duplicate = true;
      if (candidate.score > existing.score) best.set(key, candidate);
    }

    const ranked = [...best.values()].sort(
      (a, b) => b.score - a.score || compareText(a.text, b.text) || compareText(a.reading, b.reading),
    );
    const truncated = ranked.length > this.maxTextCandidates;
    if (invalid) limitations.push("skipped invalid text candidates");
    return {
      invalid,
      reduced: duplicate || truncated,
      failed: false,
      candidates: ranked.slice(0, this.maxTextCandidates).map((candidate, rank) => ({ ...candidate, rank })),
    };
  }

  private attachGraphics(
    textNode: TextNode,
    nodes: GraphNode[],
    edges: { kind: "proposes" | "illustrates" | "requests"; from: string; to: string }[],
    limitations: string[],
    graphicCount: { value: number; omitted: boolean; failed: boolean },
  ): void {
    let assets: GraphicAsset[];
    try {
      const value = this.graphics.lookup(textNode.text);
      if (!Array.isArray(value)) throw new Error("graphic index returned a non-array");
      assets = value;
    } catch (error) {
      if (!graphicCount.failed) {
        limitations.push(`graphic lookup failed: ${clip(errorText(error))}`);
        graphicCount.failed = true;
      }
      return;
    }

    const seen = new Set<string>();
    for (const asset of assets) {
      if (graphicCount.value >= this.maxGraphics) {
        graphicCount.omitted = true;
        if (!limitations.includes("graphic candidates were truncated")) {
          limitations.push("graphic candidates were truncated");
        }
        return;
      }
      if (!isGraphicAsset(asset) || seen.has(asset.id)) {
        graphicCount.omitted = true;
        if (!limitations.includes("skipped invalid graphic candidates")) {
          limitations.push("skipped invalid graphic candidates");
        }
        continue;
      }
      seen.add(asset.id);
      const graphic: GraphicNode = {
        id: graphicId(textNode.id, asset.id),
        kind: "graphic",
        assetId: asset.id,
        graphicKind: asset.kind,
        label: asset.label,
        source: asset.source,
        altText: asset.altText,
        anchorId: textNode.id,
        rank: textNode.rank * 1000 + graphicCount.value,
      };
      nodes.push(graphic);
      edges.push({ kind: "illustrates", from: textNode.id, to: graphic.id });
      graphicCount.value += 1;
    }
  }
}

type RankedText = TextCandidate & { rank: number };

function generationNode(record: GenerationRecord, rank: number): GraphNode {
  const shared = {
    id: generationId(record.requestId),
    kind: "generation" as const,
    requestId: record.requestId,
    skill: record.skill,
    prompt: record.prompt,
    anchorId: record.anchorId,
    rank,
  };
  if (record.status === "pending") return { ...shared, status: "pending" };
  if (record.status === "failed") {
    return { ...shared, status: "failed", failureReason: record.failureReason ?? "failed" };
  }
  if (!record.output) {
    throw new GraphImeError("invalid_graph", "ready generation is missing output");
  }
  return { ...shared, status: "ready", output: record.output };
}

function copyOutput(output: GenerationOutput): GenerationOutput {
  if (!output || typeof output !== "object") {
    throw new GraphImeError("invalid_output", "generation output is missing");
  }
  if (output.type === "text") {
    if (typeof output.text !== "string" || output.text.length === 0) {
      throw new GraphImeError("empty_output", "text output must be non-empty");
    }
    return { type: "text", text: output.text };
  }
  if (output.type === "image") {
    assertLocalSource(output.source);
    if (typeof output.altText !== "string" || output.altText.length === 0) {
      throw new GraphImeError("invalid_output", "image alt text must be non-empty");
    }
    if (typeof output.label !== "string" || output.label.length === 0) {
      throw new GraphImeError("invalid_output", "image label must be non-empty");
    }
    return {
      type: "image",
      source: output.source,
      altText: output.altText,
      label: output.label,
    };
  }
  throw new GraphImeError("invalid_output", "generation output type is not known");
}

function isTextCandidate(value: TextCandidate): boolean {
  return (
    !!value &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    typeof value.reading === "string" &&
    value.reading.length > 0 &&
    typeof value.score === "number" &&
    Number.isFinite(value.score)
  );
}

function isGraphicAsset(value: GraphicAsset): boolean {
  if (
    !value ||
    (value.kind !== "emoji" && value.kind !== "sticker" && value.kind !== "image") ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    typeof value.altText !== "string" ||
    value.altText.length === 0
  ) {
    return false;
  }
  try {
    assertLocalSource(value.source);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new GraphImeError("invalid_limit", `${label} must be a positive integer`);
  }
  return resolved;
}

function degrade(current: Coverage, next: Coverage): Coverage {
  if (current === "unknown" || next === "unknown") return "unknown";
  if (current === "partial" || next === "partial") return "partial";
  return "complete";
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "unknown error";
}

function clip(message: string): string {
  return message.length > 200 ? message.slice(0, 200) : message;
}
