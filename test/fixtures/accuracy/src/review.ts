// Cases found by the second review round.
import {
  All, BadRequestException, CanActivate, Controller, ExecutionContext, Get, HttpException, HttpStatus, Injectable, Module, NotFoundException,
  Param, Post, Redirect, SetMetadata, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { S3Client } from '@aws-sdk/client-s3';
import { Public as PackagePublic } from 'some-auth-library';
import { IS_PUBLIC_KEY } from './decorators';
import { SessionGuard } from './guards';

// Two super() calls, chosen by the shape of the message argument.
export class KeyedException extends HttpException {
  constructor(code: string, msg: string | { key: string }, status: HttpStatus) {
    if (typeof msg === 'object' && 'key' in msg) {
      super(msg.key, status);
    } else {
      super(msg, status);
    }
  }
}

export class SpreadException extends HttpException {
  constructor(...args: [string, number]) {
    super(...args);
  }
}

@Injectable()
export class HandlerOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.get<boolean>(IS_PUBLIC_KEY, context.getHandler());
    if (isPublic) {
      return true;
    }
    if (!context.switchToHttp().getRequest().headers.authorization) {
      throw new UnauthorizedException('No token');
    }
    return true;
  }
}

@Injectable()
export class SessionPolicy {
  async verify(req: { headers: Record<string, string> }) {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token required');
    }
  }

  async check(session: { method: string }) {
    if (session.method === 'password') {
      throw new BadRequestException('Password sessions cannot do this');
    }
  }
}

@Injectable()
export class TokenGuard implements CanActivate {
  constructor(private readonly policy: SessionPolicy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    await this.policy.verify(req);
    await this.policy.check(req.session);
    return true;
  }
}

@Injectable()
export class CanonicalJwtGuard extends AuthGuard('jwt') {
  handleRequest(err: unknown, user: unknown) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid token');
    }
    return user;
  }
}

@Injectable()
export class ReviewService {
  private readonly s3Client: S3Client = new S3Client({});

  async inner(id: string) {
    try {
      return await this.load(id);
    } catch (e) {
      throw e;
    }
  }

  async outer(id: string) {
    try {
      return await this.inner(id);
    } catch (e) {
      throw e;
    }
  }

  async load(id: string): Promise<string> {
    return this.s3Client.send(id as any) as any;
  }

  async loadOrBad(id: string) {
    try {
      return await this.findOrFail(id);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new BadRequestException('Bad load');
    }
  }

  async findOrFail(id: string) {
    const found = await this.load(id);
    if (!found) {
      throw new NotFoundException('Nothing here');
    }
    if (found === 'x') {
      throw new BadRequestException('Unusable');
    }
    return found;
  }

  async build(key: string) {
    if (!key) throw new BadRequestException('No key');
    return key;
  }

  async upload() {
    return await this.s3Client.send(await this.build('x'));
  }
}

@Controller('review')
export class ReviewController {
  constructor(private readonly svc: ReviewService) {}

  @Post('keyed')
  keyed() {
    if (Math.random() > 0.5) throw new KeyedException('A', 'Plain message', HttpStatus.CONFLICT);
    throw new KeyedException('B', { key: 'errors.translated' }, HttpStatus.CONFLICT);
  }

  @Post('spread')
  spread() {
    throw new SpreadException('Too much', 422);
  }

  @Get('nested')
  nested() {
    return this.svc.outer('a');
  }

  @Get('swallow/:id')
  async swallow(@Param('id') id: string) {
    try {
      await this.svc.loadOrBad('a');
    } catch {}
    return this.svc.loadOrBad(id);
  }

  @Get('stacked/:k')
  stacked(@Param('k') k: string) {
    switch (k) {
      case 'a':
        this.svc.build(k);
      case 'b':
      case 'c':
        return this.svc.load(k);
    }
    return 0;
  }

  @Get('break/:k')
  brk(@Param('k') k: string) {
    switch (k) {
      case 'a':
        if (k.length > 3) break;
        console.log(k);
      case 'b':
        throw new NotFoundException('b');
      default:
        return 2;
    }
    return 3;
  }

  @Get('upload')
  upload() {
    return this.svc.upload();
  }

  @Get('go')
  @Redirect()
  go() {
    return { url: 'https://example.com', statusCode: HttpStatus.PERMANENT_REDIRECT };
  }

  @All('any')
  any() {
    return 1;
  }
}

@Controller('classmeta')
@SetMetadata(IS_PUBLIC_KEY, true)
@UseGuards(HandlerOnlyGuard)
export class ClassMetaController {
  @Get()
  get() {
    return 1;
  }
}

@Controller('pkgpublic')
@UseGuards(SessionGuard)
export class PackagePublicController {
  @Get()
  @PackagePublic()
  get() {
    return 1;
  }
}

@Controller('scenario')
@UseGuards(TokenGuard)
export class ScenarioController {
  @Post('note')
  note() {
    return 1;
  }
}

@Controller('canonical')
@UseGuards(CanonicalJwtGuard)
export class CanonicalController {
  @Get()
  get() {
    return 1;
  }
}

@Controller('dogs')
export class SecondDogsController {
  @Get()
  other() {
    return [];
  }
}

@Controller('prodonly')
export class ProdOnlyController {
  @Get()
  get() {
    return 1;
  }
}

@Module({ controllers: [ProdOnlyController] })
export class ProdOnlyModule {}

const extras = process.env.NODE_ENV === 'test' ? [] : [ProdOnlyModule];

@Module({ imports: [...extras] })
export class ExtrasModule {}
