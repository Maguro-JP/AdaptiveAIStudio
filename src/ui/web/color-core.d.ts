/** color-core.js の形。素の JS で書いてあるので、型はここで宣言する。 */
export interface Rgb { r: number; g: number; b: number; a: number }
export interface Hsl { h: number; s: number; l: number; a: number }
export interface Found { value: string; start: number; end: number; rgb: Rgb }

export const NAMED: Record<string, string>;
export function parse(input: string): Rgb | undefined;
export function hslToRgb(hsl: Hsl): Rgb;
export function rgbToHsl(rgb: Rgb): Hsl;
export function toHex(rgb: Rgb): string;
export function toRgbString(rgb: Rgb): string;
export function toHslString(rgb: Rgb): string;
export function findColors(text: string, limit?: number): Found[];
export function contrast(a: Rgb, b: Rgb): number;
export function readability(ratio: number): { level: 'good' | 'warn' | 'bad'; label: string };
