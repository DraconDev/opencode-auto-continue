/**
 * Planning State — plan detection and timeout tracking.
 */

export interface PlanningState {
  planning: boolean;
  planBuffer: string;
  planningStartedAt: number;
}

export function createPlanningDefaults(): PlanningState {
  return {
    planning: false,
    planBuffer: '',
    planningStartedAt: 0,
  };
}