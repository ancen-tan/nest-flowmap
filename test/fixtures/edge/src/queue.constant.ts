// No `as const`: the values are typed as plain `string`, so the names come from the initializers.
export const QUEUE_NAMES = {
  AUDIT: 'audit',
};

export const QUEUE_JOB_NAMES = {
  AUDIT: { RECORD: 'record' },
};

export enum Queues {
  REPORTS = 'reports',
}
