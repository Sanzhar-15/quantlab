/**
 * Memory management with budget enforcement.
 */

/**
 * Memory budget options.
 */
export interface MemoryBudgetOptions {
  maxGPUMemoryMB?: number;
  maxCPUMemoryMB?: number;
  tileCacheBudgetMB?: number;
  atlasBudgetMB?: number;
}

/**
 * Memory manager.
 */
export class MemoryManager {
  private budgets: MemoryBudgetOptions;
  private currentGPUMemoryMB = 0;
  private currentCPUMemoryMB = 0;

  public constructor(budgets: MemoryBudgetOptions = {}) {
    this.budgets = {
      maxGPUMemoryMB: budgets.maxGPUMemoryMB ?? 512,
      maxCPUMemoryMB: budgets.maxCPUMemoryMB ?? 256,
      tileCacheBudgetMB: budgets.tileCacheBudgetMB ?? 192,
      atlasBudgetMB: budgets.atlasBudgetMB ?? 128,
    };
  }

  /**
   * Check if GPU memory is available.
   */
  public canAllocateGPU(sizeMB: number): boolean {
    return (this.currentGPUMemoryMB + sizeMB) <= (this.budgets.maxGPUMemoryMB || Infinity);
  }

  /**
   * Allocate GPU memory.
   */
  public allocateGPU(sizeMB: number): boolean {
    if (!this.canAllocateGPU(sizeMB)) {
      return false;
    }
    this.currentGPUMemoryMB += sizeMB;
    return true;
  }

  /**
   * Free GPU memory.
   */
  public freeGPU(sizeMB: number): void {
    this.currentGPUMemoryMB = Math.max(0, this.currentGPUMemoryMB - sizeMB);
  }

  /**
   * Check if CPU memory is available.
   */
  public canAllocateCPU(sizeMB: number): boolean {
    return (this.currentCPUMemoryMB + sizeMB) <= (this.budgets.maxCPUMemoryMB || Infinity);
  }

  /**
   * Allocate CPU memory.
   */
  public allocateCPU(sizeMB: number): boolean {
    if (!this.canAllocateCPU(sizeMB)) {
      return false;
    }
    this.currentCPUMemoryMB += sizeMB;
    return true;
  }

  /**
   * Free CPU memory.
   */
  public freeCPU(sizeMB: number): void {
    this.currentCPUMemoryMB = Math.max(0, this.currentCPUMemoryMB - sizeMB);
  }

  /**
   * Get current GPU memory usage.
   */
  public getGPUMemoryUsage(): number {
    return this.currentGPUMemoryMB;
  }

  /**
   * Get current CPU memory usage.
   */
  public getCPUMemoryUsage(): number {
    return this.currentCPUMemoryMB;
  }

  /**
   * Get memory pressure (0-1, where 1 is at budget limit).
   */
  public getMemoryPressure(): { gpu: number; cpu: number } {
    return {
      gpu: this.budgets.maxGPUMemoryMB
        ? this.currentGPUMemoryMB / this.budgets.maxGPUMemoryMB
        : 0,
      cpu: this.budgets.maxCPUMemoryMB
        ? this.currentCPUMemoryMB / this.budgets.maxCPUMemoryMB
        : 0,
    };
  }

  /**
   * Check if memory pressure is high.
   */
  public isMemoryPressureHigh(threshold: number = 0.8): boolean {
    const pressure = this.getMemoryPressure();
    return pressure.gpu >= threshold || pressure.cpu >= threshold;
  }

  /**
   * Update budgets.
   */
  public updateBudgets(budgets: Partial<MemoryBudgetOptions>): void {
    this.budgets = { ...this.budgets, ...budgets };
  }
}

