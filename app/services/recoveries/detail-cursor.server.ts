import { createHash } from "node:crypto";

export class InvalidRecoveryDetailQuery extends Error {
  constructor() { super("Invalid recovery detail query"); this.name = "InvalidRecoveryDetailQuery"; }
}

export type DetailBoundary = { at: string; id: string };
export type DetailNavigation = { direction: "first" | "latest" | "next" | "previous"; boundary: DetailBoundary | null };

export function validDetailId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(value);
}

// Binding prevents accidental cross-resource cursor reuse; it is not authorization.
export function detailCursorScope(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function detailCursor(scope: string, direction: "next" | "previous", key: DetailBoundary): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, direction, ...key })).toString("base64url");
}

export function parseDetailNavigation(scope: string, input: { cursor?: unknown; window?: unknown }): DetailNavigation {
  if (input.window !== undefined && input.window !== "first" && input.window !== "latest") throw new InvalidRecoveryDetailQuery();
  if (input.cursor === undefined) return { direction: input.window === "latest" ? "latest" : "first", boundary: null };
  if (input.window !== undefined || typeof input.cursor !== "string" || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw new InvalidRecoveryDetailQuery();
  try {
    const decoded = Buffer.from(input.cursor, "base64url");
    if (decoded.toString("base64url") !== input.cursor) throw new Error();
    const value = JSON.parse(decoded.toString("utf8"));
    if (!value || Object.keys(value).sort().join() !== "at,direction,id,scope,v" || value.v !== 1 || value.scope !== scope || !["next", "previous"].includes(value.direction) || !validDetailId(value.id) || typeof value.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.at) || new Date(value.at).toISOString() !== value.at) throw new Error();
    return { direction: value.direction, boundary: { at: value.at, id: value.id } };
  } catch { throw new InvalidRecoveryDetailQuery(); }
}
