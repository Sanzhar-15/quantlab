/*---------------------------------------------------------------------------------------------
 *  Risk Module Exports.
 *
 *  Client-side risk management (advisory - daemon is authoritative).
 *
 *  Spec Reference: Technical Spec §8.3
 *--------------------------------------------------------------------------------------------*/

export {
	ExposureManager,
	type ExposureLimits,
	type ExposureState,
	type ExposureValidationResult,
	type PositionData,
	type OrderData,
} from './ExposureManager';
