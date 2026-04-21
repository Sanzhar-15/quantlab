/*---------------------------------------------------------------------------------------------
 *  Exposure Manager (Advisory).
 *
 *  Client-side exposure tracking for pre-validation and UI updates.
 *  The Python daemon is authoritative - this is advisory only.
 *
 *  Spec Reference: Technical Spec §8.3, Decision K64
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import type TypedEmitter from 'typed-emitter';

/**
 * Exposure limits configuration.
 */
export interface ExposureLimits {
	maxExposure: number;
	maxPositionSize: number;
	maxOrderSize: number;
	maxDailyLoss: number;
	maxOpenOrders: number;
}

/**
 * Current exposure state.
 */
export interface ExposureState {
	totalExposure: number;
	unreservedCapacity: number;
	reservedByOrders: number;
	positionExposure: number;
	dailyPnL: number;
	openOrderCount: number;
	utilizationPercent: number;
}

/**
 * Exposure validation result.
 */
export interface ExposureValidationResult {
	allowed: boolean;
	reason?: string;
	wouldExceedExposure?: boolean;
	wouldExceedPositionSize?: boolean;
	wouldExceedOrderSize?: boolean;
	wouldExceedDailyLoss?: boolean;
	wouldExceedOpenOrders?: boolean;
}

/**
 * Position data for exposure calculation.
 */
export interface PositionData {
	symbol: string;
	quantity: number;
	currentPrice: number;
	avgEntryPrice: number;
}

/**
 * Order data for exposure calculation.
 */
export interface OrderData {
	orderId: string;
	symbol: string;
	side: 'buy' | 'sell';
	quantity: number;
	price: number;
}

/**
 * Exposure manager events.
 */
interface ExposureManagerEvents {
	'exposure.updated': (state: ExposureState) => void;
	'exposure.warning': (message: string, utilizationPercent: number) => void;
	'exposure.limit_reached': (limitType: string) => void;
	[key: string]: (...args: any[]) => void;
}

/**
 * Default exposure limits.
 */
const DEFAULT_LIMITS: ExposureLimits = {
	maxExposure: 100000,
	maxPositionSize: 25000,
	maxOrderSize: 10000,
	maxDailyLoss: 5000,
	maxOpenOrders: 50,
};

/**
 * Warning threshold for exposure utilization.
 */
const WARNING_THRESHOLD = 0.8; // 80%

/**
 * Client-side exposure manager (advisory only).
 *
 * This provides:
 * - Pre-validation before sending orders to daemon
 * - Real-time exposure updates for UI
 * - Warning notifications at high utilization
 *
 * IMPORTANT: The Python daemon has the authoritative exposure tracker.
 * This client-side tracker may be slightly out of sync. Always defer
 * to daemon rejection if there's a conflict.
 */
export class ExposureManager extends (EventEmitter as new () => TypedEmitter<ExposureManagerEvents>) {
	private static instance: ExposureManager | undefined;

	private limits: ExposureLimits;
	private positions: Map<string, PositionData> = new Map();
	private pendingOrders: Map<string, OrderData> = new Map();
	private dailyPnL: number = 0;
	private lastWarningUtilization: number = 0;

	private constructor(limits?: Partial<ExposureLimits>) {
		super();
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	/**
	 * Get singleton instance.
	 */
	static getInstance(limits?: Partial<ExposureLimits>): ExposureManager {
		if (!ExposureManager.instance) {
			ExposureManager.instance = new ExposureManager(limits);
		}
		return ExposureManager.instance;
	}

	/**
	 * Update limits.
	 */
	setLimits(limits: Partial<ExposureLimits>): void {
		this.limits = { ...this.limits, ...limits };
		this.emitUpdate();
	}

	/**
	 * Get current limits.
	 */
	getLimits(): ExposureLimits {
		return { ...this.limits };
	}

	/**
	 * Get current exposure state.
	 */
	getState(): ExposureState {
		const positionExposure = this.calculatePositionExposure();
		const reservedByOrders = this.calculateOrderReservation();
		const totalExposure = positionExposure + reservedByOrders;
		const unreservedCapacity = Math.max(0, this.limits.maxExposure - totalExposure);
		const utilizationPercent = (totalExposure / this.limits.maxExposure) * 100;

		return {
			totalExposure,
			unreservedCapacity,
			reservedByOrders,
			positionExposure,
			dailyPnL: this.dailyPnL,
			openOrderCount: this.pendingOrders.size,
			utilizationPercent,
		};
	}

	// ============================================================
	// Position Updates
	// ============================================================

	/**
	 * Update position from daemon.
	 */
	updatePosition(position: PositionData): void {
		if (position.quantity === 0) {
			this.positions.delete(position.symbol);
		} else {
			this.positions.set(position.symbol, position);
		}
		this.emitUpdate();
	}

	/**
	 * Bulk update positions.
	 */
	updatePositions(positions: PositionData[]): void {
		this.positions.clear();
		for (const position of positions) {
			if (position.quantity !== 0) {
				this.positions.set(position.symbol, position);
			}
		}
		this.emitUpdate();
	}

	/**
	 * Clear all positions.
	 */
	clearPositions(): void {
		this.positions.clear();
		this.emitUpdate();
	}

	// ============================================================
	// Order Tracking
	// ============================================================

	/**
	 * Reserve exposure for a pending order.
	 */
	reserveForOrder(order: OrderData): boolean {
		// First validate
		const validation = this.validateOrder(order);
		if (!validation.allowed) {
			return false;
		}

		this.pendingOrders.set(order.orderId, order);
		this.emitUpdate();
		return true;
	}

	/**
	 * Release reservation when order fills or cancels.
	 */
	releaseOrder(orderId: string): void {
		this.pendingOrders.delete(orderId);
		this.emitUpdate();
	}

	/**
	 * Update pending orders from daemon.
	 */
	updatePendingOrders(orders: OrderData[]): void {
		this.pendingOrders.clear();
		for (const order of orders) {
			this.pendingOrders.set(order.orderId, order);
		}
		this.emitUpdate();
	}

	// ============================================================
	// P&L Tracking
	// ============================================================

	/**
	 * Update daily P&L from daemon.
	 */
	updateDailyPnL(pnl: number): void {
		this.dailyPnL = pnl;
		this.emitUpdate();

		// Check daily loss limit
		if (pnl < 0 && Math.abs(pnl) >= this.limits.maxDailyLoss) {
			this.emit('exposure.limit_reached', 'daily_loss');
		}
	}

	/**
	 * Reset daily P&L (called at start of trading day).
	 */
	resetDailyPnL(): void {
		this.dailyPnL = 0;
		this.emitUpdate();
	}

	// ============================================================
	// Validation
	// ============================================================

	/**
	 * Validate an order against exposure limits.
	 *
	 * This is advisory - the daemon is authoritative.
	 */
	validateOrder(order: OrderData): ExposureValidationResult {
		const result: ExposureValidationResult = { allowed: true };
		const orderValue = order.quantity * order.price;
		const state = this.getState();

		// Check order size
		if (orderValue > this.limits.maxOrderSize) {
			result.allowed = false;
			result.reason = `Order size ${orderValue.toFixed(2)} exceeds limit ${this.limits.maxOrderSize}`;
			result.wouldExceedOrderSize = true;
			return result;
		}

		// Check position size (if adding to position)
		const currentPosition = this.positions.get(order.symbol);
		const currentPositionValue = currentPosition
			? Math.abs(currentPosition.quantity) * currentPosition.currentPrice
			: 0;

		const isSameDirection = !currentPosition || (
			(currentPosition.quantity > 0 && order.side === 'buy') ||
			(currentPosition.quantity < 0 && order.side === 'sell')
		);

		if (isSameDirection) {
			const newPositionValue = currentPositionValue + orderValue;
			if (newPositionValue > this.limits.maxPositionSize) {
				result.allowed = false;
				result.reason = `Position would exceed limit: ${newPositionValue.toFixed(2)} > ${this.limits.maxPositionSize}`;
				result.wouldExceedPositionSize = true;
				return result;
			}
		}

		// Check total exposure
		const projectedExposure = state.totalExposure + orderValue;
		if (projectedExposure > this.limits.maxExposure) {
			result.allowed = false;
			result.reason = `Would exceed exposure limit: ${projectedExposure.toFixed(2)} > ${this.limits.maxExposure}`;
			result.wouldExceedExposure = true;
			return result;
		}

		// Check open order count
		if (this.pendingOrders.size >= this.limits.maxOpenOrders) {
			result.allowed = false;
			result.reason = `Maximum open orders reached: ${this.limits.maxOpenOrders}`;
			result.wouldExceedOpenOrders = true;
			return result;
		}

		// Check daily loss limit
		if (this.dailyPnL < 0 && Math.abs(this.dailyPnL) >= this.limits.maxDailyLoss * 0.9) {
			result.allowed = false;
			result.reason = 'Daily loss limit nearly reached';
			result.wouldExceedDailyLoss = true;
			return result;
		}

		return result;
	}

	/**
	 * Check if we can place an order of given value.
	 */
	canPlaceOrder(value: number): boolean {
		const state = this.getState();
		return state.unreservedCapacity >= value;
	}

	/**
	 * Get available capacity for new orders.
	 */
	getAvailableCapacity(): number {
		return this.getState().unreservedCapacity;
	}

	// ============================================================
	// Calculations
	// ============================================================

	private calculatePositionExposure(): number {
		let exposure = 0;
		for (const position of this.positions.values()) {
			exposure += Math.abs(position.quantity) * position.currentPrice;
		}
		return exposure;
	}

	private calculateOrderReservation(): number {
		let reserved = 0;
		for (const order of this.pendingOrders.values()) {
			reserved += order.quantity * order.price;
		}
		return reserved;
	}

	// ============================================================
	// Event Emission
	// ============================================================

	private emitUpdate(): void {
		const state = this.getState();
		this.emit('exposure.updated', state);

		// Check for warning threshold
		const utilizationPercent = state.utilizationPercent / 100;
		if (utilizationPercent >= WARNING_THRESHOLD && this.lastWarningUtilization < WARNING_THRESHOLD) {
			this.emit('exposure.warning', `Exposure at ${state.utilizationPercent.toFixed(1)}%`, state.utilizationPercent);
		}
		this.lastWarningUtilization = utilizationPercent;
	}

	// ============================================================
	// Sync with Daemon
	// ============================================================

	/**
	 * Sync state from daemon.
	 *
	 * Called when receiving full state from daemon.
	 */
	syncFromDaemon(data: {
		positions?: PositionData[];
		orders?: OrderData[];
		dailyPnL?: number;
		limits?: Partial<ExposureLimits>;
	}): void {
		if (data.limits) {
			this.limits = { ...this.limits, ...data.limits };
		}
		if (data.positions) {
			this.updatePositions(data.positions);
		}
		if (data.orders) {
			this.updatePendingOrders(data.orders);
		}
		if (data.dailyPnL !== undefined) {
			this.dailyPnL = data.dailyPnL;
		}
		this.emitUpdate();
	}

	/**
	 * Reset all state.
	 */
	reset(): void {
		this.positions.clear();
		this.pendingOrders.clear();
		this.dailyPnL = 0;
		this.lastWarningUtilization = 0;
		this.emitUpdate();
	}
}
