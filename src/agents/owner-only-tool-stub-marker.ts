/**
 * Identity marker for owner-only tool stubs (see owner-only-tool-stubs.ts). Kept free
 * of runtime imports so policy and capture owners can exclude stubs cheaply.
 */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Identity-bound like the other agent tool metadata: plain object spreads cannot
// forge or carry the mark; wrappers carry it through copyAgentToolMetadata (or, for a
// proxy, copyOwnerOnlyToolStubMarker). One process-wide set so separately transformed
// module copies agree, at the same in-process exposure as the before-tool-call metadata.
const ownerOnlyToolStubs = resolveGlobalSingleton(
  Symbol.for("openclaw.ownerOnlyToolStubs"),
  () => new WeakSet<object>(),
);

export function markOwnerOnlyToolStub<T extends object>(tool: T): T {
  ownerOnlyToolStubs.add(tool);
  return tool;
}

/** True for an owner-only stub or a wrapper that carried its mark. Stubs grant nothing. */
export function isOwnerOnlyToolStub(tool: object): boolean {
  return ownerOnlyToolStubs.has(tool);
}

export function copyOwnerOnlyToolStubMarker(source: object, target: object): void {
  if (ownerOnlyToolStubs.has(source)) {
    ownerOnlyToolStubs.add(target);
  }
}

/** Names the per-turn prompt reports as refused, in first-seen order. */
export function listOwnerOnlyToolStubNames(tools: readonly { name: string }[]): string[] {
  return [...new Set(tools.filter(isOwnerOnlyToolStub).map((tool) => tool.name))];
}
