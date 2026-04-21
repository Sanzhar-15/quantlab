/**
 * Refinement scheduler for progressive tile quality.
 * Manages job queue for tile rebuilds with priority scoring.
 */

import type { TileKey, TileJob, ViewportRect, Point } from './tile-types';
import { TileCoordinates } from './tile-types';

/**
 * Refinement scheduler.
 * Processes tile rendering jobs with priority-based scheduling.
 */
export class RefinementScheduler {
  private jobQueue: TileJob[] = [];
  private activeJobs = new Set<string>();
  private frameBudgetMs = 10; // 10ms per frame for refinement
  private frameCounter = 0;

  /**
   * Schedule a tile job.
   */
  public scheduleJob(key: TileKey, stage: 0 | 1 | 2, priority: number): void {
    const keyStr = this.jobKeyToString(key);
    
    // Cancel existing job for this tile if any
    this.cancelJob(key);

    const job: TileJob = {
      key,
      stage,
      priority,
      scheduledAt: Date.now(),
    };

    // Insert in priority order (highest first)
    let inserted = false;
    for (let i = 0; i < this.jobQueue.length; i++) {
      if (this.jobQueue[i]!.priority < priority) {
        this.jobQueue.splice(i, 0, job);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.jobQueue.push(job);
    }
  }

  /**
   * Cancel a job for a specific tile.
   */
  public cancelJob(key: TileKey | string): void {
    const keyStr = typeof key === 'string' ? key : this.jobKeyToString(key);
    
    // Remove from queue
    this.jobQueue = this.jobQueue.filter((job) => this.jobKeyToString(job.key) !== keyStr);
    
    // Remove from active
    this.activeJobs.delete(keyStr);
  }

  /**
   * Process jobs up to frame budget.
   * Returns array of jobs that were processed.
   */
  public processJobs(frameTime: number, maxTimeMs: number = this.frameBudgetMs): TileJob[] {
    const startTime = performance.now();
    const processed: TileJob[] = [];

    while (this.jobQueue.length > 0 && (performance.now() - startTime) < maxTimeMs) {
      const job = this.jobQueue.shift();
      if (!job) break;

      const keyStr = this.jobKeyToString(job.key);
      if (this.activeJobs.has(keyStr)) {
        // Job already active, skip
        continue;
      }

      this.activeJobs.add(keyStr);
      processed.push(job);
    }

    return processed;
  }

  /**
   * Mark a job as complete.
   */
  public completeJob(key: TileKey): void {
    const keyStr = this.jobKeyToString(key);
    this.activeJobs.delete(keyStr);
  }

  /**
   * Get current queue length.
   */
  public getQueueLength(): number {
    return this.jobQueue.length;
  }

  /**
   * Get number of active jobs.
   */
  public getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Clear all jobs.
   */
  public clear(): void {
    this.jobQueue = [];
    this.activeJobs.clear();
  }

  /**
   * Get next job without processing it.
   */
  public peekNextJob(): TileJob | null {
    return this.jobQueue[0] ?? null;
  }

  /**
   * Update frame counter.
   */
  public tickFrame(): void {
    this.frameCounter++;
  }

  /**
   * Set frame budget in milliseconds.
   */
  public setFrameBudget(ms: number): void {
    this.frameBudgetMs = ms;
  }

  /**
   * Get frame budget in milliseconds.
   */
  public getFrameBudget(): number {
    return this.frameBudgetMs;
  }

  /**
   * Score a tile job based on viewport and pointer position.
   */
  public static scoreTileJob(
    key: TileKey,
    viewport: ViewportRect,
    pointer: Point | null,
    tileSize: number,
  ): number {
    let score = 0;

    const tileCenter = TileCoordinates.getTileCenter(key.tileX, key.tileY, tileSize);
    const viewportCenter: Point = {
      x: viewport.x + viewport.width * 0.5,
      y: viewport.y + viewport.height * 0.5,
    };

    // Distance to pointer (higher priority near pointer)
    if (pointer) {
      const dist = Math.sqrt(
        Math.pow(tileCenter.x - pointer.x, 2) + Math.pow(tileCenter.y - pointer.y, 2),
      );
      score += 1000 / (1 + dist / 100); // Scale by 100px
    }

    // Distance to viewport center
    const centerDist = Math.sqrt(
      Math.pow(tileCenter.x - viewportCenter.x, 2) + Math.pow(tileCenter.y - viewportCenter.y, 2),
    );
    score += 500 / (1 + centerDist / 100);

    // Stage penalty (lower stages = higher priority)
    score += (3 - key.stage) * 50;

    return score;
  }

  /**
   * Convert tile key to string for job tracking.
   */
  private jobKeyToString(key: TileKey): string {
    return `${key.paneId}|${key.tileX}|${key.tileY}|${key.stage}`;
  }

  /**
   * Get statistics.
   */
  public getStats(): {
    queueLength: number;
    activeJobs: number;
    frameBudgetMs: number;
  } {
    return {
      queueLength: this.jobQueue.length,
      activeJobs: this.activeJobs.size,
      frameBudgetMs: this.frameBudgetMs,
    };
  }
}

