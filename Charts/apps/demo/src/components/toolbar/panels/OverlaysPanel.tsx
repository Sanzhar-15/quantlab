// OverlaysPanel Component
// Tabbed panel: [Fib/Gann] [Volume]

import { useState } from 'react';
import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface OverlaysPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const OverlaysPanel: React.FC<OverlaysPanelProps> = ({ onClose, onSelectTool }) => {
    const [activeTab, setActiveTab] = useState<'fib' | 'volume'>('fib');

    return (
        <BasePanel onClose={onClose}>
            {/* Tab Bar */}
            <div className="panel-tabs">
                <button
                    className={`panel-tab ${activeTab === 'fib' ? 'panel-tab--active' : ''}`}
                    onClick={() => setActiveTab('fib')}
                >
                    Fib / Gann
                </button>
                <button
                    className={`panel-tab ${activeTab === 'volume' ? 'panel-tab--active' : ''}`}
                    onClick={() => setActiveTab('volume')}
                >
                    Volume
                </button>
            </div>

            {activeTab === 'fib' && (
                <>
                    {/* Fibonacci Core */}
                    <div className="panel-section">
                        <div className="panel-section-title">Fibonacci Core</div>
                        <div className="tool-list">
                            <ToolItem id="fib_retracement" name="Fib Retracement" icon="ϕ" onSelect={onSelectTool} />
                            <ToolItem id="fib_extension" name="Trend-Based Extension" icon="ϕ→" onSelect={onSelectTool} />
                            <ToolItem id="fib_channel" name="Fib Channel" icon="ϕ⫽" onSelect={onSelectTool} />
                            <ToolItem id="auto_fib" name="Auto-Fib" icon="⚡ϕ" isNew onSelect={onSelectTool} />
                            <ToolItem id="ote_zone" name="OTE Zone" icon="OTE" isNew onSelect={onSelectTool} />
                        </div>
                    </div>

                    {/* Fibonacci Time */}
                    <div className="panel-section">
                        <div className="panel-section-title">Fibonacci Time</div>
                        <div className="tool-list">
                            <ToolItem id="fib_time_zone" name="Fib Time Zone" icon="ϕ│" onSelect={onSelectTool} />
                            <ToolItem id="fib_time_trend" name="Trend-Based Fib Time" icon="ϕ│→" onSelect={onSelectTool} />
                        </div>
                    </div>

                    {/* Fibonacci Advanced */}
                    <div className="panel-section">
                        <div className="panel-section-title">Fibonacci Advanced</div>
                        <div className="tool-list">
                            <ToolItem id="fib_fan" name="Speed Resistance Fan" icon="ϕ/" onSelect={onSelectTool} />
                            <ToolItem id="fib_arcs" name="Speed Resistance Arcs" icon="ϕ(" onSelect={onSelectTool} />
                            <ToolItem id="fib_circles" name="Fib Circles" icon="ϕ○" onSelect={onSelectTool} />
                            <ToolItem id="fib_spiral" name="Fib Spiral" icon="ϕ@" onSelect={onSelectTool} />
                            <ToolItem id="fib_wedge" name="Fib Wedge" icon="ϕ◁" onSelect={onSelectTool} />
                        </div>
                    </div>

                    {/* Gann */}
                    <div className="panel-section">
                        <div className="panel-section-title">Gann</div>
                        <div className="tool-list">
                            <ToolItem id="gann_fan" name="Gann Fan" icon="G/" onSelect={onSelectTool} />
                            <ToolItem id="gann_box" name="Gann Box" icon="G▭" onSelect={onSelectTool} />
                            <ToolItem id="gann_square" name="Gann Square" icon="G□" onSelect={onSelectTool} />
                        </div>
                    </div>
                </>
            )}

            {activeTab === 'volume' && (
                <>
                    {/* VWAP */}
                    <div className="panel-section">
                        <div className="panel-section-title">VWAP</div>
                        <div className="tool-list">
                            <ToolItem id="anchored_vwap" name="Anchored VWAP" icon="V" onSelect={onSelectTool} />
                            <ToolItem id="vwap_bands" name="VWAP Bands" icon="Vσ" isNew onSelect={onSelectTool} />
                            <ToolItem id="session_vwap" name="Session VWAP" icon="VS" isNew onSelect={onSelectTool} />
                        </div>
                    </div>

                    {/* Volume Profile */}
                    <div className="panel-section">
                        <div className="panel-section-title">Volume Profile</div>
                        <div className="tool-list">
                            <ToolItem id="fixed_range_vp" name="Fixed Range VP" icon="VP" onSelect={onSelectTool} />
                            <ToolItem id="anchored_vp" name="Anchored VP" icon="VP⚓" onSelect={onSelectTool} />
                            <ToolItem id="poc_projection" name="POC Projection" icon="POC" isNew onSelect={onSelectTool} />
                            <ToolItem id="value_area" name="Value Area" icon="VA" isNew onSelect={onSelectTool} />
                        </div>
                    </div>
                </>
            )}
        </BasePanel>
    );
};
