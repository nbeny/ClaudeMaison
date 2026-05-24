import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { loadEnv, type Env } from './config/env';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { OidcModule } from './modules/auth/oidc/oidc.module';
import { BillingModule } from './modules/billing/billing.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: loadEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: { singleLine: true, colorize: true },
              }
            : undefined,
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.token',
            '*.password',
            '*.token',
          ],
          remove: true,
        },
      },
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    GatewayModule,
    AuthModule,
    // Module OIDC conditionnel : forRoot lit l'env directement pour décider
    // de l'enregistrement. L'env a déjà été validé par ConfigModule au-dessus
    // (même schema Zod), donc loadEnv ici ne fait que re-parser sans I/O.
    OidcModule.forRoot(new ConfigService<Env, true>(loadEnv(process.env))),
    BillingModule,
  ],
})
export class AppModule {}
