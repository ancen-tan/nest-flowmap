import { IntersectionType } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  Allow, Equals, IsDateString, IsEmail, IsEmpty, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
  ValidateIf,
} from 'class-validator';

export enum Level {
  LOW = 'low',
  HIGH = 'high',
}

export const KINDS = ['a', 'b'] as const;
export const MAX_COUNT = 50;

export class NameDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class ContactDto {
  @IsEmail()
  email: string;
}

export class CreateItemDto extends IntersectionType(NameDto, ContactDto) {
  @Expose({ name: 'external_id' })
  @IsUUID('4')
  externalId: string;

  @IsIn(KINDS)
  kind: string;

  @IsIn(['x', 'y'], { message: 'tag must be x or y' })
  tag: string;

  @IsInt()
  @Min(5, { message: 'count is too small' })
  @Max(MAX_COUNT)
  count: number;

  @ValidateIf((o) => !!o.endDate)
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @Matches(/^[a-z]+$/i)
  code: string;

  @IsEmpty()
  type?: string;

  @Allow()
  hint?: string;

  @IsString()
  @IsNotEmpty()
  title: string | null;

  @IsEnum(Level)
  level: Level;

  @IsOptional()
  memo?: string;

  internal?: boolean;

  @IsNumberString()
  @Length(6, 6)
  otp: string;

  @Matches(/^\d{4}$/)
  pin: string;

  @Matches(/^[a-z/,]+$/)
  slug: string;

  @IsIn([1_000, 2_000])
  amount: number;

  @Equals(-0x10)
  offset: number;
}

export class PageDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ChildPageDto extends PageDto {
  @Max(100)
  limit?: number;
}
