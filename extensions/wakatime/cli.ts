/**
 * Dependency graph:
 * Direct: `node:fs`, `node:path`.
 * Used by: `extensions/wakatime/cli.test.ts`, `extensions/wakatime/index.ts`.
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

function pathDelimiter(platform: NodeJS.Platform): string {
	return platform === "win32" ? ";" : ":";
}

export function executableNames(
	name: string,
	platform: NodeJS.Platform,
	pathExt = ".COM;.EXE;.BAT;.CMD",
): string[] {
	if (platform !== "win32") return [name];
	if (/\.[^\\/]+$/.test(name)) return [name];
	return pathExt
		.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean)
		.map((extension) => `${name}${extension}`);
}

export function findExecutableOnPath(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const pathValue = env.PATH;
	if (!pathValue) return undefined;

	const names = executableNames(name, platform, env.PATHEXT);
	for (const rawDirectory of pathValue.split(pathDelimiter(platform))) {
		const directory = rawDirectory.trim().replace(/^"|"$/g, "");
		if (!directory) continue;

		for (const executable of names) {
			const candidate = join(directory, executable);
			try {
				if (!statSync(candidate).isFile()) continue;
				if (platform !== "win32") accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Keep searching PATH entries.
			}
		}
	}

	return undefined;
}

export function findWakatimeCli(): string | undefined {
	return findExecutableOnPath("wakatime-cli");
}
