import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrderRepository extends Repository<Order> {
  constructor(dataSource: DataSource) {
    super(Order, dataSource.createEntityManager());
  }

  async findOpen(id: number): Promise<Order | null> {
    return this.findOne({ where: { id, status: 'OPEN' } });
  }
}
