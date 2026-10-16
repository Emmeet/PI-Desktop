/** Desktop-owned omp policy; never inherited from the user's global omp config. */
export type OmpApprovalMode = "always-ask" | "write" | "yolo";

export function isOmpApprovalMode(value: unknown): value is OmpApprovalMode {
  return value === "always-ask" || value === "write" || value === "yolo";
}

/** Missing or invalid desktop preferences always fall back to write approval. */
export function normalizeOmpApprovalMode(value: unknown): OmpApprovalMode {
  return isOmpApprovalMode(value) ? value : "write";
}
