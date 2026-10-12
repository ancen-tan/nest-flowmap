import {
  BadGatewayException, BadRequestException, Body, Controller, Get, HttpStatus, NotFoundException, Param, ParseIntPipe, Post, Query,
  Redirect, Res, UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { catchError, firstValueFrom } from 'rxjs';
import { Public, UseSessionGuard } from './decorators';
import { ChildPageDto, CreateItemDto } from './dto';
import { ItemsService } from './items.service';

@Controller('items')
@UseSessionGuard()
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly http: HttpService,
  ) {}

  @Post()
  create(@Body() dto: CreateItemDto) {
    return this.items.create(dto);
  }

  @Get()
  list(@Query() query: ChildPageDto) {
    return [];
  }

  @Get('public')
  @Public()
  publicList() {
    return [];
  }

  @Get('parse')
  parse(@Query('raw') raw: string) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Body is not JSON');
    }
    return data;
  }

  @Get('rethrow/:id')
  rethrow(@Param('id') id: string) {
    return this.items.rethrow(id);
  }

  @Get('callback/:id')
  async callback(@Param('id') id: string) {
    const item = await this.items.find(id).catch(() => {
      throw new NotFoundException('Lookup failed');
    });
    return item;
  }

  @Get('cond')
  async cond(@Query('d') d: string) {
    const r = d ? await this.items.danger() : await this.items.safe();
    return r;
  }

  @Get('redir')
  @Redirect('https://nestjs.com', 301)
  redir() {}

  @Get('switch/:k')
  sw(@Param('k') k: string) {
    switch (k) {
      case 'a':
        console.log('a');
      case 'b':
        throw new NotFoundException('Falls through to b');
      default:
        return 1;
    }
  }

  @Get('helper')
  helper() {
    throw this.invalid();
  }

  private invalid() {
    return new UnprocessableEntityException('Invalid input');
  }

  @Get('passthrough')
  pass(@Res({ passthrough: true }) res: any) {
    res.status(HttpStatus.PRECONDITION_REQUIRED);
    return { next: 'otp' };
  }

  @Get('loop')
  loop(@Query('ids') ids: string[]) {
    for (const id of ids) {
      if (!id) continue;
      throw new BadRequestException('Bad id');
    }
    return 'ok';
  }

  @Get('upstream')
  async upstream() {
    return firstValueFrom(
      this.http.get('https://example.com').pipe(
        catchError(() => {
          throw new BadGatewayException('Upstream failed');
        }),
      ),
    );
  }

  @Get('twice/:id')
  async twice(@Param('id') id: string) {
    try {
      await this.items.findOrFail(id);
    } catch {}
    return this.items.findOrFail(id);
  }

  @Get(':id')
  find(@Param('id', new ParseIntPipe({ exceptionFactory: () => new NotFoundException('Item id not found') })) id: number) {
    return id;
  }
}
