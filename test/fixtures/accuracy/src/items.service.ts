import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DomainException } from './exceptions';

export abstract class ItemRepository {
  abstract findById(id: string): Promise<{ id: string } | null>;
}

@Injectable()
export class SqlItemRepository extends ItemRepository {
  async findById(id: string) {
    if (id === 'broken') {
      throw new Error('Storage is broken');
    }
    return { id };
  }
}

export abstract class BaseService {
  async create(dto: { taken?: boolean }) {
    await this.validate(dto);
    return dto;
  }

  protected async validate(dto: { taken?: boolean }): Promise<void> {}
}

@Injectable()
export class ItemsService extends BaseService {
  constructor(private readonly repo: ItemRepository) {
    super();
  }

  protected async validate(dto: { taken?: boolean }): Promise<void> {
    if (dto.taken) {
      throw new DomainException('Item already exists');
    }
  }

  async rethrow(id: string) {
    try {
      return await this.findOrFail(id);
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async findOrFail(id: string) {
    const item = await this.repo.findById(id);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    if (item.id === 'locked') {
      throw new ForbiddenException('Item is locked');
    }
    return item;
  }

  async find(id: string) {
    return this.repo.findById(id);
  }

  async danger(): Promise<number> {
    throw new ForbiddenException('Dangerous');
  }

  async safe(): Promise<number> {
    return 1;
  }
}
