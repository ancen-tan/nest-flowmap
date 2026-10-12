import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Put, Res, UseGuards, Version } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtGuard } from './auth';
import { CreateOrderDto, UpdateOrderDto } from './order.dto';
import { OrderService } from './order.service';

const EXPORT_PATH = 'export';

@Controller('orders')
@UseGuards(JwtGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  create(@Headers('idempotency-key') key: string, @Body() dto: CreateOrderDto) {
    return this.orderService.create(dto);
  }

  @Put(':id')
  @Version('2')
  @ApiOkResponse()
  @ApiNotFoundResponse()
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOrderDto) {
    return this.orderService.update(id, dto);
  }

  @Get(EXPORT_PATH)
  export(@Res() res: Response) {
    if (!res.headersSent) {
      return res.status(200).send('id,status');
    }
    res.redirect('/api/orders');
  }
}
