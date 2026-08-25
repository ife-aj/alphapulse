import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Every route lives under /api (e.g. GET /api/health).
  app.setGlobalPrefix('api');

  // Validate and sanitize every incoming request against its DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // drop properties not declared on the DTO
      forbidNonWhitelisted: true, // 400 if unknown properties are sent
      transform: true, // turn plain payloads into typed DTO instances
    }),
  );

  const configService = app.get(ConfigService);
  const port = configService.get<string>('PORT') ?? '3000';
  await app.listen(port);
}
bootstrap();
