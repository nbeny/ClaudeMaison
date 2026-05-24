import { Module } from '@nestjs/common';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from './jwt.service';
import { PasswordService } from './password.service';
import { SessionsRepository } from './sessions.repository';
import { UsersRepository } from './users.repository';

@Module({
  providers: [
    AuthResolver,
    AuthService,
    JwtService,
    JwtAuthGuard,
    PasswordService,
    UsersRepository,
    SessionsRepository,
  ],
  exports: [JwtService, JwtAuthGuard],
})
export class AuthModule {}
