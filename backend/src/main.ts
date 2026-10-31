import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadSecretsFromVault } from './vault/vault-bootstrap';
import { PublicApiModule } from './public-api/public-api.module';

async function bootstrap() {
  await loadSecretsFromVault();

  const app = await NestFactory.create(AppModule);

  // Allow requests from:
  //   - http://localhost:5173  → local dev mode (npm run dev, outside Docker)
  //   - https://localhost      → production via Nginx on port 443
  //   - https://localhost:8443 → production on rootless Docker (alternative port)
  app.enableCors({
    origin: [
      'http://localhost:5173',
      'https://localhost',
      'https://localhost:8443',
    ],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // Removes properties not defined in the DTO
      forbidNonWhitelisted: true,   // Rejects requests with non-allowed properties
      transform: true,              // Converts data to the expected types/classes
    }),
  );

  // Swagger for the Public Admin API.
  // The page itself is public (no middleware guard) so the browser can load it.
  // The "Authorize" button in the UI lets the evaluator enter the X-API-Key,
  // and every request made from the Swagger UI will then include that header.
  // All actual endpoints are still protected by AdminApiKeyGuard.
  const config = new DocumentBuilder()
    .setTitle('Transcendence Public Admin API')
    .setDescription(
      'Public administrative API for managing users, forum content and moderation.',
    )
    .setVersion('1.0')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      },
      'admin-api-key',
    )
    .build();

  // Creates the Swagger document using the NestJS app, the OpenAPI configuration,
  // and only the controllers belonging to PublicApiModule
  const document = SwaggerModule.createDocument(app, config, {
    include: [PublicApiModule],
  });

  SwaggerModule.setup('api/admin/docs', app, document);

  await app.listen(8000);
}
bootstrap();