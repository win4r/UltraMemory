/**
 * Personalized PageRank (PPR) Graph Traversal
 * Walks the KG from seed entities and scores reachable nodes by relevance.
 */

import type { KGTriple, NeighborhoodResult } from "./kg-store.js";

// ============================================================================
// Types
// ============================================================================

export interface PPRConfig {
  /** Teleport probability back to seed nodes (default: 0.85) */
  dampingFactor: number;
  /** Max power-iteration rounds (default: 10) */
  maxIterations: number;
  /** Early stop when max score delta < threshold (default: 0.001) */
  convergenceThreshold: number;
  /** Return top-K scored entities (default: 20) */
  topK: number;
  /** Ignore paths longer than this many hops (default: 2) */
  hopLimit: number;
}

export interface PPRResult {
  entity: string;
  score: number;
  /** Shortest hop distance from any seed entity */
  hops: number;
  /** One shortest path from seed to this entity */
  path: string[];
}

export const DEFAULT_PPR_CONFIG: PPRConfig = {
  dampingFactor: 0.85,
  maxIterations: 10,
  convergenceThreshold: 0.001,
  topK: 20,
  hopLimit: 2,
};

// ============================================================================
// Edge weights by predicate
// ============================================================================

const PREDICATE_WEIGHTS: Record<string, number> = {
  created_by: 0.95,
  depends_on: 0.90,
  uses: 0.90,
  works_with: 0.80,
  works_at: 0.80,
  friend_of: 0.75,
  member_of: 0.75,
  knows: 0.75,
  manages: 0.75,
  built: 0.85,
  wrote: 0.85,
  prefers: 0.70,
  discussed: 0.70,
  lives_in: 0.70,
  located_in: 0.70,
  mentioned_in: 0.60,
  related_to: 0.50,
  is_a: 0.80,
  has: 0.75,
};

const DEFAULT_EDGE_WEIGHT = 0.60;

export function edgeWeight(predicate: string): number {
  return PREDICATE_WEIGHTS[predicate] ?? DEFAULT_EDGE_WEIGHT;
}

// ============================================================================
// Graph builder from NeighborhoodResult
// ============================================================================

interface AdjEntry {
  neighbor: string;
  weight: number;
  predicate: string;
}

interface Graph {
  /** entity -> outgoing adjacency list */
  adj: Map<string, AdjEntry[]>;
  /** All nodes in the graph */
  nodes: Set<string>;
}

/**
 * Build an undirected weighted graph from BFS neighborhood results.
 * Each triple creates edges in both directions.
 */
export function buildGraph(neighborhood: NeighborhoodResult[]): Graph {
  const adj = new Map<string, AdjEntry[]>();
  const nodes = new Set<string>();
  const seen = new Set<string>(); // dedup triples by id

  for (const nr of neighborhood) {
    nodes.add(nr.entity);
    for (const t of nr.triples) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);

      nodes.add(t.subject);
      nodes.add(t.object);

      const w = edgeWeight(t.predicate) * t.confidence;

      // subject -> object
      if (!adj.has(t.subject)) adj.set(t.subject, []);
      adj.get(t.subject)!.push({ neighbor: t.object, weight: w, predicate: t.predicate });

      // object -> subject (undirected)
      if (!adj.has(t.object)) adj.set(t.object, []);
      adj.get(t.object)!.push({ neighbor: t.subject, weight: w, predicate: t.predicate });
    }
  }

  return { adj, nodes };
}

// ============================================================================
// PPR core
// ============================================================================

/**
 * Run Personalized PageRank on a pre-built graph.
 *
 * Algorithm:
 *   score(v) = (1-d) * seed(v) + d * Σ_u [ score(u) * w(u→v) / outWeightSum(u) ]
 *
 * where d = dampingFactor, seed(v) = 1/|seeds| if v is a seed entity, else 0.
 */
export function pprTraverse(
  graph: Graph,
  startEntities: string[],
  config: Partial<PPRConfig> = {},
): PPRResult[] {
  const cfg = { ...DEFAULT_PPR_CONFIG, ...config };
  const { dampingFactor: d, maxIterations, convergenceThreshold, topK } = cfg;

  if (graph.nodes.size === 0 || startEntities.length === 0) {
    return [];
  }

  // Filter seeds to only those present in graph
  const seeds = startEntities.filter(e => graph.nodes.has(e));
  if (seeds.length === 0) return [];

  const seedSet = new Set(seeds);
  const seedScore = 1.0 / seeds.length;

  // Initialize scores: uniform over seeds
  const scores = new Map<string, number>();
  for (const node of graph.nodes) {
    scores.set(node, seedSet.has(node) ? seedScore : 0);
  }

  // Pre-compute out-weight sums
  const outWeightSum = new Map<string, number>();
  for (const [node, edges] of graph.adj) {
    let sum = 0;
    for (const e of edges) sum += e.weight;
    outWeightSum.set(node, sum);
  }

  // Power iteration
  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Map<string, number>();

    // Teleport component
    for (const node of graph.nodes) {
      newScores.set(node, seedSet.has(node) ? (1 - d) * seedScore : 0);
    }

    // Diffusion component
    for (const [node, edges] of graph.adj) {
      const nodeScore = scores.get(node) ?? 0;
      if (nodeScore === 0) continue;
      const totalOut = outWeightSum.get(node) ?? 1;

      for (const edge of edges) {
        const contribution = d * nodeScore * (edge.weight / totalOut);
        newScores.set(edge.neighbor, (newScores.get(edge.neighbor) ?? 0) + contribution);
      }
    }

    // Check convergence
    let maxDelta = 0;
    for (const node of graph.nodes) {
      const delta = Math.abs((newScores.get(node) ?? 0) - (scores.get(node) ?? 0));
      if (delta > maxDelta) maxDelta = delta;
    }

    // Update scores
    for (const [node, score] of newScores) {
      scores.set(node, score);
    }

    if (maxDelta < convergenceThreshold) break;
  }

  // Compute shortest paths from seeds via BFS
  const hopsMap = new Map<string, number>();
  const pathMap = new Map<string, string[]>();

  for (const seed of seeds) {
    hopsMap.set(seed, 0);
    pathMap.set(seed, [seed]);
  }

  const bfsQueue = [...seeds];
  let qi = 0;
  while (qi < bfsQueue.length) {
    const current = bfsQueue[qi++];
    const currentHops = hopsMap.get(current)!;
    if (currentHops >= cfg.hopLimit) continue;

    const edges = graph.adj.get(current) ?? [];
    for (const edge of edges) {
      if (!hopsMap.has(edge.neighbor)) {
        hopsMap.set(edge.neighbor, currentHops + 1);
        pathMap.set(edge.neighbor, [...(pathMap.get(current) ?? []), edge.neighbor]);
        bfsQueue.push(edge.neighbor);
      }
    }
  }

  // Build results, exclude seed entities themselves, sort by score
  const results: PPRResult[] = [];
  for (const [entity, score] of scores) {
    if (score <= 0) continue;
    const hops = hopsMap.get(entity) ?? Infinity;
    if (hops > cfg.hopLimit) continue;

    results.push({
      entity,
      score,
      hops,
      path: pathMap.get(entity) ?? [entity],
    });
  }

  // Sort by score descending, take top-K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ============================================================================
// Convenience: from triples directly
// ============================================================================

/**
 * Build graph from raw triples and run PPR.
 * Useful when you already have triples without going through KGStore.getNeighborhood.
 */
export function pprFromTriples(
  triples: KGTriple[],
  startEntities: string[],
  config?: Partial<PPRConfig>,
): PPRResult[] {
  // Convert triples to a NeighborhoodResult-like structure
  const entities = new Set<string>();
  for (const t of triples) {
    entities.add(t.subject);
    entities.add(t.object);
  }

  const neighborhood: NeighborhoodResult[] = [...entities].map(e => ({
    entity: e,
    triples: triples.filter(t => t.subject === e || t.object === e),
    hops: 0,
  }));

  const graph = buildGraph(neighborhood);
  return pprTraverse(graph, startEntities, config);
}
