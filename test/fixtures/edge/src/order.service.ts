import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Notifier } from './notifier';
import { CreateOrderDto, UpdateOrderDto } from './order.dto';
import { Order } from './order.entity';
import { OrderRepository } from './order.repository';

export class OutOfStockError extends HttpException {
  constructor(itemId: number) {
    super(`Item ${itemId} is out of stock`, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly dataSource: DataSource,
    @Inject('NOTIFIER') private readonly notifier: Notifier,
    private readonly maxItems: number,
  ) {}

  async create(dto: CreateOrderDto): Promise<Order> {
    for (const itemId of dto.itemIds) {
      if (itemId < 0) {
        throw new OutOfStockError(itemId);
      }
    }
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const order = await queryRunner.manager.save(Order, { status: 'OPEN' });
      await queryRunner.commitTransaction();
      await this.notifier.notify(order.id);
      return order;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async update(id: number, dto: UpdateOrderDto): Promise<Order> {
    const order = await this.orders.findOpen(id);
    if (!order) {
      throw new NotFoundException();
    }
    await Promise.all(dto.itemIds.map(async (itemId) => this.reserve(itemId, 3)));
    return this.orders.save({ ...order, ...dto });
  }

  private async reserve(itemId: number, attempts: number): Promise<void> {
    const rows = await this.dataSource.query('SELECT 1 FROM stock WHERE item_id = $1 FOR UPDATE', [itemId]);
    if (!rows.length && attempts > 0) {
      await this.reserve(itemId, attempts - 1);
    }
  }
}
