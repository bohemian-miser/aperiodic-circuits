/** Class colours: well-separated hues, stable per class id. */
export function classColor(c: number): string {
  const hue = (c * 137.508 + 200) % 360;
  const light = c % 2 === 0 ? 46 : 38;
  return `hsl(${hue.toFixed(0)} 70% ${light}%)`;
}

/** Circuit colours: one hue per distinct circuit length, in length order. */
export function lengthHue(rank: number): string {
  return `hsl(${((rank * 47) % 360).toFixed(0)} 80% 45%)`;
}

// Mid blue-grey: readable on both the light and the dark canvas.
export const OPEN_COLOR = '#6f86b0';
export const TAIL_COLOR = '#e5484d';

/** Red through violet, t in [0, 1]. */
export function rainbow(t: number): string {
  return `hsl(${(t * 290).toFixed(0)} 85% 55%)`;
}
