/**
 * Time-Travel Debugger Controls for Chart Webview.
 *
 * Provides UI controls for navigating through backtest execution:
 * - Bar stepping (forward/backward)
 * - Jump to trade
 * - State inspection panel
 * - Condition display
 *
 * Spec Reference: Product Spec Section 4.2, Technical Spec Section 19
 */

import { vscodeApi } from './index';

/** Debug state at a specific bar */
export interface DebugState {
    barIndex: number;
    timestamp: string;
    cash: string;
    equity: string;
    positions: Record<string, string>;
    pendingOrders: number;
    unrealizedPnl: string;
    realizedPnl: string;
    grossExposure: string;
}

/** Captured condition evaluation */
export interface ConditionCapture {
    barIndex: number;
    lineNumber: number;
    expression: string;
    leftValue: string;
    operator: string;
    rightValue: string;
    result: boolean;
}

/** Signal at a bar */
export interface DebugSignal {
    barIndex: number;
    signalId: string;
    symbol: string;
    side: string;
    quantity: string;
    orderType: string;
    limitPrice?: string;
    stopPrice?: string;
}

/** Fill at a bar */
export interface DebugFill {
    barIndex: number;
    fillId: string;
    orderId: string;
    symbol: string;
    side: string;
    quantity: string;
    price: string;
    commission: string;
}

/** Debugger navigation state */
export interface DebuggerState {
    enabled: boolean;
    currentBar: number;
    totalBars: number;
    state: DebugState | null;
    conditions: ConditionCapture[];
    signals: DebugSignal[];
    fills: DebugFill[];
    tradeBarIndices: number[];
    isPlaying: boolean;
    playbackSpeed: number;
}

/** Debugger event types */
export type DebuggerEvent =
    | { type: 'stepForward' }
    | { type: 'stepBackward' }
    | { type: 'jumpToStart' }
    | { type: 'jumpToEnd' }
    | { type: 'jumpToBar'; barIndex: number }
    | { type: 'jumpToNextTrade' }
    | { type: 'jumpToPrevTrade' }
    | { type: 'togglePlay' }
    | { type: 'setSpeed'; speed: number }
    | { type: 'highlightLine'; lineNumber: number }
    | { type: 'reset' };

/**
 * Time-Travel Debugger Controller.
 *
 * Manages debugger state and UI interactions.
 */
export class DebuggerController {
    private state: DebuggerState;
    private container: HTMLElement | null = null;
    private statePanel: HTMLElement | null = null;
    private conditionsPanel: HTMLElement | null = null;
    private controlsPanel: HTMLElement | null = null;
    private playInterval: number | null = null;

    constructor() {
        this.state = {
            enabled: false,
            currentBar: 0,
            totalBars: 0,
            state: null,
            conditions: [],
            signals: [],
            fills: [],
            tradeBarIndices: [],
            isPlaying: false,
            playbackSpeed: 1,
        };
    }

    /**
     * Initialize the debugger UI.
     */
    init(containerId: string): void {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error('Debugger container not found:', containerId);
            return;
        }

        this.render();
        this.setupEventListeners();
    }

    /**
     * Enable debugger with debug file data.
     */
    enable(totalBars: number, tradeBarIndices: number[]): void {
        this.state.enabled = true;
        this.state.totalBars = totalBars;
        this.state.tradeBarIndices = tradeBarIndices;
        this.state.currentBar = 0;
        this.render();
        this.requestBarData(0);
    }

    /**
     * Disable debugger.
     */
    disable(): void {
        this.state.enabled = false;
        this.stopPlayback();
        this.render();
    }

    /**
     * Update debugger state for current bar.
     */
    updateBarData(
        state: DebugState,
        conditions: ConditionCapture[],
        signals: DebugSignal[],
        fills: DebugFill[]
    ): void {
        this.state.state = state;
        this.state.conditions = conditions;
        this.state.signals = signals;
        this.state.fills = fills;
        this.renderState();
        this.renderConditions();
    }

    /**
     * Handle debugger events.
     */
    handleEvent(event: DebuggerEvent): void {
        switch (event.type) {
            case 'stepForward':
                this.stepForward();
                break;
            case 'stepBackward':
                this.stepBackward();
                break;
            case 'jumpToStart':
                this.jumpToBar(0);
                break;
            case 'jumpToEnd':
                this.jumpToBar(this.state.totalBars - 1);
                break;
            case 'jumpToBar':
                this.jumpToBar(event.barIndex);
                break;
            case 'jumpToNextTrade':
                this.jumpToNextTrade();
                break;
            case 'jumpToPrevTrade':
                this.jumpToPrevTrade();
                break;
            case 'togglePlay':
                this.togglePlayback();
                break;
            case 'setSpeed':
                this.state.playbackSpeed = event.speed;
                if (this.state.isPlaying) {
                    this.stopPlayback();
                    this.startPlayback();
                }
                break;
            case 'highlightLine':
                this.highlightCodeLine(event.lineNumber);
                break;
            case 'reset':
                this.jumpToBar(0);
                break;
        }
    }

    private stepForward(): void {
        if (this.state.currentBar < this.state.totalBars - 1) {
            this.jumpToBar(this.state.currentBar + 1);
        }
    }

    private stepBackward(): void {
        if (this.state.currentBar > 0) {
            this.jumpToBar(this.state.currentBar - 1);
        }
    }

    private jumpToBar(barIndex: number): void {
        if (barIndex >= 0 && barIndex < this.state.totalBars) {
            this.state.currentBar = barIndex;
            this.requestBarData(barIndex);
            this.renderControls();

            // Notify extension to sync chart
            vscodeApi.postMessage({
                type: 'debugger.jumpToBar',
                barIndex,
            });
        }
    }

    private jumpToNextTrade(): void {
        const next = this.state.tradeBarIndices.find(
            (i) => i > this.state.currentBar
        );
        if (next !== undefined) {
            this.jumpToBar(next);
        }
    }

    private jumpToPrevTrade(): void {
        const prev = [...this.state.tradeBarIndices]
            .reverse()
            .find((i) => i < this.state.currentBar);
        if (prev !== undefined) {
            this.jumpToBar(prev);
        }
    }

    private togglePlayback(): void {
        if (this.state.isPlaying) {
            this.stopPlayback();
        } else {
            this.startPlayback();
        }
        this.renderControls();
    }

    private startPlayback(): void {
        this.state.isPlaying = true;
        const intervalMs = 1000 / this.state.playbackSpeed;
        this.playInterval = window.setInterval(() => {
            if (this.state.currentBar < this.state.totalBars - 1) {
                this.stepForward();
            } else {
                this.stopPlayback();
            }
        }, intervalMs);
    }

    private stopPlayback(): void {
        this.state.isPlaying = false;
        if (this.playInterval !== null) {
            window.clearInterval(this.playInterval);
            this.playInterval = null;
        }
    }

    private requestBarData(barIndex: number): void {
        vscodeApi.postMessage({
            type: 'debugger.requestBarData',
            barIndex,
        });
    }

    private highlightCodeLine(lineNumber: number): void {
        vscodeApi.postMessage({
            type: 'debugger.highlightLine',
            lineNumber,
        });
    }

    private render(): void {
        if (!this.container) return;

        if (!this.state.enabled) {
            this.container.innerHTML = '';
            this.container.style.display = 'none';
            return;
        }

        this.container.style.display = 'block';
        this.container.innerHTML = `
            <div class="debugger-panel">
                <div class="debugger-header">
                    <span class="debugger-title">Time-Travel Debugger</span>
                    <span class="debugger-bar-info">Bar ${this.state.currentBar + 1} of ${this.state.totalBars}</span>
                </div>
                <div id="debugger-controls" class="debugger-controls"></div>
                <div class="debugger-content">
                    <div id="debugger-state" class="debugger-state"></div>
                    <div id="debugger-conditions" class="debugger-conditions"></div>
                </div>
            </div>
        `;

        this.controlsPanel = document.getElementById('debugger-controls');
        this.statePanel = document.getElementById('debugger-state');
        this.conditionsPanel = document.getElementById('debugger-conditions');

        this.renderControls();
        this.renderState();
        this.renderConditions();
    }

    private renderControls(): void {
        if (!this.controlsPanel) return;

        const playIcon = this.state.isPlaying ? '⏸' : '▶';
        const atStart = this.state.currentBar === 0;
        const atEnd = this.state.currentBar >= this.state.totalBars - 1;

        this.controlsPanel.innerHTML = `
            <div class="control-buttons">
                <button class="control-btn" data-action="jumpToStart" ${atStart ? 'disabled' : ''} title="Jump to start">|◀</button>
                <button class="control-btn" data-action="stepBackward" ${atStart ? 'disabled' : ''} title="Step backward">◀</button>
                <button class="control-btn play-btn" data-action="togglePlay" title="${this.state.isPlaying ? 'Pause' : 'Play'}">${playIcon}</button>
                <button class="control-btn" data-action="stepForward" ${atEnd ? 'disabled' : ''} title="Step forward">▶</button>
                <button class="control-btn" data-action="jumpToEnd" ${atEnd ? 'disabled' : ''} title="Jump to end">▶|</button>
            </div>
            <div class="trade-nav">
                <button class="control-btn" data-action="jumpToPrevTrade" title="Previous trade">◀ Trade</button>
                <button class="control-btn" data-action="jumpToNextTrade" title="Next trade">Trade ▶</button>
            </div>
            <div class="speed-control">
                <label>Speed:</label>
                <select id="playback-speed">
                    <option value="0.5" ${this.state.playbackSpeed === 0.5 ? 'selected' : ''}>0.5x</option>
                    <option value="1" ${this.state.playbackSpeed === 1 ? 'selected' : ''}>1x</option>
                    <option value="2" ${this.state.playbackSpeed === 2 ? 'selected' : ''}>2x</option>
                    <option value="5" ${this.state.playbackSpeed === 5 ? 'selected' : ''}>5x</option>
                </select>
            </div>
            <button class="control-btn reset-btn" data-action="reset" title="Reset to start">⟳ Reset</button>
        `;
    }

    private renderState(): void {
        if (!this.statePanel) return;

        const state = this.state.state;
        if (!state) {
            this.statePanel.innerHTML = '<div class="loading">Loading state...</div>';
            return;
        }

        const positionsHtml = Object.entries(state.positions)
            .map(([symbol, qty]) => `<div class="position-row">${symbol}: ${qty}</div>`)
            .join('') || '<div class="empty">No positions</div>';

        this.statePanel.innerHTML = `
            <div class="state-section">
                <div class="state-header">STATE @ BAR ${state.barIndex + 1}</div>
                <div class="state-row">
                    <span class="state-label">Timestamp:</span>
                    <span class="state-value">${state.timestamp}</span>
                </div>
                <div class="state-row">
                    <span class="state-label">Cash:</span>
                    <span class="state-value">$${formatNumber(state.cash)}</span>
                </div>
                <div class="state-row">
                    <span class="state-label">Equity:</span>
                    <span class="state-value">$${formatNumber(state.equity)}</span>
                </div>
                <div class="state-row">
                    <span class="state-label">P&L:</span>
                    <span class="state-value ${parseFloat(state.unrealizedPnl) >= 0 ? 'positive' : 'negative'}">
                        $${formatNumber(state.unrealizedPnl)}
                    </span>
                </div>
            </div>
            <div class="state-section">
                <div class="state-header">POSITIONS</div>
                ${positionsHtml}
            </div>
            ${this.renderSignals()}
            ${this.renderFills()}
        `;
    }

    private renderSignals(): string {
        if (this.state.signals.length === 0) {
            return '';
        }

        const signalsHtml = this.state.signals
            .map(
                (s) => `
                <div class="signal-row">
                    <span class="signal-side ${s.side}">${s.side.toUpperCase()}</span>
                    <span class="signal-qty">${s.quantity}</span>
                    <span class="signal-symbol">${s.symbol}</span>
                    <span class="signal-type">${s.orderType}</span>
                </div>
            `
            )
            .join('');

        return `
            <div class="state-section">
                <div class="state-header">SIGNALS</div>
                ${signalsHtml}
            </div>
        `;
    }

    private renderFills(): string {
        if (this.state.fills.length === 0) {
            return '';
        }

        const fillsHtml = this.state.fills
            .map(
                (f) => `
                <div class="fill-row">
                    <span class="fill-side ${f.side}">${f.side.toUpperCase()}</span>
                    <span class="fill-qty">${f.quantity}</span>
                    <span class="fill-symbol">${f.symbol}</span>
                    <span class="fill-price">@ $${formatNumber(f.price)}</span>
                </div>
            `
            )
            .join('');

        return `
            <div class="state-section">
                <div class="state-header">FILLS</div>
                ${fillsHtml}
            </div>
        `;
    }

    private renderConditions(): void {
        if (!this.conditionsPanel) return;

        if (this.state.conditions.length === 0) {
            this.conditionsPanel.innerHTML = '';
            return;
        }

        const conditionsHtml = this.state.conditions
            .map(
                (c) => `
                <div class="condition-row ${c.result ? 'true' : 'false'}"
                     data-line="${c.lineNumber}"
                     title="Click to highlight in code">
                    <div class="condition-expr">${escapeHtml(c.expression)}</div>
                    <div class="condition-values">
                        <span class="condition-left">${escapeHtml(c.leftValue)}</span>
                        <span class="condition-op">${escapeHtml(c.operator)}</span>
                        <span class="condition-right">${escapeHtml(c.rightValue)}</span>
                        <span class="condition-result">→ ${c.result ? 'TRUE' : 'FALSE'}</span>
                    </div>
                </div>
            `
            )
            .join('');

        this.conditionsPanel.innerHTML = `
            <div class="state-section">
                <div class="state-header">CONDITIONS</div>
                ${conditionsHtml}
            </div>
        `;
    }

    private setupEventListeners(): void {
        if (!this.container) return;

        // Control button clicks
        this.container.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const action = target.dataset.action;
            if (action) {
                this.handleEvent({ type: action } as DebuggerEvent);
            }

            // Condition row clicks
            if (target.closest('.condition-row')) {
                const lineNumber = parseInt(
                    target.closest('.condition-row')?.getAttribute('data-line') || '0'
                );
                if (lineNumber > 0) {
                    this.highlightCodeLine(lineNumber);
                }
            }
        });

        // Speed selector
        this.container.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            if (target.id === 'playback-speed') {
                this.handleEvent({
                    type: 'setSpeed',
                    speed: parseFloat(target.value),
                });
            }
        });
    }
}

// Utility functions
function formatNumber(value: string): string {
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    return num.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Export singleton instance
export const debuggerController = new DebuggerController();
