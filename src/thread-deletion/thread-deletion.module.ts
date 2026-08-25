import { Module } from '@nestjs/common';
import { ThreadDeletionRegistryService } from './thread-deletion-registry.service';

@Module({
  providers: [ThreadDeletionRegistryService],
  exports: [ThreadDeletionRegistryService],
})
export class ThreadDeletionModule {}
