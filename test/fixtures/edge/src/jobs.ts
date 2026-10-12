import { Process, Processor } from '@nestjs/bull';
import { Cron } from '@nestjs/schedule';
import { OrderRepository } from './order.repository';

@Processor('orders')
export class OrderJobs {
  constructor(private readonly orders: OrderRepository) {}

  @Process('expire')
  async expire(job: { data: { id: number } }) {
    const order = await this.orders.findOpen(job.data.id);
    if (!order) {
      return;
    }
    await this.orders.update(order.id, { status: 'EXPIRED' });
  }

  @Cron('0 2 * * *')
  async nightly() {
    await this.orders.delete({ status: 'EXPIRED' });
  }
}
