import { Process, Processor } from '@nestjs/bull';
import { QUEUE_JOB_NAMES, QUEUE_NAMES as Q, Queues } from './queue.constant';

@Processor(Q.AUDIT)
export class AuditJobs {
  @Process(QUEUE_JOB_NAMES.AUDIT.RECORD)
  async record() {
    return;
  }
}

@Processor({ name: Queues.REPORTS })
export class ReportJobs {
  async process() {
    return;
  }
}
