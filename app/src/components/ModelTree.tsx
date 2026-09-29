import { useUsdStore } from "@/store/usdStore";
import { useViewerStore } from "@/store/viewerStore";
import { AssetTree, type AssetNode } from "@/components/AssetTree";
import { Button } from "@/components/ui/button";
import type { UsdEngine } from "@/viewer/usdEngine";
import type { ViewerEngine } from "@/viewer/engine";
import type { Format } from "@/viewer/types";

/**
 * The asset tree, wired to whichever engine is mounted.
 *
 * One component for both formats, because the tree shape (`AssetNode`) and the
 * engine verbs (`buildTree` / `selectNode` / `clearIsolation`) are deliberately
 * identical. What differs is what the data is built from, and that lives in the
 * engines.
 */
export function ModelTree({ format }: { format: Format }) {
  const ifcTree = useViewerStore((s) => s.tree);
  const usdTree = useUsdStore((s) => s.tree);
  const selectedIfc = useViewerStore((s) => s.isolatedNodeId);
  const selectedUsd = useUsdStore((s) => s.isolatedNodeId);

  const tree = format === "usd" ? usdTree : ifcTree;
  const selectedId = format === "usd" ? selectedUsd : selectedIfc;

  if (!tree.length) return null;

  const engine = (): ViewerEngine | UsdEngine | undefined =>
    format === "usd"
      ? (window as unknown as { __usdEngine?: UsdEngine }).__usdEngine
      : (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;

  // Both engines expose `buildTree` / `selectNode` / `clearIsolation` with the
  // SAME async signatures, so there is no union to narrow and no `instanceof`
  // dance here — the difference in where the tree comes from lives in the
  // engines, not in the UI.
  const onSelect = (node: AssetNode): void => {
    const e = engine();
    if (!e) return;
    const clearing = node.id === selectedId;
    void (clearing ? e.clearIsolation() : e.selectNode(node)).then((counts) => {
      const store = format === "usd" ? useUsdStore.getState() : useViewerStore.getState();
      store.setIsolatedNode(clearing ? null : node.id);
      store.setVisibility(counts.visible, counts.total);
    });
  };

  return (
    <div className="space-y-2">
      <AssetTree nodes={tree} selectedId={selectedId} onSelect={onSelect} />
      {selectedId ? (
        <Button
          size="sm"
          variant="secondary"
          className="w-full justify-start"
          data-testid="tree-clear-isolation"
          onClick={() => {
            const e = engine();
            if (!e) return;
            void e.clearIsolation().then((counts) => {
              const store = format === "usd" ? useUsdStore.getState() : useViewerStore.getState();
              store.setIsolatedNode(null);
              store.setVisibility(counts.visible, counts.total);
            });
          }}
        >
          Show everything
        </Button>
      ) : null}
    </div>
  );
}
