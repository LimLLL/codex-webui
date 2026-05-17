/**
 * Skill selector chip in ChatInput bottom bar.
 * Click → Popover with search + skill list from GET /api/skills.
 * "Manage" toggle reveals all skills with enable/disable switches.
 */
import { useState, useMemo } from 'react';
import { Zap, Loader2, Settings2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { skillsListSkillsOptions, skillsListSkillsQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { skillsWriteSkillConfig } from '@/generated/api/sdk.gen';
import { cn } from '@/lib/utils';
import { showSnackbar } from '@/stores/snackbar-store';

export interface SkillSelection {
  name: string;
  path: string;
}

interface SkillEntry {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
}

interface Props {
  cwd: string | null;
  disabled?: boolean;
  onSelect: (skill: SkillSelection) => void;
}

export function SkillSelector({ cwd, disabled, onSelect }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [manageMode, setManageMode] = useState(false);

  const { data, isLoading } = useQuery({
    ...skillsListSkillsOptions({ query: { cwd: cwd ?? '' } }),
    enabled: open && Boolean(cwd),
  });

  // Flatten skills from response
  interface SkillsListEntry {
    skills?: SkillEntry[];
  }
  const allSkills = useMemo(() => {
    if (!data?.data) return [];
    return (data.data as SkillsListEntry[]).flatMap((entry) => entry.skills ?? []);
  }, [data]);

  // In selection mode: only enabled. In manage mode: all.
  const visibleSkills = useMemo(
    () => (manageMode ? allSkills : allSkills.filter((s) => s.enabled)),
    [allSkills, manageMode],
  );

  // Filter by search
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return visibleSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [visibleSkills, search]);

  const handleSelect = (skill: SkillEntry) => {
    if (!skill.enabled) return; // Can't select disabled skills
    onSelect({ name: skill.name, path: skill.path });
    setOpen(false);
    setSearch('');
  };

  const handleClose = () => {
    setOpen(false);
    setSearch('');
    setManageMode(false);
  };

  return (
    <Popover open={open} onOpenChange={(v) => (v ? setOpen(true) : handleClose())}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 rounded-lg px-2.5 text-xs"
          disabled={disabled || !cwd}
          title={t('Add skill')}
        >
          <Zap className="h-3.5 w-3.5" />
          {t('Skill')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="top">
        {/* Search */}
        <div className="flex items-center border-b border-border px-3 py-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Search skills...')}
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          <Button
            size="icon"
            variant={manageMode ? 'default' : 'ghost'}
            className="ml-1 h-6 w-6 shrink-0"
            title={t('Manage skills')}
            onClick={() => setManageMode((m) => !m)}
          >
            <Settings2 className="h-3 w-3" />
          </Button>
        </div>

        {/* Skill list */}
        <div className="max-h-56 overflow-y-auto py-1">
          {isLoading ? (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('Loading...')}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              {allSkills.length === 0 ? t('No skills available') : t('No matching skills')}
            </div>
          ) : (
            filtered.map((skill) =>
              manageMode ? (
                <SkillToggleRow
                  key={skill.path}
                  skill={skill}
                  onToggled={() =>
                    void queryClient.invalidateQueries({
                      queryKey: skillsListSkillsQueryKey({ query: { cwd: cwd ?? '' } }),
                    })
                  }
                />
              ) : (
                <button
                  key={skill.path}
                  type="button"
                  onClick={() => handleSelect(skill)}
                  className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/50"
                >
                  <span className="text-xs font-medium text-foreground">{skill.name}</span>
                  {skill.description && (
                    <span className="line-clamp-1 text-[11px] text-muted-foreground">
                      {skill.description}
                    </span>
                  )}
                </button>
              ),
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A single skill row in manage mode with enable/disable toggle. */
function SkillToggleRow({
  skill,
  onToggled,
}: {
  skill: SkillEntry;
  onToggled: () => void;
}) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await skillsWriteSkillConfig({
        body: { path: skill.path, enabled },
        throwOnError: true,
      });
      onToggled();
    } catch (err) {
      showSnackbar(String((err as Error).message), 'error');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className={cn(
      'flex items-center gap-2 px-3 py-1.5',
      !skill.enabled && 'opacity-60',
    )}>
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium text-foreground">{skill.name}</span>
        {skill.description && (
          <p className="line-clamp-1 text-[11px] text-muted-foreground">{skill.description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {toggling && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <Switch
          checked={skill.enabled}
          disabled={toggling}
          onCheckedChange={handleToggle}
          className="scale-75"
        />
      </div>
    </div>
  );
}
