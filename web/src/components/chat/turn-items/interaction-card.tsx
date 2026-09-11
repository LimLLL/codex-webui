/** Permission and MCP cards; none of their actions use the command decision contract. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Shield, MessageCircleQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ElicitationFieldDto } from '@/generated/api';
import type { ApprovalRequest } from '@/types/approval';
import { useRequestResponse } from '@/hooks/use-request-response';
import { useTimelineStore } from '@/stores/timeline-store';
import { ApprovalStatusBadge } from './approval-controls';

type DraftValue = string | boolean | string[];

/** Renders only the complete primitive grammar already validated by the backend. */
function ElicitationField({ field, value, onChange, disabled }: {
  field: ElicitationFieldDto; value: DraftValue | undefined;
  onChange: (value: DraftValue) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const label = <span>{field.title}{field.required ? ' *' : ''}</span>;
  if (field.type === 'array') return <fieldset disabled={disabled} className="space-y-1">
    <legend>{label}</legend>
    {field.description && <p className="text-muted-foreground">{field.description}</p>}
    {field.options?.map((option) => <label className="flex items-start gap-2" key={option.value}>
      <input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={(event) => {
        const selected = Array.isArray(value) ? value : [];
        onChange(event.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value));
      }} /> {option.label}
    </label>)}
  </fieldset>;
  return <label className="block space-y-1">
    {label}
    {field.description && <span className="block text-muted-foreground">{field.description}</span>}
    {field.type === 'boolean' || field.type === 'enum' ? <select
      className="w-full rounded border bg-background p-2" disabled={disabled} required={field.required}
      value={value === undefined ? '' : field.type === 'boolean' ? String(value) : String(field.options?.findIndex((o) => o.value === value))}
      onChange={(event) => {
        if (!event.target.value) return;
        onChange(field.type === 'boolean' ? event.target.value === 'true' : field.options![Number(event.target.value)].value);
      }}>
      <option value="" disabled>{t('Choose an answer')}</option>
      {field.type === 'boolean' ? <><option value="true">{t('Yes')}</option><option value="false">{t('No')}</option></> : field.options?.map((option, i) => <option key={option.value} value={i}>{option.label}</option>)}
    </select> : <Input
      value={typeof value === 'string' ? value : ''} disabled={disabled}
      required={field.required && (field.type !== 'string' || (field.minLength ?? 0) > 0)}
      type={field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'}
      step={field.type === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum}
      minLength={field.minLength} maxLength={field.maxLength}
      placeholder={field.format === 'date-time' ? '2026-09-11T12:00:00Z' : undefined}
      onChange={(event) => onChange(event.target.value)}
    />}
  </label>;
}

/** Displays one proposal and submits only deliberate grants or validated form input. */
export function InteractionCard({ request }: { request: ApprovalRequest }) {
  const { t } = useTranslation();
  const { send, submitting } = useRequestResponse(request);
  const [selected, setSelected] = useState<string[]>([]);
  const [sessionScope, setSessionScope] = useState(false);
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const prompt = request.presentation;
  if (!prompt) return null;
  const disabled = request.status !== 'pending' || submitting;
  const Icon = prompt.kind === 'permissions' ? Shield : MessageCircleQuestion;

  /** Preserves absent optional fields, false booleans, and explicit empty arrays. */
  const formContent = () => Object.fromEntries(prompt.fields.flatMap<[string, DraftValue | number]>((field) => {
    const value = Object.hasOwn(draft, field.name) ? draft[field.name] : undefined;
    if (value === undefined) {
      if (field.required && field.type === 'string') return [[field.name, '']];
      if (field.required && field.type === 'array') return [[field.name, []]];
      return [];
    }
    if (field.type === 'number' || field.type === 'integer') return value === '' ? [] : [[field.name, Number(value)]];
    return [[field.name, value]];
  }));

  return <div className="mb-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
    <div className="flex items-center gap-2"><Icon className="h-4 w-4" />
      <span className="font-medium">{t(prompt.kind === 'permissions' ? 'Permission request' : 'MCP input request')}</span>
      <span className="ml-auto"><ApprovalStatusBadge approval={request} /></span>
    </div>
    {prompt.serverName && <p>{t('Requested by')}: <strong>{prompt.serverName}</strong></p>}
    {prompt.message && <p className="whitespace-pre-wrap break-words">{prompt.message}</p>}
    {prompt.cwd && <p>{t('Working directory')}: <code>{prompt.cwd}</code></p>}
    {prompt.environmentId && <p>{t('Environment')}: <code>{prompt.environmentId}</code></p>}
    {!prompt.supported && <p role="alert" className="text-amber-700 dark:text-amber-300">{t(prompt.unsupportedReason ?? '')}</p>}
    {prompt.kind === 'permissions' ? <>
      <fieldset disabled={disabled} className="space-y-2">
        {prompt.permissions.map((option) => <label key={option.id} className="flex items-start gap-2">
          <input type="checkbox" checked={option.required || selected.includes(option.id)} disabled={disabled || option.required}
            onChange={(event) => setSelected((old) => event.target.checked ? [...old, option.id] : old.filter((id) => id !== option.id))} />
          <span className="min-w-0 break-all"><strong>{t(option.access)}</strong> · <code>{option.label}</code></span>
        </label>)}
        {prompt.supported && <label className="flex items-center gap-2 border-t pt-2">
          <input type="checkbox" checked={sessionScope} onChange={(event) => setSessionScope(event.target.checked)} />
          {t('Keep these grants for this session')}
        </label>}
      </fieldset>
      {request.status === 'pending' && <div className="flex gap-2">
        {prompt.supported && <Button size="sm" disabled={disabled || selected.length === 0} onClick={() => send({ selected, scope: sessionScope ? 'session' : 'turn' }, sessionScope ? 'acceptedForSession' : 'accepted')}>{t('Grant selected')}</Button>}
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => send({ selected: [], scope: 'turn' }, 'declined')}>{t('Decline')}</Button>
      </div>}
    </> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (!disabled && prompt.supported) send({ action: 'accept', content: prompt.url ? null : formContent() }, 'accepted'); }}>
      {prompt.url && <div className="space-y-2">
        <p>{t('Complete the requested action at this address, then continue.')}</p>
        <a className="inline-flex items-center gap-1 break-all underline" href={prompt.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" />{prompt.url}</a>
      </div>}
      {prompt.fields.map((field) => <ElicitationField key={field.name} field={field} value={Object.hasOwn(draft, field.name) ? draft[field.name] : undefined} disabled={disabled}
        onChange={(value) => setDraft((old) => ({ ...old, [field.name]: value }))} />)}
      {request.status === 'pending' && <div className="flex flex-wrap gap-2">
        {prompt.supported && <Button size="sm" type="submit" disabled={disabled}>{t(prompt.url ? 'Continue' : 'Submit')}</Button>}
        <Button size="sm" variant="outline" type="button" disabled={disabled} onClick={() => send({ action: 'decline', content: null }, 'declined')}>{t('Decline')}</Button>
        <Button size="sm" variant="outline" type="button" disabled={disabled} onClick={() => send({ action: 'cancel', content: null }, 'cancelled')}>{t('Cancel')}</Button>
      </div>}
    </form>}
  </div>;
}

/** Looks up a row by immutable identity; a reused RPC ID cannot replace this card. */
export function StoredInteractionCard({ requestId, instanceId }: { requestId: string; instanceId: string }) {
  const request = useTimelineStore((state) => state.approvals[requestId]);
  return request?.instanceId === instanceId ? <InteractionCard key={instanceId} request={request} /> : null;
}
