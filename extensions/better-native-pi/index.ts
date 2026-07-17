/**
 * Dependency graph:
 * Direct: `./bash.js`, `./exploration.js`, `./file-tools.js`,
 *   `@earendil-works/pi-coding-agent`.
 * Used by: `Pi extension loader`.
 */
/**
 * better-native-pi — restyles pi's native tools (read/write/edit/grep/find/ls/bash)
 * into compact, reason-first 2-line transcript blocks, and groups consecutive
 * read/list/search calls into a single "exploring" block.
 *
 * This is the entry point: it composes the three feature factories so they load
 * as a single pi extension (one /reload unit). Each factory registers its own
 * tools/hooks against the shared `pi` instance.
 *
 *   index.ts       ← composes factories (this file)
 *   core.ts        ← shared primitives (no pi.* calls, pure lib)
 *   render.ts      ← palette + shortPath
 *   file-tools.ts  ← read/write/edit/grep/find/ls restylers
 *   bash.ts        ← bash restyler + bounded output
 *   exploration.ts ← groups consecutive read/list/search calls
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fileTools from "./file-tools.js";
import bash from "./bash.js";
import exploration from "./exploration.js";

export default function betterNativePi(pi: ExtensionAPI) {
	fileTools(pi);
	bash(pi);
	exploration(pi);
}
