export function compositionId(raw: string): string {
  return `composition:${encodeURIComponent(raw)}`;
}

export function textId(rank: number, reading: string, text: string): string {
  return `text:${rank}:${encodeURIComponent(reading)}:${encodeURIComponent(text)}`;
}

export function graphicId(anchorId: string, assetId: string): string {
  return `graphic:${anchorId}:${encodeURIComponent(assetId)}`;
}

export function generationId(requestId: string): string {
  return `generation:${requestId}`;
}

export function edgeId(kind: string, from: string, to: string): string {
  return `edge:${kind}:${from}:${to}`;
}
