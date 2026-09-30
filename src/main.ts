import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CorsIoAdapter, parseAllowedOrigins } from './config/cors';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const origins = parseAllowedOrigins(configService.get('CORS_ORIGINS'));
  app.enableCors({ origin: origins, credentials: false });
  app.useWebSocketAdapter(new CorsIoAdapter(app, origins));
  app.enableShutdownHooks();

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

  // OpenAPI docs at /api/docs (Swagger UI) with bearer-token auth for
  // protected routes such as GET /api/auth/me.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AlphaPulse API')
    .setDescription('Market data and Supabase-backed authentication.')
    .setVersion('0.0.1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  const port = configService.get<string>('PORT') ?? '3000';
  await app.listen(port, '0.0.0.0');
}
bootstrap();
