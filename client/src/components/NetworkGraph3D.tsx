import { useMemo, useRef, useState, useEffect } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import type { EdgeData, NodeData } from '../types';
import { ROLE_COLORS } from '../types';
import type { GraphSettings } from './NetworkGraph';

interface Props {
  nodes: NodeData[];
  edges: EdgeData[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settings: GraphSettings;
  /** Bumping this number triggers a camera fly to focusNodeId. */
  focusKey?: number;
  focusNodeId?: string | null;
}

interface GraphNode extends NodeData {
  id: string;
  color: string;
  val: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
}

function nodeColor(node: NodeData): string {
  return ROLE_COLORS[node.device_role] ?? ROLE_COLORS[0];
}

function linkEndId(end: string | number | GraphNode | object): string {
  if (end && typeof end === 'object') return (end as GraphNode).id;
  return String(end);
}

export function NetworkGraph3D({
  nodes, edges, selectedId, onSelect, settings, focusKey, focusNodeId,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const nodeMapRef = useRef(new Map<string, GraphNode>());
  const linkMapRef = useRef(new Map<string, GraphLink>());
  // SpriteText cache: avoids recreating 200+ Three.js objects on every data update.
  const spriteMapRef = useRef(new Map<string, SpriteText>());
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Kept current in render so the orbit animation closure never goes stale.
  const graphDataRef = useRef<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });

  // Orbit animation state
  const orbitRafRef = useRef<number | null>(null);
  const orbitingRef = useRef(false);
  const orbitAngleRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      setSize({ width: container.clientWidth, height: container.clientHeight });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(() => {
    const nextNodeMap = new Map<string, GraphNode>();

    for (const node of nodes) {
      const existing = nodeMapRef.current.get(node.hash);
      if (existing) {
        Object.assign(existing, node, {
          id: node.hash,
          color: nodeColor(node),
          val: settings.minNodeRadius / 2,
        });
        nextNodeMap.set(node.hash, existing);
      } else {
        nextNodeMap.set(node.hash, {
          ...node,
          id: node.hash,
          color: nodeColor(node),
          val: settings.minNodeRadius / 2,
        });
      }
    }

    nodeMapRef.current = nextNodeMap;

    // Prune stale sprite cache entries so we don't hold Three.js objects for gone nodes.
    for (const h of spriteMapRef.current.keys()) {
      if (!nextNodeMap.has(h)) spriteMapRef.current.delete(h);
    }

    const nodeSet = new Set(nextNodeMap.keys());
    const nextLinkMap = new Map<string, GraphLink>();

    // Deduplicate bidirectional edges: if A→B and B→A both exist, render one link.
    for (const edge of edges) {
      if (!nodeSet.has(edge.from_hash) || !nodeSet.has(edge.to_hash)) continue;
      const canonical = [edge.from_hash, edge.to_hash].sort().join('<>');
      if (nextLinkMap.has(canonical)) continue;
      const existing = linkMapRef.current.get(canonical);
      nextLinkMap.set(canonical, existing ?? { source: edge.from_hash, target: edge.to_hash });
    }

    linkMapRef.current = nextLinkMap;

    return {
      nodes: [...nextNodeMap.values()],
      links: [...nextLinkMap.values()],
    };
  }, [nodes, edges, settings.minNodeRadius]);

  // Keep the ref current so orbit closure always sees the latest node positions.
  graphDataRef.current = graphData;

  // Degree-weighted repulsion: high-degree hub nodes repel harder, pushing them
  // outward to form the skeleton while leaf nodes stay near their hub.
  // chargeStrength is the strength at the most-connected node; leaf nodes get ~1/3 of that.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const degreeMap = new Map<string, number>();
    for (const link of graphData.links) {
      const s = linkEndId(link.source);
      const t = linkEndId(link.target);
      degreeMap.set(s, (degreeMap.get(s) ?? 0) + 1);
      degreeMap.set(t, (degreeMap.get(t) ?? 0) + 1);
    }
    const maxDegree = Math.max(1, ...degreeMap.values());
    fg.d3Force('charge')?.strength((node: { id: string }) => {
      const degree = degreeMap.get(node.id) ?? 0;
      return settings.chargeStrength * (1 + 2 * (degree / maxDegree)) / 3;
    });
    fg.d3ReheatSimulation();
  }, [graphData.links, settings.chargeStrength]);

  // Wire link distance and strength into the 3D force simulation.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('link')?.distance(settings.linkDistance).strength(settings.linkStrength);
    fg.d3ReheatSimulation();
  }, [settings.linkDistance, settings.linkStrength]);

  // Fly camera to a focused node when focusKey changes.
  useEffect(() => {
    if (!focusNodeId || !focusKey) return;
    const fg = fgRef.current;
    if (!fg) return;
    const node = nodeMapRef.current.get(focusNodeId) as any;
    if (!node) return;
    const { x = 0, y = 0, z = 0 } = node;
    fg.cameraPosition(
      { x, y: y + 50, z: z + 200 },
      { x, y, z },
      1000,
    );
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Orbit: slowly rotate camera around the centroid of all nodes.
  useEffect(() => {
    if (!settings.orbit) {
      orbitingRef.current = false;
      orbitAngleRef.current = null;
      if (orbitRafRef.current !== null) {
        cancelAnimationFrame(orbitRafRef.current);
        orbitRafRef.current = null;
      }
      return;
    }

    orbitingRef.current = true;

    const animate = () => {
      if (!orbitingRef.current) return;

      const fg = fgRef.current;
      const gd = graphDataRef.current;

      if (fg && gd.nodes.length > 0) {
        const ns = gd.nodes as any[];
        const cx = ns.reduce((s: number, n: any) => s + (n.x ?? 0), 0) / ns.length;
        const cy = ns.reduce((s: number, n: any) => s + (n.y ?? 0), 0) / ns.length;
        const cz = ns.reduce((s: number, n: any) => s + (n.z ?? 0), 0) / ns.length;

        const cam = fg.camera();
        const dx = cam.position.x - cx;
        const dz = cam.position.z - cz;

        // Initialise angle from the camera's current position to avoid a jump.
        if (orbitAngleRef.current === null) {
          orbitAngleRef.current = Math.atan2(dx, dz);
        }

        const radius = Math.sqrt(dx * dx + dz * dz) || 400;
        orbitAngleRef.current += 0.004; // ~0.23° per frame at 60 fps
        const angle = orbitAngleRef.current;

        fg.cameraPosition(
          { x: cx + radius * Math.sin(angle), y: cam.position.y, z: cz + radius * Math.cos(angle) },
          { x: cx, y: cy, z: cz },
          0,
        );
      }

      orbitRafRef.current = requestAnimationFrame(animate);
    };

    orbitRafRef.current = requestAnimationFrame(animate);

    return () => {
      orbitingRef.current = false;
      orbitAngleRef.current = null;
      if (orbitRafRef.current !== null) {
        cancelAnimationFrame(orbitRafRef.current);
        orbitRafRef.current = null;
      }
    };
  }, [settings.orbit]);

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden" style={{ minHeight: 0 }}>
      {size.width > 0 && size.height > 0 && (
        <ForceGraph3D
          ref={fgRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          backgroundColor="#030712"
          nodeLabel={(node) => {
            const graphNode = node as GraphNode;
            return `${graphNode.name ?? graphNode.hash.toUpperCase()}\n${graphNode.hash.toUpperCase()}`;
          }}
          nodeColor={(node) => {
            const graphNode = node as GraphNode;
            return graphNode.hash === selectedId ? '#fbbf24' : graphNode.color;
          }}
          nodeRelSize={3}
          linkWidth={(link) => {
            if (!selectedId) return 1.5;
            const s = linkEndId((link as GraphLink).source);
            const t = linkEndId((link as GraphLink).target);
            return s === selectedId || t === selectedId ? 3.5 : 1;
          }}
          linkColor={(link) => {
            if (!selectedId) return '#2563eb';
            const s = linkEndId((link as GraphLink).source);
            const t = linkEndId((link as GraphLink).target);
            return s === selectedId || t === selectedId ? '#fbbf24' : '#1e3558';
          }}
          linkOpacity={settings.threeDLinkOpacity}
          onNodeClick={(node) => {
            const graphNode = node as GraphNode;
            onSelect(graphNode.hash === selectedId ? null : graphNode.hash);
          }}
          onBackgroundClick={() => onSelect(null)}
          // nodeThreeObjectExtend keeps the default coloured sphere and adds the
          // sprite as a child above it, rather than replacing the sphere entirely.
          nodeThreeObjectExtend={settings.showLabels}
          nodeThreeObject={settings.showLabels ? (node: object) => {
            const graphNode = node as GraphNode;
            const label = graphNode.name ?? graphNode.hash.toUpperCase();
            // Reuse cached sprite; only recreate if text or size changed.
            let sprite = spriteMapRef.current.get(graphNode.hash);
            if (!sprite || sprite.text !== label || sprite.textHeight !== settings.threeDLabelSize) {
              sprite = new SpriteText(label);
              sprite.color = '#ffffff';
              sprite.backgroundColor = 'rgba(0,0,0,0.55)';
              sprite.padding = 1.5;
              sprite.borderRadius = 2;
              sprite.textHeight = settings.threeDLabelSize;
              spriteMapRef.current.set(graphNode.hash, sprite);
            }
            // Position label above the sphere. Sphere radius ≈ nodeRelSize * ∛val = 3 * ∛(minNodeRadius/2).
            sprite.position.y = 3 * Math.cbrt(settings.minNodeRadius / 2) + 3;
            return sprite;
          } : undefined}
          // warmupTicks runs the simulation silently before first render so the graph
          // appears already settled rather than animating from a random layout on mobile.
          warmupTicks={100}
          cooldownTicks={50}
          d3AlphaDecay={0.05}
          d3VelocityDecay={0.3}
        />
      )}
    </div>
  );
}
