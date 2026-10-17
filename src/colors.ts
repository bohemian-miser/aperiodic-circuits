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

export type Rgb = readonly [number, number, number];

const parsed = new Map<string, Rgb>();

/** Read one of our colours (`hsl(h s% l%)` or `#rrggbb`) as RGB, 0–255. */
export function toRgb(c: string): Rgb {
  const hit = parsed.get(c);
  if (hit) return hit;
  let out: Rgb = [128, 128, 128];
  const m = /^hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(c);
  if (m) {
    const h = Number(m[1]);
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    out = [f(0), f(8), f(4)];
  } else if (/^#[0-9a-f]{6}$/i.test(c)) out = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as unknown as Rgb;
  parsed.set(c, out);
  return out;
}

/** Part way from colour `a` to `b`: the colour a cross-fade of the two shows. */
export function mixColor(a: Rgb, b: Rgb, u: number): string {
  const c = (i: number) => Math.round(a[i] + (b[i] - a[i]) * u);
  return `rgb(${c(0)} ${c(1)} ${c(2)})`;
}
