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
import { normalizeToolReasoningInput } from "./core.js";

export default function betterNativePi(pi: ExtensionAPI) {
	// Keep every extension's reason grammatically consistent, including custom
	// tools that use Pi's fallback renderer instead of better-native-pi blocks.
	pi.on("tool_call", (event) => normalizeToolReasoningInput(event.input));
	fileTools(pi);
	bash(pi);
	exploration(pi);
}
