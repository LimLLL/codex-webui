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
  /** Models the picker lists by default, in catalog order. */
  models: ModelDto[];
  /**
   * Catalog entries the picker hides unless the user opts in.
   *
   * The catalog marks several real, selectable models as hidden — the pinned
   * catalog hides six of eleven. Dropping them entirely made a configured
   * hidden model unnameable in the UI and impossible to switch back to.
   */
  hiddenModels: ModelDto[];
  /** Model id the next turn resolves to, or null when none is known. */
  activeModelId: string | null;
  /** Catalog entry for `activeModelId`, hidden or not. */
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
  // Full model list from dedicated endpoint (longer staleTime). Hidden models
  // are requested so the active one can always be named, then split rather than
  // discarded so the picker still leads with the shortlist.
  const { data: modelsData } = useQuery({
    ...modelsListModelsOptions({ query: { includeHidden: true } }),
    staleTime: 60_000,
  });

  const configModel = (
    statusData?.config.data as { model?: string } | undefined
  )?.model;
  const all = modelsData?.data ?? [];
  const models = all.filter((m) => !m.hidden);
  const activeModelId = modelOverride ?? configModel ?? null;

  return {
    models,
    hiddenModels: all.filter((m) => m.hidden),
    activeModelId,
    activeModel: all.find((m) => m.model === activeModelId),
    configModel,
  };
}
