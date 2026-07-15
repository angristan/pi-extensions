/**
 * Shared palette + path helpers for better-native-pi. Raw ANSI is intentional
 * so the look is identical across terminal themes.
 */

import { homedir } from "node:os";

export const CYAN = "\x1b[36m";
export const MAGENTA = "\x1b[35m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const BOLD = "\x1b[1m";
/** Slightly subdued tone for secondary text (e.g. the reasoning headline).
 *  Intentionally a dim attribute rather than a hue, so it stays theme-portable. */
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";


export function nonEmptyLineCount(s: string): number {
	return s.trim().split("\n").filter(Boolean).length;
}
const HOME = homedir();
/** Collapse the home prefix to ~ for readability. */
export function shortPath(p: string): string {
	if (!p) return "";
	return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}
