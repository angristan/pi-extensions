export const CHAT_WIDTH = 11;
export const CHAT_HEIGHT = 3;

export const PETIT_CHAT_POSES = [
	[
		"  ⡠⣒⠄  ⡔⢄⠔⡄",
		" ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣",
		"  ⠉⠒⠣⠤⠵⠤⠬⠮⠆",
	],
	[
		"  ⡠⣒⠄  ⡔⢄⠔⡄",
		" ⢸⠸⣀⡔⠉⠑⣃⡢⣂⡣",
		"  ⠉⠒⠣⠤⠵⠤⠬⠮⠆",
	],
	[
		"  ⡠⣒⠄  ⡔⢄⠢⡄",
		" ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣",
		"  ⠉⠒⠣⠤⠵⠤⠬⠮⠆",
	],
	[
		"  ⡠⣒⠂  ⡔⢄⠔⡄",
		" ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣",
		"  ⠉⠒⠣⠤⠵⠤⠬⠮⠆",
	],
	[
		"  ⡠⣒⠄  ⡔⢄⠔⡄",
		" ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡱",
		"  ⠉⠒⠣⠤⠵⠤⠬⠮⠆",
	],
] as const;

// Return to the neutral pose between short blinks, ear twitches, and tail movements.
export const PETIT_CHAT_FRAME_SEQUENCE = [
	0, 1, 0, 0, 2, 2, 0, 3, 3, 0, 4, 4, 0,
] as const;

export function getPetitChatPose(frameIndex: number): readonly string[] {
	const normalized = ((Math.trunc(frameIndex) % PETIT_CHAT_FRAME_SEQUENCE.length)
		+ PETIT_CHAT_FRAME_SEQUENCE.length) % PETIT_CHAT_FRAME_SEQUENCE.length;
	return PETIT_CHAT_POSES[PETIT_CHAT_FRAME_SEQUENCE[normalized]!]!;
}
