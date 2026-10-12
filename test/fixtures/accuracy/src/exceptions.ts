import { HttpException, HttpStatus } from '@nestjs/common';

export class BaseException extends HttpException {
  constructor(code: string, message: string, status: HttpStatus) {
    super({ code, message }, status);
  }
}

export class DomainException extends BaseException {
  constructor(message: string) {
    super('DOMAIN', message, HttpStatus.CONFLICT);
  }
}

/** Shares its name with Nest's built-in; code that imports '@nestjs/common' must not get this one. */
export class NotFoundException extends BaseException {
  constructor(message: string) {
    super('NOT_FOUND', message, HttpStatus.GONE);
  }
}
