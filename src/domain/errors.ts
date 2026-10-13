export class GraphImeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GraphImeError";
    this.code = code;
  }
}
