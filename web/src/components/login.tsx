/**
 * Login page for WebUI API key authentication.
 * Full-screen animated gradient background + glass card.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KeyRound, Loader2 } from 'lucide-react';

interface Props {
  onLogin: (apiKey: string) => Promise<boolean>;
}

export function LoginPage({ onLogin }: Props) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');

    try {
      const ok = await onLogin(trimmed);
      if (!ok) {
        setError(t('Invalid API key'));
      }
    } catch {
      setError(t('Failed to connect to server'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex h-[var(--app-vh,100dvh)] items-center justify-center overflow-hidden bg-background">
      <form
        onSubmit={handleSubmit}
        className="glass-5 relative z-10 w-full max-w-sm space-y-5 rounded-3xl p-8"
      >
        <div className="flex items-center gap-2.5 text-lg font-semibold">
          <KeyRound className="h-5 w-5 opacity-70" />
          Codex WebUI
        </div>
        <p className="text-sm text-muted-foreground">
          {t('Enter your API key to continue.')}
        </p>

        <Input
          type="password"
          placeholder={t('API Key')}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="rounded-xl border-[var(--glass-border)] bg-background/40 backdrop-blur-sm transition-all focus:bg-background/60"
          autoFocus
        />

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        <Button type="submit" className="w-full rounded-xl" disabled={loading || !apiKey.trim()}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {t('Login')}
        </Button>
      </form>
    </div>
  );
}
