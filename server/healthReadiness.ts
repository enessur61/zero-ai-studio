export type HealthReadinessStage =
  | 'not_configured'
  | 'database'
  | 'authentication'
  | 'resource_guard'
  | 'ready';

export interface HealthReadiness {
  database: 'ready' | 'unavailable' | 'not_checked';
  authentication: 'ready' | 'unavailable' | 'not_checked' | 'not_configured';
  resourceGuard: 'ready' | 'unavailable' | 'not_checked';
}

/**
 * Report the last completed readiness boundary without claiming later stages
 * are healthy when an earlier initialization step failed.
 */
export function readinessForStage(stage: HealthReadinessStage): HealthReadiness {
  switch (stage) {
    case 'not_configured':
      return {
        database: 'not_checked',
        authentication: 'not_configured',
        resourceGuard: 'not_checked',
      };
    case 'database':
      return {
        database: 'unavailable',
        authentication: 'not_checked',
        resourceGuard: 'not_checked',
      };
    case 'authentication':
      return {
        database: 'ready',
        authentication: 'unavailable',
        resourceGuard: 'not_checked',
      };
    case 'resource_guard':
      return {
        database: 'ready',
        authentication: 'ready',
        resourceGuard: 'unavailable',
      };
    case 'ready':
      return {
        database: 'ready',
        authentication: 'ready',
        resourceGuard: 'ready',
      };
  }
}
