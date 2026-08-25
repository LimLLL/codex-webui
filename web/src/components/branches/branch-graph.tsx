/**
 * React Flow surfaces for the conversation branch graph.
 *
 * Layout and node rendering are shared; the two exported surfaces differ only
 * in viewport behaviour. They are separate components rather than one component
 * behind a `mode` prop because the interactive one owns pan, zoom and selection
 * while the confirmation one must stay inert inside a dialog.
 */
import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
// Both surfaces are reached only from a dialog, and this module is imported
// lazily by those dialogs, so React Flow and its stylesheet stay out of the
// initial bundle.
import '@xyflow/react/dist/style.css';
import {
  layoutBranchGraph,
  type BranchGraphInput,
} from '@/lib/branch-graph-layout';
import { useThemeStore } from '@/stores/theme-store';
import {
  BranchGraphNode,
  type BranchGraphNodeData,
} from './branch-graph-node';

const nodeTypes = { branch: BranchGraphNode };

/**
 * Mirrors the app theme onto React Flow's own root element.
 *
 * React Flow scopes its dark variables to `.react-flow.dark` rather than to an
 * ancestor, so the app's `.dark` class on `<html>` does not reach it. Without
 * this the built-in controls and the attribution badge keep their light
 * backgrounds and read as bright blocks on a dark dialog.
 */
function useFlowColorMode(): 'light' | 'dark' {
  return useThemeStore((state) => state.dark) ? 'dark' : 'light';
}

/** Caller-supplied description of one thread in the graph. */
export interface BranchGraphItem extends BranchGraphInput {
  data: Omit<BranchGraphNodeData, 'threadId'>;
  /**
   * Message that was edited to produce this node, shown on the incoming edge.
   *
   * A node is a thread, and a thread can host edits to several of its messages,
   * so the parent's own label does not always say which message a child branched
   * from. Omit it when the edge is self-evident — see the caller.
   */
  edgeLabel?: string | null;
}

function buildFlow(items: BranchGraphItem[]): { nodes: Node[]; edges: Edge[] } {
  const layout = layoutBranchGraph(items);
  const doomed = new Set(
    items.filter((item) => item.data.isDoomed).map((item) => item.threadId),
  );
  return {
    nodes: layout.nodes.map((positioned) => ({
      id: positioned.node.threadId,
      type: 'branch',
      position: { x: positioned.x, y: positioned.y },
      data: {
        ...positioned.node.data,
        threadId: positioned.node.threadId,
      } as unknown as Record<string, unknown>,
      draggable: false,
      selectable: false,
    })),
    edges: layout.edges.map((edge) => {
      const targetItem = items.find((item) => item.threadId === edge.target);
      const inferred = targetItem?.data.boundaryUnknown ?? false;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: targetItem?.edgeLabel ?? undefined,
        labelShowBg: true,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        labelStyle: { fill: 'var(--muted-foreground)', fontSize: 11 },
        labelBgStyle: { fill: 'var(--background)' },
        // Dashed means "we inferred this link": the fork point was never
        // recorded, so the child's vertical placement is approximate.
        style: {
          strokeDasharray: inferred ? '4 3' : undefined,
          stroke: doomed.has(edge.target)
            ? 'var(--destructive)'
            : 'var(--border)',
        },
      } satisfies Edge;
    }),
  };
}

interface InteractiveProps {
  items: BranchGraphItem[];
  className?: string;
  onNodeClick?: (threadId: string) => void;
}

/** Full branch graph: pan, zoom, trackpad pinch, and node navigation. */
export function BranchGraphPanel({
  items,
  className,
  onNodeClick,
}: InteractiveProps) {
  const flow = useMemo(() => buildFlow(items), [items]);
  const colorMode = useFlowColorMode();
  return (
    <div className={className}>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.75}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // Node clicks must go through React Flow. With selection and dragging
        // both disabled it stops delivering pointer events to the node body, so
        // a handler on the node's own element silently never fires.
        onNodeClick={(_, node) => onNodeClick?.(node.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

interface PreviewProps {
  items: BranchGraphItem[];
  className?: string;
}

/**
 * Inert, fitted rendering for the delete confirmation.
 *
 * Interaction is fully disabled: a dialog is the wrong place to lose the graph
 * off-screen, and the accompanying list — not this — is the authoritative
 * account of what will be removed.
 */
export function BranchGraphPreview({ items, className }: PreviewProps) {
  const flow = useMemo(() => buildFlow(items), [items]);
  const colorMode = useFlowColorMode();
  return (
    <div className={className}>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={1}
        // No attribution badge on the confirmation: it is a static thumbnail
        // inside a destructive dialog, not an interactive React Flow surface.
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      </ReactFlow>
    </div>
  );
}
