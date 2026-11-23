import { z } from 'zod';
import { failure, tasks } from './qa-contract.js';
import { windowTargetSchema } from './window-target.js';

export const windowSessionPath = '/api/window-sessions';
export const windowSessionTaskPath = windowSessionPath + '/current/tasks/';
export const windowSessionRunTasks = Object.freeze(['qa_observe', 'qa_act', 'qa_check', 'qa_finish', 'qa_replay', 'qa_report']);
export const windowSessionHeartbeat = 'qa_heartbeat';
export const windowSessionHeartbeatMs = 5000;
export const windowSessionCleanupErrors = Object.freeze(['fixture_cleanup_failed', 'fixture_cleanup_uncertain', 'release_unconfirmed']);
export function windowSessionFailure(error, operation) {
  return windowSessionCleanupErrors.includes(error.message)
    ? { code: error.message, category: 'uncertain', retrySafe: false,
      nextAction: 'Cleanup was not confirmed. Do not start another fixture to retry. Review the recordings and ask the Mac operator to verify.' }
    : failure(error, operation);
}

export const windowSessionStart = tasks.qa_start.omit({ resumeRunId: true }).extend({
  managedFixture: z.literal(true).optional(),
  target: windowTargetSchema.optional(),
  processStartedAt: z.number().finite().optional(),
}).refine(input => input.managedFixture
  ? input.target === undefined && input.processStartedAt === undefined
  : input.target !== undefined && input.processStartedAt !== undefined,
{ message: 'Pass managedFixture:true or both target and processStartedAt.' });
