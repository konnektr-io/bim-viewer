/**
 * The asset tree.
 *
 * A browsable hierarchy of the model, shared by both formats. The whole point is
 * that the USD and IFC views have DIFFERENT native structures and one identical
 * affordance: a collapsible outline you can read, search, click and isolate from.
 *
 * The tree is built from data each engine already has, not from a new traversal:
 *
 *  - USD: the prim path is the hierarchy. `indexPrims` records the full path on
 *    every mesh, so the tree is those paths, and the storey/category segments the
 *    path carries give the grouping the flattened file no longer preserves.
 *  - IFC: `getSpatialStructure()` is unusable here (it stops at the storey level
 *    behind null-category aggregation nodes), so the tree is built from
 *    `getItemsOfCategories` — storeys, then spaces, then categories within them.
 *
 * A node is `{ id, label, kind, count, children }`, and `kind` is what the
 * engines key their visibility on, so clicking a node can isolate the real
 * geometry rather than a label.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type AssetNodeKind = "root" | "layer" | "storey" | "room" | "category" | "element";

export interface AssetNode {
  id: string;
  label: string;
  kind: AssetNodeKind;
  /** Meshes/elements beneath this node — shown in the badge. */
  count: number;
  children?: AssetNode[];
}

interface AssetTreeProps {
  nodes: AssetNode[];
  /** Selected node id, highlighted in the tree. */
  selectedId?: string | null;
  /** Called with a node; the engine isolates whatever its kind means. */
  onSelect?: (node: AssetNode) => void;
  /** Ids currently visible, for the eye toggle. */
  visibleIds?: Set<string>;
  onToggleVisible?: (node: AssetNode) => void;
}

/** Depth-first flatten, honouring which nodes are expanded. */
function flatten(
  nodes: AssetNode[],
  expanded: Set<string>,
  query: string,
  out: Array<{ node: AssetNode; depth: number }> = [],
): Array<{ node: AssetNode; depth: number }> {
  const q = query.trim().toLowerCase();
  for (const node of nodes) {
    // A node matches if it or any descendant does, so a search on a leaf name
    // still reveals the storey it lives under.
    const self = !q || node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q);
    const kids = node.children?.length
      ? flatten(node.children, expanded, query, [])
      : [];
    if (!self && kids.length === 0) continue;
    // When searching, force the path open — otherwise a match is invisible.
    const open = q ? true : expanded.has(node.id);
    out.push({ node, depth: 0 });
    if (open) {
      for (const child of node.children ?? []) {
        flatten([child], expanded, query, []).forEach((c) => out.push({ ...c, depth: c.depth + 1 }));
      }
    }
  }
  return out;
}

export function AssetTree({
  nodes,
  selectedId,
  onSelect,
  visibleIds,
  onToggleVisible,
}: AssetTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const rows = useMemo(() => flatten(nodes, expanded, query), [nodes, expanded, query]);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!nodes.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Search className="size-3.5" />
            Model
          </CardTitle>
          {nodes.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() =>
                setExpanded((prev) => (prev.size ? new Set() : new Set(nodes.map((n) => n.id))))
              }
            >
              {expanded.size ? "Collapse" : "Expand"}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter the model…"
          aria-label="Filter the model tree"
          className="h-7 text-xs"
        />
        <div className="max-h-72 min-w-0 overflow-y-auto" data-testid="asset-tree">
          {rows.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">Nothing matches “{query}”.</p>
          ) : (
            rows.map(({ node, depth }) => {
              const hasKids = Boolean(node.children?.length);
              const isOpen = query ? true : expanded.has(node.id);
              const selected = selectedId === node.id;
              const on = visibleIds ? visibleIds.has(node.id) : true;
              return (
                <div
                  key={node.id}
                  className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent"
                  style={{ paddingLeft: `${depth * 10 + 4}px` }}
                  data-testid={`tree-node-${node.id}`}
                  data-kind={node.kind}
                >
                  <button
                    type="button"
                    className="flex size-4 shrink-0 items-center justify-center"
                    aria-label={hasKids ? `${isOpen ? "Collapse" : "Expand"} ${node.label}` : undefined}
                    aria-expanded={hasKids ? isOpen : undefined}
                    onClick={() => hasKids && toggle(node.id)}
                  >
                    {hasKids ? (
                      isOpen ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelect?.(node)}
                    className={`min-w-0 flex-1 truncate text-left ${
                      selected ? "font-medium text-primary" : ""
                    }`}
                    title={node.id}
                  >
                    {node.label}
                  </button>
                  {onToggleVisible && node.kind !== "element" ? (
                    <button
                      type="button"
                      className="size-3.5 shrink-0 accent-primary"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`${on ? "Hide" : "Show"} ${node.label}`}
                      onClick={() => onToggleVisible(node)}
                    >
                      <span
                        className={`block size-3 rounded-sm border ${
                          on ? "bg-primary" : "bg-transparent"
                        }`}
                      />
                    </button>
                  ) : null}
                  <Badge variant="secondary" className="shrink-0 tabular-nums text-[10px]">
                    {node.count.toLocaleString("en-US")}
                  </Badge>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
