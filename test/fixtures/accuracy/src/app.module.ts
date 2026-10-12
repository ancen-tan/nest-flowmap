import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemRepository, ItemsService, SqlItemRepository } from './items.service';
import { CallbacksController, DogsController, HealthController, LimitedController, ThingsController } from './other.controllers';
import { AMiddleware, BMiddleware, CMiddleware } from './middleware';
import { QuotaController, StrictController } from './more.controllers';
import {
  CanonicalController, ClassMetaController, ExtrasModule, PackagePublicController, ReviewController, ScenarioController, SecondDogsController,
} from './review';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProviderInterceptor } from './interceptors';

@Module({
  imports: [ExtrasModule],
  controllers: [ReviewController, ClassMetaController, PackagePublicController, ScenarioController, CanonicalController, SecondDogsController, ItemsController, HealthController, ThingsController, CallbacksController, LimitedController, DogsController, QuotaController, StrictController],
  providers: [ItemsService, { provide: ItemRepository, useClass: SqlItemRepository }, { provide: APP_INTERCEPTOR, useClass: ProviderInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AMiddleware).forRoutes('dogs').apply(BMiddleware).forRoutes('items');
    consumer.apply(CMiddleware).exclude('items').forRoutes('*');
  }
}
