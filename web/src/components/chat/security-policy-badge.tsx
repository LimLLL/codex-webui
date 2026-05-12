/** Interactive security policy selector for the chat input area. */
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  codexStatusGetStatusOptions,
  codexStatusUpdateApprovalPolicyMutation,
  codexStatusUpdateSandboxModeMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { cn } from '@/lib/utils';

const APPROVAL_OPTIONS = ['on-failure', 'on-request', 'never', 'untrusted'] as const;
const SANDBOX_OPTIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const;

interface ConfigSummary {
  sandboxMode?: string | null;
  sandboxNetworkAccess?: boolean | null;
  approvalPolicy?: unknown;
}

/** Displays and allows switching approval policy and sandbox mode. */
export function SecurityPolicyBadge() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...codexStatusGetStatusOptions(),
    refetchOnWindowFocus: true,
  });

  const invalidateStatus = () => {
    void queryClient.invalidateQueries({
      queryKey: codexStatusGetStatusOptions().queryKey,
    });
  };

  const updateApproval = useMutation({
    ...codexStatusUpdateApprovalPolicyMutation(),
    onSuccess: invalidateStatus,
  });

  const updateSandbox = useMutation({
    ...codexStatusUpdateSandboxModeMutation(),
    onSuccess: invalidateStatus,
  });

  const config = data?.config.data as ConfigSummary | undefined;
  if (!config) return null;

  const currentApproval = describeApproval(config.approvalPolicy);
  const currentSandbox = config.sandboxMode ?? 'unknown';
  const networkAccess = describeNetwork(config.sandboxNetworkAccess);
  const risky =
    currentSandbox === 'danger-full-access' || currentApproval === 'never';
  const Icon = risky ? ShieldAlert : ShieldCheck;
  const pending = updateApproval.isPending || updateSandbox.isPending;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-lg px-2 text-xs"
          title={t('Security policy')}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">
            {t(currentSandbox)}
            <span className="mx-1 text-muted-foreground">·</span>
            {t(currentApproval)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-60 space-y-3 p-3 text-sm"
      >
        <p className="text-xs text-muted-foreground">
          {t('Hot-reloads into all active threads.')}
        </p>

        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2.5 py-2 text-xs">
          <span className="text-muted-foreground">{t('Network')}</span>
          <span className="text-right">{t(networkAccess)}</span>
        </div>

        {/* Approval policy */}
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('Approval')}
          </div>
          {APPROVAL_OPTIONS.map((option) => (
            <OptionRow
              key={option}
              label={option}
              active={currentApproval === option}
              risky={option === 'never'}
              disabled={pending}
              onClick={() =>
                updateApproval.mutate({ body: { approvalPolicy: option } })
              }
            />
          ))}
        </div>

        {/* Sandbox mode */}
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t('Sandbox')}
          </div>
          {SANDBOX_OPTIONS.map((option) => (
            <OptionRow
              key={option}
              label={option}
              active={currentSandbox === option}
              risky={option === 'danger-full-access'}
              disabled={pending}
              onClick={() =>
                updateSandbox.mutate({ body: { sandboxMode: option } })
              }
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OptionRow({
  label,
  active,
  risky,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  risky?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={disabled || active}
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active
          ? risky
            ? 'bg-destructive/10 text-destructive'
            : 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50',
        risky && !active && 'text-destructive',
      )}
    >
      {t(label)}
      {active && (
        <Badge variant={risky ? 'destructive' : 'secondary'} className="text-[10px]">
          {t('current')}
        </Badge>
      )}
    </button>
  );
}

function describeNetwork(value: boolean | null | undefined): string {
  if (value === true) return 'network enabled';
  if (value === false) return 'network restricted';
  return 'unknown';
}

function describeApproval(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return 'granular';
  return 'unknown';
}
