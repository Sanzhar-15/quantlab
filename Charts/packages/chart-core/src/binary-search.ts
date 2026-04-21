export function lowerBound(values: ArrayLike<number>, length: number, target: number): number {
  let left = 0;
  let right = length;
  while (left < right) {
    const mid = (left + right) >> 1;
    const midValue = values[mid]!;
    if (midValue < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

export function upperBound(values: ArrayLike<number>, length: number, target: number): number {
  let left = 0;
  let right = length;
  while (left < right) {
    const mid = (left + right) >> 1;
    const midValue = values[mid]!;
    if (midValue <= target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}
