import type { GraphEdge, GraphNode } from "./types.js";

export interface ConcentricConstraint {
  targetRadius: number;
  centerX: number;
  centerY: number;
  isCenter?: boolean;
}

export interface SimulationOptions {
  width: number;
  height: number;
  repulsion: number;
  springLength: number;
  springStrength: number;
  gravity: number;
  damping: number;
  collisionBuffer?: number;
  coolingRate?: number;
  alpha: number;
  concentricConstraints?: Map<string, ConcentricConstraint>;
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  width: 900,
  height: 600,
  repulsion: 15000,
  springLength: 160,
  springStrength: 0.035,
  gravity: 0.004,
  damping: 0.85,
  collisionBuffer: 36,
  coolingRate: 0.990,
  alpha: 1.0,
};

/**
 * Computes a single physics tick advancing node coordinates and velocities.
 * Implements Coulomb repulsion, Hooke's spring attraction, center-pull gravity,
 * and hard geometric collision relaxation to prevent node overlap.
 */
export function stepSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: Partial<SimulationOptions> = {}
): number {
  const opts = { ...DEFAULT_SIMULATION_OPTIONS, ...options };
  const { width, height, repulsion, springLength, springStrength, gravity, damping, alpha } = opts;

  if (alpha < 0.002) {
    return alpha; // Simulation is cooled/settled
  }

  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const nodeCount = nodes.length;

  // 1. Coulomb repulsion between all node pairs
  for (let i = 0; i < nodeCount; i++) {
    const nodeA = nodes[i];
    for (let j = i + 1; j < nodeCount; j++) {
      const nodeB = nodes[j];

      let dx = nodeB.x - nodeA.x;
      let dy = nodeB.y - nodeA.y;
      let distSq = dx * dx + dy * dy;

      if (distSq === 0) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        distSq = dx * dx + dy * dy;
      }

      const dist = Math.sqrt(distSq);
      // Generous buffer between nodes so labels, chips, and halos never overlap
      const buffer = opts.collisionBuffer ?? 36;
      const minDistance = nodeA.radius + nodeB.radius + buffer;

      // Inverse-distance repulsion with smooth saturation floor
      let force = (repulsion / Math.max(distSq, 1200)) * alpha;

      // Strong non-linear collision push when nodes enter each other's clearance zone
      if (dist < minDistance) {
        const overlap = minDistance - dist;
        force += (Math.pow(overlap, 1.35) * 0.4 + overlap * 0.9) * alpha;
      }

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (nodeA.fx == null) {
        nodeA.vx -= fx;
        nodeA.vy -= fy;
      }
      if (nodeB.fx == null) {
        nodeB.vx += fx;
        nodeB.vy += fy;
      }
    }
  }

  // 2. Hooke's spring attraction along edges
  for (const edge of edges) {
    const source = nodeMap.get(edge.from_entity_id);
    const target = nodeMap.get(edge.to_entity_id);

    if (!source || !target) continue;

    let dx = target.x - source.x;
    let dy = target.y - source.y;
    let dist = Math.sqrt(dx * dx + dy * dy);

    if (dist === 0) {
      dx = (Math.random() - 0.5) * 2;
      dy = (Math.random() - 0.5) * 2;
      dist = Math.sqrt(dx * dx + dy * dy);
    }

    const displacement = dist - springLength;
    const force = displacement * springStrength * alpha;

    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;

    if (source.fx == null) {
      source.vx += fx;
      source.vy += fy;
    }
    if (target.fx == null) {
      target.vx -= fx;
      target.vy -= fy;
    }
  }

  // 3. Center gravity and velocity integration
  const centerX = width / 2;
  const centerY = height / 2;

  for (const node of nodes) {
    // If pinned by user dragging
    if (node.fx != null && node.fy != null) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    // Check for concentric circle radial constraint (Network view)
    const constraint = opts.concentricConstraints?.get(node.id);
    if (constraint) {
      if (constraint.isCenter) {
        node.x = constraint.centerX;
        node.y = constraint.centerY;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      const cdx = node.x - constraint.centerX;
      const cdy = node.y - constraint.centerY;
      const currentRadius = Math.sqrt(cdx * cdx + cdy * cdy);
      if (currentRadius > 0) {
        const radialDiff = constraint.targetRadius - currentRadius;
        const radialForce = radialDiff * 0.14 * alpha;
        node.vx += (cdx / currentRadius) * radialForce;
        node.vy += (cdy / currentRadius) * radialForce;
      }
    } else {
      // Pull toward canvas center (default layout) - gentle centripetal cohesion
      const gdx = centerX - node.x;
      const gdy = centerY - node.y;
      node.vx += gdx * gravity * alpha;
      node.vy += gdy * gravity * alpha;
    }

    // Apply damping
    node.vx *= damping;
    node.vy *= damping;

    // Cap maximum velocity to prevent explosions while allowing swift initial expansion
    const maxVelocity = 18;
    const currentSpeed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (currentSpeed > maxVelocity) {
      node.vx = (node.vx / currentSpeed) * maxVelocity;
      node.vy = (node.vy / currentSpeed) * maxVelocity;
    }

    // Update position
    node.x += node.vx;
    node.y += node.vy;

    // Soft containment inside canvas padding (skip if concentric constraint active)
    if (!constraint) {
      const pad = node.radius + 12;
      if (node.x < pad) {
        node.x = pad;
        node.vx *= -0.5;
      } else if (node.x > width - pad) {
        node.x = width - pad;
        node.vx *= -0.5;
      }
      if (node.y < pad) {
        node.y = pad;
        node.vy *= -0.5;
      } else if (node.y > height - pad) {
        node.y = height - pad;
        node.vy *= -0.5;
      }
    }
  }

  // 4. Hard geometric anti-overlap collision relaxation pass
  // Enforces that node circles never clip or overlap each other
  const buffer = opts.collisionBuffer ?? 36;
  const hardClearance = Math.max(12, Math.round(buffer * 0.45));
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < nodeCount; i++) {
      const nodeA = nodes[i];
      for (let j = i + 1; j < nodeCount; j++) {
        const nodeB = nodes[j];
        let dx = nodeB.x - nodeA.x;
        let dy = nodeB.y - nodeA.y;
        let distSq = dx * dx + dy * dy;
        const requiredDistance = nodeA.radius + nodeB.radius + hardClearance;

        if (distSq < requiredDistance * requiredDistance) {
          if (distSq === 0) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distSq = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(distSq);
          const overlap = requiredDistance - dist;
          const shiftRatio = 0.5;
          const shiftX = (dx / dist) * overlap * shiftRatio;
          const shiftY = (dy / dist) * overlap * shiftRatio;

          if (nodeA.fx == null) {
            nodeA.x -= shiftX;
            nodeA.y -= shiftY;
          }
          if (nodeB.fx == null) {
            nodeB.x += shiftX;
            nodeB.y += shiftY;
          }
        }
      }
    }
  }

  // Decay temperature smoothly
  const coolingRate = opts.coolingRate ?? 0.990;
  return alpha * coolingRate;
}
