export enum InvalidationFlag {
  None = 0,
  Layout = 1 << 0,
  Series = 1 << 1,
  Overlay = 1 << 2,
  Underlay = 1 << 3,
  All = Layout | Series | Overlay | Underlay,
}

export function mergeInvalidation(a: InvalidationFlag, b: InvalidationFlag): InvalidationFlag {
  return (a | b) as InvalidationFlag;
}

export function hasInvalidation(flags: InvalidationFlag, test: InvalidationFlag): boolean {
  return (flags & test) !== 0;
}
