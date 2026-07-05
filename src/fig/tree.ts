import type { FigMessage, Guid, NodeChange } from './kiwi.js';

/**
 * Rebuilds the document tree from the flat nodeChanges list:
 *  - index every node by its GUID
 *  - the DOCUMENT node is the root (by type, falling back to the first entry)
 *  - children attach via parentIndex.guid
 *  - siblings sort by parentIndex.position (fractional-index string,
 *    plain lexicographic byte order — NOT locale-aware)
 */

export interface FigNode {
  node: NodeChange;
  children: FigNode[];
}

export interface FigTree {
  root: FigNode;
  byGuid: Map<string, FigNode>;
  /** Nodes whose parent guid is missing from the file (excluding the root). */
  orphans: FigNode[];
}

export function guidKey(guid: Guid): string {
  return `${guid.sessionID}:${guid.localID}`;
}

export function buildTree(message: FigMessage): FigTree {
  const changes = message.nodeChanges ?? [];
  if (changes.length === 0) throw new Error('File contains no nodes');

  const byGuid = new Map<string, FigNode>();
  for (const node of changes) {
    if (!node.guid) continue;
    byGuid.set(guidKey(node.guid), { node, children: [] });
  }

  let root: FigNode | undefined;
  const orphans: FigNode[] = [];

  for (const entry of byGuid.values()) {
    const { node } = entry;
    if (node.type === 'DOCUMENT') {
      root = entry;
      continue;
    }
    const parentGuid = node.parentIndex?.guid;
    const parent = parentGuid && byGuid.get(guidKey(parentGuid));
    if (parent) {
      parent.children.push(entry);
    } else {
      orphans.push(entry);
    }
  }

  if (!root) {
    // Some files may omit the DOCUMENT type; fall back to the first change,
    // which is the document by convention.
    const first = changes[0];
    if (!first?.guid) throw new Error('Cannot determine document root');
    root = byGuid.get(guidKey(first.guid));
    if (!root) throw new Error('Cannot determine document root');
  }

  for (const entry of byGuid.values()) {
    entry.children.sort((a, b) => {
      const pa = a.node.parentIndex?.position ?? '';
      const pb = b.node.parentIndex?.position ?? '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }

  return { root, byGuid, orphans };
}
