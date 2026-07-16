import { homedir } from "node:os";
import { join } from "node:path";

function configuredWakatimeHome(): string | undefined {
	const value = process.env.WAKATIME_HOME?.trim();
	if (!value) return undefined;
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function getWakatimeResourcesDir(): string {
	return configuredWakatimeHome() ?? join(homedir(), ".wakatime");
}
