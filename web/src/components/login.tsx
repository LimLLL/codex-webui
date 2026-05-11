/**
 * Login page for WebUI API key authentication.
 * Validates against the backend before granting access.
 */
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KeyRound, Loader2 } from 'lucide-react';

interface Props {
  onLogin: (apiKey: string) => Promise<boolean>;
}

export function LoginPage({ onLogin }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');

    try {
      const ok = await onLogin(trimmed);
      if (!ok) {
        setError('Invalid API key');
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6"
      >
        <div className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="h-5 w-5" />
          Codex WebUI
        </div>
        <p className="text-sm text-muted-foreground">
          Enter your API key to continue.
        </p>

        <Input
          type="password"
          placeholder="API Key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoFocus
        />

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading || !apiKey.trim()}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Login
        </Button>
      </form>
    </div>
  );
}
