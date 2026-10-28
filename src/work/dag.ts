// Cycle detection over a work-item DAG. An edge a -> b means a depends
// on b. The search follows only dependencies that name an item present in
// the input, so edges into the wider store cannot form a cycle here.
import type { WorkItem } from "../../contracts/v1/types.js";

export interface DagCycle {
  readonly from: string;
  readonly to: string;
  readonly cycle: readonly string[];
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export function findCycle(items: readonly WorkItem[]): DagCycle | null {
  const byId = new Map<string, WorkItem>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  const color = new Map<string, number>();
  for (const item of items) {
    color.set(item.id, WHITE);
  }
  for (const root of items) {
    const found = visit(root.id);
    if (found !== null) {
      return found;
    }
  }
  return null;

  function visit(start: string): DagCycle | null {
    const stack: Array<{ readonly id: string; childIndex: number }> = [];
    const grayStack: string[] = [];
    stack.push({ id: start, childIndex: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { readonly id: string; childIndex: number };
      const state = color.get(frame.id) ?? BLACK;
      if (state === WHITE) {
        color.set(frame.id, GRAY);
        grayStack.push(frame.id);
      }
      const item = byId.get(frame.id);
      const deps = item?.dependencies.filter((dep) => byId.has(dep)) ?? [];
      if (frame.childIndex >= deps.length) {
        color.set(frame.id, BLACK);
        grayStack.pop();
        stack.pop();
        continue;
      }
      const dep = deps[frame.childIndex] as string;
      stack[stack.length - 1] = { id: frame.id, childIndex: frame.childIndex + 1 };
      const depState = color.get(dep) ?? BLACK;
      if (depState === GRAY) {
        const cycle = [...grayStack.slice(grayStack.indexOf(dep)), dep];
        return { from: frame.id, to: dep, cycle };
      }
      if (depState === WHITE) {
        stack.push({ id: dep, childIndex: 0 });
      }
    }
    return null;
  }
}
