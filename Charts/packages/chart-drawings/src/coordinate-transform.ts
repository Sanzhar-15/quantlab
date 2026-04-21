/**
 * Coordinate transform system: data ↔ screen ↔ physical pixels.
 */

import type { AnchorPoint, Point } from './types';
import type { VisibleTimeRange } from '@charts-plus/chart-core';

/**
 * Coordinate transform interface.
 */
export interface CoordinateTransform {
  // Data → Screen
  timeToX(time: number): number;
  priceToY(price: number): number;
  dataToScreen(anchor: AnchorPoint): Point;
  
  // Screen → Data
  xToTime(x: number): number;
  yToPrice(y: number): number;
  screenToData(point: Point): AnchorPoint;
  
  // Screen → Physical
  screenToPhysical(point: Point): Point;
  physicalToScreen(point: Point): Point;
  
  // Current scale info
  timeScale: { min: number; max: number; pixelsPerMs: number };
  priceScale: { min: number; max: number; pixelsPerUnit: number };
}

/**
 * Coordinate transform implementation.
 */
export class CoordinateTransformImpl implements CoordinateTransform {
  private plotRect: { x: number; y: number; width: number; height: number };
  private timeRange: VisibleTimeRange;
  private priceRange: { min: number; max: number };
  private dpr: number;

  public constructor(
    plotRect: { x: number; y: number; width: number; height: number },
    timeRange: VisibleTimeRange,
    priceRange: { min: number; max: number },
    dpr: number = 1,
  ) {
    this.plotRect = plotRect;
    this.timeRange = timeRange;
    this.priceRange = priceRange;
    this.dpr = dpr;
  }

  /**
   * Convert time to screen X coordinate.
   */
  public timeToX(time: number): number {
    const timeSpan = this.timeRange.to - this.timeRange.from;
    if (timeSpan <= 0) {
      return this.plotRect.x;
    }
    const normalizedTime = (time - this.timeRange.from) / timeSpan;
    return this.plotRect.x + normalizedTime * this.plotRect.width;
  }

  /**
   * Convert price to screen Y coordinate.
   */
  public priceToY(price: number): number {
    const priceSpan = this.priceRange.max - this.priceRange.min;
    if (priceSpan <= 0) {
      return this.plotRect.y;
    }
    const normalizedPrice = (price - this.priceRange.min) / priceSpan;
    // Y is inverted (top is 0, bottom is height)
    return this.plotRect.y + (1 - normalizedPrice) * this.plotRect.height;
  }

  /**
   * Convert data anchor to screen point.
   */
  public dataToScreen(anchor: AnchorPoint): Point {
    return {
      x: this.timeToX(anchor.time),
      y: this.priceToY(anchor.price),
    };
  }

  /**
   * Convert screen X coordinate to time.
   */
  public xToTime(x: number): number {
    const relativeX = x - this.plotRect.x;
    const normalizedX = relativeX / this.plotRect.width;
    const timeSpan = this.timeRange.to - this.timeRange.from;
    return this.timeRange.from + normalizedX * timeSpan;
  }

  /**
   * Convert screen Y coordinate to price.
   */
  public yToPrice(y: number): number {
    const relativeY = y - this.plotRect.y;
    const normalizedY = 1 - (relativeY / this.plotRect.height); // Invert Y
    const priceSpan = this.priceRange.max - this.priceRange.min;
    return this.priceRange.min + normalizedY * priceSpan;
  }

  /**
   * Convert screen point to data anchor.
   */
  public screenToData(point: Point): AnchorPoint {
    return {
      time: this.xToTime(point.x),
      price: this.yToPrice(point.y),
    };
  }

  /**
   * Convert screen point to physical pixels.
   */
  public screenToPhysical(point: Point): Point {
    return {
      x: point.x * this.dpr,
      y: point.y * this.dpr,
    };
  }

  /**
   * Convert physical pixels to screen point.
   */
  public physicalToScreen(point: Point): Point {
    return {
      x: point.x / this.dpr,
      y: point.y / this.dpr,
    };
  }

  /**
   * Get time scale information.
   */
  public get timeScale(): { min: number; max: number; pixelsPerMs: number } {
    const timeSpan = this.timeRange.to - this.timeRange.from;
    return {
      min: this.timeRange.from,
      max: this.timeRange.to,
      pixelsPerMs: timeSpan > 0 ? this.plotRect.width / timeSpan : 0,
    };
  }

  /**
   * Get price scale information.
   */
  public get priceScale(): { min: number; max: number; pixelsPerUnit: number } {
    const priceSpan = this.priceRange.max - this.priceRange.min;
    return {
      min: this.priceRange.min,
      max: this.priceRange.max,
      pixelsPerUnit: priceSpan > 0 ? this.plotRect.height / priceSpan : 0,
    };
  }

  /**
   * Update transform with new viewport.
   */
  public update(
    plotRect: { x: number; y: number; width: number; height: number },
    timeRange: VisibleTimeRange,
    priceRange: { min: number; max: number },
    dpr?: number,
  ): void {
    this.plotRect = plotRect;
    this.timeRange = timeRange;
    this.priceRange = priceRange;
    if (dpr !== undefined) {
      this.dpr = dpr;
    }
  }
}

