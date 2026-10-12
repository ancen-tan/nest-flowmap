import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class AMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    next();
  }
}

@Injectable()
export class BMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    next();
  }
}

@Injectable()
export class CMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    next();
  }
}
