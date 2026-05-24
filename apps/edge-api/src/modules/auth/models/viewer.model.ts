import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Workspace } from './workspace.model';

@ObjectType()
export class Viewer {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;

  @Field(() => [Workspace])
  workspaces!: Workspace[];
}
