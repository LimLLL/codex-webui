/** Thin adapter over generated SDK for runtime settings endpoints. */
import {
  settingsListSettings,
  settingsUpdateSetting,
  settingsResetSetting,
} from '@/generated/api/sdk.gen';
import type {
  SettingDto,
  SettingConstraintsDto,
  UpdateSettingDto,
} from '@/generated/api/types.gen';

export type SettingType = SettingDto['type'];
export type SettingCategory = SettingDto['category'];
export type SettingSource = SettingDto['source'];
export type SettingValue = SettingDto['value'];
export type SettingConstraints = SettingConstraintsDto;

/** Frontend-friendly alias for the generated SettingDto. */
export type RuntimeSetting = SettingDto;

export interface SettingsListResponse {
  settings: RuntimeSetting[];
}

export const settingsQueryKey = (category: SettingCategory) =>
  ['settings', category] as const;

/** Lists runtime settings by category. */
export async function listSettings(
  category: SettingCategory,
): Promise<SettingsListResponse> {
  const { data } = await settingsListSettings({
    query: { category },
    throwOnError: true,
  });
  return data;
}

/** Updates one runtime setting; value=null resets to env/default fallback. */
export async function updateSetting(
  key: string,
  value: SettingValue | null,
): Promise<RuntimeSetting> {
  const body: UpdateSettingDto = { value };
  const { data } = await settingsUpdateSetting({
    path: { key },
    body,
    throwOnError: true,
  });
  return data;
}

/** Clears one runtime setting override (resets to env/default). */
export async function resetSetting(key: string): Promise<RuntimeSetting> {
  const { data } = await settingsResetSetting({
    path: { key },
    throwOnError: true,
  });
  return data;
}
