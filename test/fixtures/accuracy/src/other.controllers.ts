import { Controller, Get, Headers, Post, UseGuards, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { CallbackAuthGuard, LimitedThrottlerGuard } from './guards';
import { DomainException } from './exceptions';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  check() {
    return 'ok';
  }
}

@Controller('things')
@Version('2')
export class ThingsController {
  @Get()
  list() {
    return [];
  }
}

@UseGuards(CallbackAuthGuard)
export class BaseCallbackController {
  @Get('legacy')
  legacy() {
    return 1;
  }
}

@Controller('callbacks')
export class CallbacksController extends BaseCallbackController {
  legacy() {
    return 2;
  }

  @Post()
  receive(@Headers('x-idempotency-key') key?: string) {
    if (key === 'used') {
      throw new DomainException('Already processed');
    }
    return { key };
  }
}

@Controller('limited')
@UseGuards(LimitedThrottlerGuard)
export class LimitedController {
  @Get()
  get() {
    return 1;
  }
}

@Controller('dogs')
export class DogsController {
  @Get()
  list() {
    return [];
  }
}
