import type { CommitPayload, GraphNode } from "./types.js";

export function commitPayloadFor(node: GraphNode): CommitPayload | null {
  switch (node.kind) {
    case "composition":
      return null;
    case "text":
      return { type: "text", text: node.text };
    case "graphic":
      return node.graphicKind === "emoji"
        ? { type: "text", text: node.altText }
        : { type: "image", source: node.source, altText: node.altText };
    case "generation":
      if (node.status !== "ready") return null;
      if (node.output.type === "text") return { type: "text", text: node.output.text };
      return {
        type: "image",
        source: node.output.source,
        altText: node.output.altText,
      };
  }
}
