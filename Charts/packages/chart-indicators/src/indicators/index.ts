/**
 * Indicator implementations registry.
 */

import type { IndicatorComputation } from './base';
import { SMAIndicator } from './sma';
import { EMAIndicator } from './ema';
import { RSIIndicator } from './rsi';
import { MACDIndicator } from './macd';
import { BollingerIndicator } from './bollinger';
import { ATRIndicator } from './atr';
import { VWAPIndicator } from './vwap';
import { StochasticIndicator } from './stochastic';
import { VolumeProfileIndicator } from './volume-profile';

/**
 * Get indicator computation implementation.
 */
export function getIndicatorComputation(id: string): IndicatorComputation | null {
  switch (id) {
    case 'sma':
      return new SMAIndicator();
    case 'ema':
      return new EMAIndicator();
    case 'rsi':
      return new RSIIndicator();
    case 'macd':
      return new MACDIndicator();
    case 'bollinger':
      return new BollingerIndicator();
    case 'atr':
      return new ATRIndicator();
    case 'vwap':
      return new VWAPIndicator();
    case 'stochastic':
      return new StochasticIndicator();
    case 'volume-profile':
      return new VolumeProfileIndicator();
    // TODO: Add more indicators
    // case 'wma': return new WMAIndicator();
    // case 'volume': return new VolumeIndicator();
    // case 'obv': return new OBVIndicator();
    // case 'volume-ma': return new VolumeMAIndicator();
    // case 'bollinger-width': return new BollingerWidthIndicator();
    // case 'ichimoku': return new IchimokuIndicator();
    // case 'pivots': return new PivotsIndicator();
    default:
      return null;
  }
}

