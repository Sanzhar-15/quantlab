/**
 * Dependency graph resolution for indicator chains.
 * Handles topological sort and circular dependency detection.
 */

import type { IndicatorDefinition, IndicatorInstance } from './types';
import type { IndicatorRegistry } from './registry';

/**
 * Dependency graph node.
 */
interface DependencyNode {
  id: string;
  definition: IndicatorDefinition;
  dependencies: string[];              // IDs of dependencies
  dependents: string[];               // IDs that depend on this
}

/**
 * Dependency graph for indicators.
 */
export class DependencyGraph {
  private nodes = new Map<string, DependencyNode>();
  private registry: IndicatorRegistry;

  public constructor(registry: IndicatorRegistry) {
    this.registry = registry;
  }

  /**
   * Add an indicator instance to the graph.
   */
  public addInstance(instance: IndicatorInstance): void {
    const definition = this.registry.get(instance.indicatorId);
    if (!definition) {
      throw new Error(`Indicator ${instance.indicatorId} not found in registry`);
    }

    // Get dependencies (from definition or computed from params)
    const dependencies = this.resolveDependencies(definition, instance.params);

    // Check for circular dependencies
    if (this.wouldCreateCycle(instance.instanceId, dependencies)) {
      throw new Error(`Circular dependency detected for indicator ${instance.instanceId}`);
    }

    // Create or update node
    let node = this.nodes.get(instance.instanceId);
    if (node) {
      // Update existing node
      node.definition = definition;
      node.dependencies = dependencies;
    } else {
      // Create new node
      node = {
        id: instance.instanceId,
        definition,
        dependencies,
        dependents: [],
      };
      this.nodes.set(instance.instanceId, node);
    }

    // Update dependency relationships
    this.updateDependencyRelationships(instance.instanceId, dependencies);
  }

  /**
   * Remove an indicator instance from the graph.
   */
  public removeInstance(instanceId: string): void {
    const node = this.nodes.get(instanceId);
    if (!node) {
      return;
    }

    // Remove from dependents
    for (const depId of node.dependencies) {
      const depNode = this.nodes.get(depId);
      if (depNode) {
        const index = depNode.dependents.indexOf(instanceId);
        if (index >= 0) {
          depNode.dependents.splice(index, 1);
        }
      }
    }

    // Remove from dependents' dependencies
    for (const dependentId of node.dependents) {
      const dependentNode = this.nodes.get(dependentId);
      if (dependentNode) {
        const index = dependentNode.dependencies.indexOf(instanceId);
        if (index >= 0) {
          dependentNode.dependencies.splice(index, 1);
        }
      }
    }

    this.nodes.delete(instanceId);
  }

  /**
   * Get topological sort order for computation.
   * Returns instance IDs in order (dependencies first).
   */
  public getTopologicalOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const visit = (instanceId: string): void => {
      if (visiting.has(instanceId)) {
        throw new Error(`Circular dependency detected involving ${instanceId}`);
      }
      if (visited.has(instanceId)) {
        return;
      }

      visiting.add(instanceId);
      const node = this.nodes.get(instanceId);
      if (node) {
        // Visit dependencies first
        for (const depId of node.dependencies) {
          visit(depId);
        }
      }
      visiting.delete(instanceId);
      visited.add(instanceId);
      result.push(instanceId);
    };

    // Visit all nodes
    for (const instanceId of this.nodes.keys()) {
      if (!visited.has(instanceId)) {
        visit(instanceId);
      }
    }

    return result;
  }

  /**
   * Get direct dependencies for an instance.
   */
  public getDependencies(instanceId: string): string[] {
    const node = this.nodes.get(instanceId);
    return node ? [...node.dependencies] : [];
  }

  /**
   * Get all dependencies (transitive) for an instance.
   */
  public getAllDependencies(instanceId: string): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const collect = (id: string): void => {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const depId of node.dependencies) {
          result.push(depId);
          collect(depId);
        }
      }
    };

    collect(instanceId);
    return result;
  }

  /**
   * Get dependents (instances that depend on this one).
   */
  public getDependents(instanceId: string): string[] {
    const node = this.nodes.get(instanceId);
    return node ? [...node.dependents] : [];
  }

  /**
   * Check if adding a dependency would create a cycle.
   */
  private wouldCreateCycle(instanceId: string, dependencies: string[]): boolean {
    // Check if any dependency (or its transitive dependencies) depends on instanceId
    for (const depId of dependencies) {
      if (depId === instanceId) {
        return true; // Self-dependency
      }
      const allDeps = this.getAllDependencies(depId);
      if (allDeps.includes(instanceId)) {
        return true; // Circular dependency
      }
    }
    return false;
  }

  /**
   * Resolve dependencies for an indicator.
   * Handles both explicit dependencies and computed dependencies (e.g., MACD depends on EMA).
   */
  private resolveDependencies(
    definition: IndicatorDefinition,
    params: Record<string, any>,
  ): string[] {
    // Start with explicit dependencies from definition
    const dependencies: string[] = definition.dependencies ? [...definition.dependencies] : [];

    // Some indicators have computed dependencies based on params
    // For example, MACD depends on EMA instances with specific periods
    // This is handled at a higher level (computation engine) for now
    // For MVP, we only handle explicit dependencies

    return dependencies;
  }

  /**
   * Update dependency relationships when an instance is added/updated.
   */
  private updateDependencyRelationships(instanceId: string, dependencies: string[]): void {
    const node = this.nodes.get(instanceId);
    if (!node) {
      return;
    }

    // Remove old dependencies that are no longer present
    const oldDeps = new Set(node.dependencies);
    const newDeps = new Set(dependencies);

    for (const oldDepId of oldDeps) {
      if (!newDeps.has(oldDepId)) {
        // Remove from old dependency's dependents
        const oldDepNode = this.nodes.get(oldDepId);
        if (oldDepNode) {
          const index = oldDepNode.dependents.indexOf(instanceId);
          if (index >= 0) {
            oldDepNode.dependents.splice(index, 1);
          }
        }
      }
    }

    // Add new dependencies
    for (const newDepId of dependencies) {
      if (!oldDeps.has(newDepId)) {
        // Add to new dependency's dependents
        let depNode = this.nodes.get(newDepId);
        if (!depNode) {
          // Dependency instance doesn't exist yet (might be added later)
          // This is okay, we'll handle it when the dependency is added
          continue;
        }
        if (!depNode.dependents.includes(instanceId)) {
          depNode.dependents.push(instanceId);
        }
      }
    }

    // Update node dependencies
    node.dependencies = dependencies;
  }

  /**
   * Clear all nodes.
   */
  public clear(): void {
    this.nodes.clear();
  }

  /**
   * Get all instance IDs.
   */
  public getAllInstanceIds(): string[] {
    return Array.from(this.nodes.keys());
  }
}

