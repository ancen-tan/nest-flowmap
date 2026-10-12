import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { SessionGuard } from './guards';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export function UseSessionGuard() {
  return applyDecorators(SetMetadata('session', 'login'), UseGuards(SessionGuard));
}
