import { Field, ObjectType } from '@nestjs/graphql';
import { Viewer } from './viewer.model';

@ObjectType()
export class AuthPayload {
  @Field()
  accessToken!: string;

  @Field()
  refreshToken!: string;

  @Field()
  accessTokenExpiresAt!: Date;

  @Field()
  refreshTokenExpiresAt!: Date;

  @Field(() => Viewer)
  viewer!: Viewer;
}
