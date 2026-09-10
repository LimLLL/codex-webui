import { Module } from '@nestjs/common';
import { CodexConfigController } from './codex-config.controller';
import { CodexFeedbackController } from './codex-feedback.controller';
import { CodexProcessManager } from './codex-process-manager.service';
import { CodexStatusController } from './codex-status.controller';
import { CodexStatusService } from './codex-status.service';
import { CodexService } from './codex.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogPathsService } from './catalog/catalog-paths.service';
import { CatalogStorageService } from './catalog/catalog-storage.service';
import { CatalogNativeService } from './catalog/catalog-native.service';
import {
  CatalogAdmissionService,
  CatalogMutationInterceptor,
} from './catalog/catalog-admission.service';
import { CatalogActivityService } from './catalog/catalog-activity.service';
import { CatalogService } from './catalog/catalog.service';

@Module({
  controllers: [
    CodexStatusController,
    CodexConfigController,
    CodexFeedbackController,
    CatalogController,
  ],
  providers: [
    CodexProcessManager,
    CodexService,
    CodexStatusService,
    CatalogPathsService,
    CatalogStorageService,
    CatalogNativeService,
    CatalogAdmissionService,
    CatalogActivityService,
    CatalogService,
    { provide: APP_INTERCEPTOR, useClass: CatalogMutationInterceptor },
  ],
  exports: [
    CodexProcessManager,
    CodexService,
    CodexStatusService,
    CatalogAdmissionService,
  ],
})
export class CodexModule {}
