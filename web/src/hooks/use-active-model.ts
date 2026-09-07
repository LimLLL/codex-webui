/**
 * Resolves the model the next turn will actually use, plus the visible catalog.
 *
 * Shared by every composer control that renders model-advertised options
 * (reasoning efforts, service tiers). Those lists differ per model, so a
 * control that resolved the active model on its own could disagree with the
 * model picker and offer options the model never declared.
 */
import { useQuery } from '@tanstack/react-query';
import {
  codexStatusGetStatusOptions,
  modelsListModelsOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type { ModelDto } from '@/generated/api';
import { useModelStore } from '@/stores/model-store';

export interface ActiveModel {
  /** Non-hidden models advertised by app-server, in catalog order. */
  models: ModelDto[];
  /** Model id the next turn resolves to, or null when none is known. */
  activeModelId: string | null;
  /** Catalog entry for `activeModelId`, if it is present in the list. */
  activeModel: ModelDto | undefined;
  /** Model id from Codex config, i.e. the value an override replaces. */
  configModel: string | undefined;
}

/** Returns the resolved active model and the catalog it came from. */
export function useActiveModel(): ActiveModel {
  const modelOverride = useModelStore((s) => s.modelOverride);

  // Config model from status (lightweight, cached)
  const { data: statusData } = useQuery({
    ...codexStatusGetStatusOptions(),
    refetchOnWindowFocus: true,
  });
  // Full model list from dedicated endpoint (longer staleTime)
  const { data: modelsData } = useQuery({
    ...modelsListModelsOptions(),
    staleTime: 60_000,
  });

  const configModel = (
    statusData?.config.data as { model?: string } | undefined
  )?.model;
  const models = modelsData?.data?.filter((m) => !m.hidden) ?? [];
  const activeModelId = modelOverride ?? configModel ?? null;

  return {
    models,
    activeModelId,
    activeModel: models.find((m) => m.model === activeModelId),
    configModel,
  };
}
