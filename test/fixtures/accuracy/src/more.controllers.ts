import { All, Controller, ForbiddenException, Get, Injectable, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DomainErrorFilter, QuotaError } from './filters';

@Injectable()
export class StrictJwtGuard extends AuthGuard('jwt') {
  handleRequest(err: unknown, user: unknown) {
    if (err || !user) {
      throw new ForbiddenException('Token rejected');
    }
    return user;
  }
}

@Controller('quota')
@UseFilters(DomainErrorFilter)
export class QuotaController {
  @Post()
  use() {
    throw new QuotaError('Quota used up');
  }

  @All('any')
  any() {
    return 1;
  }
}

@Controller('strict')
@UseGuards(StrictJwtGuard)
export class StrictController {
  @Get()
  get() {
    return 1;
  }
}
