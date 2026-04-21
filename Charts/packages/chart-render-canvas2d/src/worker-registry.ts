export type WorkerFactory = () => Worker | null;

type WorkerRegistry = {
  lod: WorkerFactory | null;
  series: WorkerFactory | null;
};

const registry: WorkerRegistry = {
  lod: null,
  series: null,
};

export const registerWorkerFactories = (factories: Partial<WorkerRegistry>): void => {
  if ('lod' in factories) {
    registry.lod = factories.lod ?? null;
  }
  if ('series' in factories) {
    registry.series = factories.series ?? null;
  }
};

export const getLodWorkerFactory = (): WorkerFactory | null => registry.lod;

export const getSeriesWorkerFactory = (): WorkerFactory | null => registry.series;
