import { commitPayloadFor } from "../domain/commit.js";
import type { CompositionGraph, Lane, LaneItem } from "../domain/types.js";

export function projectLane(graph: CompositionGraph, lane: Lane): LaneItem[] {
  if (lane === "text") {
    return graph.nodes
      .flatMap((node) => (node.kind === "text" ? [node] : []))
      .sort((a, b) => a.rank - b.rank)
      .map((node) => ({
        id: node.id,
        lane,
        label: node.text,
        detail: node.reading,
        commit: commitPayloadFor(node),
      }));
  }

  if (lane === "graphic") {
    return graph.nodes
      .flatMap((node) => (node.kind === "graphic" ? [node] : []))
      .sort((a, b) => a.rank - b.rank)
      .map((node) => ({
        id: node.id,
        lane,
        label: node.label,
        detail: node.graphicKind,
        commit: commitPayloadFor(node),
      }));
  }

  return graph.nodes
    .flatMap((node) => (node.kind === "generation" ? [node] : []))
    .sort((a, b) => a.rank - b.rank)
    .map((node) => ({
      id: node.id,
      lane,
      label:
        node.status === "ready"
          ? node.output.type === "text"
            ? node.output.text
            : node.output.label
          : node.skill,
      detail: node.status === "failed" ? node.failureReason : node.prompt,
      commit: commitPayloadFor(node),
    }));
}
