import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';
import { RegisterCredentialsDto } from './dto/register-credentials.dto';
import {
  AuthResultDto,
  AuthUserDto,
  MeResultDto,
} from './dto/auth-response.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Signs the user up with Supabase Auth from `{ email, password, fullName }`. ' +
      '`fullName` is trimmed and stored as `user_metadata.full_name`. When email ' +
      'confirmation is enabled the response is `{ user: null, session: null }` ' +
      'and should be treated as "confirmation email sent" — that body is ' +
      'identical whether the address is new or already registered, so ' +
      'registration never reveals account existence. A `409 Conflict` is ' +
      'returned only when Supabase explicitly reports the email as already ' +
      'registered.',
  })
  @ApiCreatedResponse({
    type: AuthResultDto,
    description:
      'Accepted. When a session was issued, `user` and `session` are present; ' +
      'when email confirmation is required they are both null.',
  })
  @ApiBadRequestResponse({ description: 'Invalid email or password payload.' })
  @ApiConflictResponse({
    description:
      'Only when Supabase explicitly reports the email is already registered ' +
      '(e.g. confirmations partly disabled). Under email confirmation a ' +
      'duplicate returns 201 with `{ user: null, session: null }` instead.',
  })
  register(
    @Body() credentials: RegisterCredentialsDto,
  ): Promise<AuthResultDto> {
    return this.authService.register(credentials);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({
    type: AuthResultDto,
    description: 'Logged in. `user` and `session` are always present.',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  @ApiForbiddenResponse({
    description: 'Email not confirmed yet.',
  })
  @ApiBadRequestResponse({ description: 'Invalid email or password payload.' })
  login(@Body() credentials: AuthCredentialsDto): Promise<AuthResultDto> {
    return this.authService.login(credentials);
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get the authenticated user',
    description:
      'Requires `Authorization: Bearer <access_token>`. Returns the user ' +
      'verified from that token.',
  })
  @ApiOkResponse({ type: MeResultDto })
  @ApiUnauthorizedResponse({
    description:
      'Missing/malformed bearer header, or an invalid/expired token.',
  })
  me(@CurrentUser() user: AuthUserDto): MeResultDto {
    return { user };
  }
}
