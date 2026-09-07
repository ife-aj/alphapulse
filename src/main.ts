import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Bind the Socket.IO gateway to the same HTTP server and port as the REST
  // API. No CORS is enabled anywhere, consistent with the HTTP policy below:
  // the socket only serves same-origin / non-browser clients.
  app.useWebSocketAdapter(new IoAdapter(app));

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

  const configService = app.get(ConfigService);
  const port = configService.get<string>('PORT') ?? '3000';
  await app.listen(port);
}
bootstrap();
