import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';

export class DomainError extends Error {}
export class QuotaError extends DomainError {}

@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(422).json({ message: exception.message });
  }
}
