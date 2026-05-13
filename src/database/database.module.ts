/** SQLite persistence module backed by Drizzle ORM. */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service';
import { DRIZZLE_DB } from './database.constants';

@Module({
  imports: [ConfigModule],
  providers: [
    DatabaseService,
    {
      provide: DRIZZLE_DB,
      useFactory: (databaseService: DatabaseService) => databaseService.db,
      inject: [DatabaseService],
    },
  ],
  exports: [DatabaseService, DRIZZLE_DB],
})
export class DatabaseModule {}
