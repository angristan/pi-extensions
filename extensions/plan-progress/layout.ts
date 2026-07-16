export const PLAN_OVERLAY_LAYOUT_EVENT = "plan-progress:overlay-layout";
export const PLAN_OVERLAY_LAYOUT_REQUEST_EVENT = "plan-progress:overlay-layout-request";

export interface PlanOverlayLayout {
	visible: boolean;
	height: number;
}

export function parsePlanOverlayLayout(value: unknown): PlanOverlayLayout | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<PlanOverlayLayout>;
	if (typeof candidate.visible !== "boolean") return undefined;
	if (typeof candidate.height !== "number" || !Number.isFinite(candidate.height) || candidate.height < 0) return undefined;
	return { visible: candidate.visible, height: Math.floor(candidate.height) };
}
