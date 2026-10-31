// The global property the MCP runtime boundary defines, non-writable and
// non-configurable, so later code in the process can neither forge its
// absence nor remove it.
export const BOUNDARY_MARKER = Symbol.for("means-of-compute.mcp-boundary");

export function boundaryActive(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, BOUNDARY_MARKER);
  return (
    descriptor !== undefined &&
    descriptor.value === true &&
    descriptor.writable === false &&
    descriptor.configurable === false
  );
}
