import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

export enum Channel {
  WEB = 'web',
  APP = 'app',
}

export class AddressDto {
  @IsString()
  street: string;

  @IsOptional()
  @Length(5, 5)
  postalCode?: string;
}

export class CreateOrderDto {
  @IsString()
  customer: string;

  @IsEmail()
  contact: string;

  @IsEnum(Channel)
  channel: Channel;

  @IsArray()
  @IsInt({ each: true })
  itemIds: number[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  shipping?: AddressDto;

  @IsOptional()
  @IsString()
  note?: string;

  internalFlag?: boolean;
}

export class UpdateOrderDto extends PartialType(CreateOrderDto) {}
