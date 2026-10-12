import { HttpStatus, INestApplication, VersioningType } from '@nestjs/common';
import { I18nValidationPipe } from 'nestjs-i18n';
import session from 'express-session';
import { BootstrapInterceptor } from './interceptors';

const pipeOptions = { whitelist: true, errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY };

function trace<T>(instance: T): T {
  return instance;
}

export function setup(app: INestApplication) {
  app.use(session({ secret: 'secret' }));
  app.use((req: any, res: any, next: () => void) => {
    if (req.path.startsWith('/api/v1/callbacks')) {
      return next();
    }
    if (req.path.startsWith('/api/v1/review/any/abc')) {
      return res.status(403).json({ message: 'blocked path' });
    }
    if (req.method === 'POST' && !req.headers['x-csrf-token']) {
      return res.status(403).json({ message: 'Invalid CSRF token' });
    }
    next();
  });
  app.useGlobalPipes(trace(new I18nValidationPipe(pipeOptions)));
  app.useGlobalInterceptors(new BootstrapInterceptor());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
