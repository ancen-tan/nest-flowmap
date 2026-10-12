import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: 'x' });
  }

  async validate(payload: { sub: string; revoked?: boolean }) {
    if (payload.revoked) {
      throw new UnauthorizedException('Token revoked');
    }
    return { id: payload.sub };
  }
}

@Injectable()
export class JwtGuard extends AuthGuard('jwt') {}
