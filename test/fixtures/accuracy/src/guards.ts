import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IS_PUBLIC_KEY } from './decorators';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }
    const req = context.switchToHttp().getRequest();
    if (!req.session?.user) {
      throw new UnauthorizedException('Not logged in');
    }
    return true;
  }
}

@Injectable()
export class CallbackAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header: string = context.switchToHttp().getRequest().headers.authorization ?? '';
    if (!header.startsWith('Basic ')) {
      throw new UnauthorizedException('Missing credentials');
    }
    return true;
  }
}

@Injectable()
export class LimitedThrottlerGuard extends ThrottlerGuard {}
