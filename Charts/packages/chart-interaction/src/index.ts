export { GestureEngine, type GestureState, type GestureResult, type GestureEngineOptions } from './gesture-engine';
export {
  createInputState,
  normalizeMouseEvent,
  normalizeWheelEvent,
  normalizeTouchEvent,
  normalizePointerEvent,
  getCoalescedEvents,
  mergeInputStates,
  type InputState,
} from './input-state';
export {
  createInertialPanState,
  updateInertialPan,
  addInertialVelocity,
  startInertialPan,
  stopInertialPan,
  clampInertialPan,
  type InertialPanState,
  type InertialPanOptions,
} from './physics';
export { SpatialIndex, type Drawing, type Point } from './spatial-index';
export {
  hitTestSeries,
  hitTestDrawings,
  HitTestingManager,
  type SeriesHitResult,
  type DrawingHitResult,
  type HitTestOptions,
} from './hit-testing';

