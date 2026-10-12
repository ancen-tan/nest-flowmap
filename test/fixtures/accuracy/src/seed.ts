import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// A seed script: creates an app context but never listens, so it is not the HTTP app.
async function seed() {
  const app = await NestFactory.create(AppModule);
  await app.close();
}
seed();
