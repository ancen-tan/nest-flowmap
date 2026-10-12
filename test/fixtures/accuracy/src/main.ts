import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setup } from './setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(process.env.API_PREFIX ?? 'api', { exclude: ['health'] });
  setup(app);
  await app.listen(3000);
}
bootstrap();
