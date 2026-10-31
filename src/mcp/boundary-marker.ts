// The global property the MCP runtime boundary defines, non-writable and
// non-configurable. It is read with the `in` operator, which later code
// cannot redirect, so once defined it can neither be removed nor hidden.
export const BOUNDARY_MARKER = "__meansOfComputeMcpBoundary";

export function boundaryActive(): boolean {
  return BOUNDARY_MARKER in globalThis;
}
