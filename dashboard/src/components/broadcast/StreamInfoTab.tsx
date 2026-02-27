import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Search, X, Tag, Tv } from 'lucide-react';
import { getChannelInfo, updateChannelInfo, searchCategories } from '../../lib/api';
import type { TwitchChannelInfo, TwitchCategory } from '../../lib/api';
import { Card, Button, Badge } from '../../ui';

export function StreamInfoTab() {
  const queryClient = useQueryClient();

  const { data: channelInfo, isLoading, error } = useQuery<TwitchChannelInfo>({
    queryKey: ['twitch-channel'],
    queryFn: getChannelInfo,
    refetchInterval: 30000,
  });

  const [title, setTitle] = useState('');
  const [gameId, setGameId] = useState('');
  const [gameName, setGameName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [dirty, setDirty] = useState(false);

  // Category search
  const [catQuery, setCatQuery] = useState('');
  const [catResults, setCatResults] = useState<TwitchCategory[]>([]);
  const [catOpen, setCatOpen] = useState(false);
  const catRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync from server data
  useEffect(() => {
    if (channelInfo) {
      setTitle(channelInfo.title);
      setGameId(channelInfo.game_id);
      setGameName(channelInfo.game_name);
      setTags(channelInfo.tags ?? []);
      setDirty(false);
    }
  }, [channelInfo]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced category search
  useEffect(() => {
    if (catQuery.length < 2) {
      setCatResults([]);
      return;
    }
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await searchCategories(catQuery);
        setCatResults(results);
        setCatOpen(true);
      } catch {
        setCatResults([]);
      }
    }, 300);
    return () => clearTimeout(searchTimeoutRef.current);
  }, [catQuery]);

  const updateMutation = useMutation({
    mutationFn: (updates: { title?: string; game_id?: string; tags?: string[] }) =>
      updateChannelInfo(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['twitch-channel'] });
      setDirty(false);
    },
  });

  function handleSave() {
    const updates: { title?: string; game_id?: string; tags?: string[] } = {};
    if (channelInfo && title !== channelInfo.title) updates.title = title;
    if (channelInfo && gameId !== channelInfo.game_id) updates.game_id = gameId;
    if (channelInfo && JSON.stringify(tags) !== JSON.stringify(channelInfo.tags ?? [])) updates.tags = tags;
    if (Object.keys(updates).length === 0) return;
    updateMutation.mutate(updates);
  }

  function selectCategory(cat: TwitchCategory) {
    setGameId(cat.id);
    setGameName(cat.name);
    setCatQuery('');
    setCatOpen(false);
    setDirty(true);
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t) && tags.length < 10) {
      setTags([...tags, t]);
      setTagInput('');
      setDirty(true);
    }
  }

  function removeTag(tag: string) {
    setTags(tags.filter((t) => t !== tag));
    setDirty(true);
  }

  if (isLoading) {
    return (
      <Card title="Stream Info">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading channel info...</p>
      </Card>
    );
  }

  if (error) {
    const errMsg = error instanceof Error ? error.message : 'Failed to load';
    return (
      <Card title="Stream Info">
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--status-error)' }}>{errMsg}</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Ensure TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, and TWITCH_OAUTH_TOKEN are set in your .env file.
            The OAuth token needs the <code>channel:manage:broadcast</code> scope.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card title="Stream Info">
        <div className="space-y-4">
          {/* Current status */}
          <div className="flex items-center gap-3">
            <Tv size={16} style={{ color: 'var(--text-muted)' }} />
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {channelInfo?.broadcaster_name}
            </span>
            {channelInfo?.game_name && (
              <Badge variant="info" label={channelInfo.game_name} />
            )}
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Stream Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
              maxLength={140}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {title.length}/140 characters
            </p>
          </div>

          {/* Category */}
          <div ref={catRef} className="relative">
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Category
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={catQuery}
                  onChange={(e) => setCatQuery(e.target.value)}
                  onFocus={() => catResults.length > 0 && setCatOpen(true)}
                  placeholder={gameName || 'Search categories...'}
                  className="w-full pl-9 pr-3 py-2 rounded-lg text-sm"
                  style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                />
                {catOpen && catResults.length > 0 && (
                  <div
                    className="absolute z-50 w-full mt-1 rounded-lg overflow-hidden max-h-60 overflow-y-auto"
                    style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      boxShadow: 'var(--shadow-lg)',
                    }}
                  >
                    {catResults.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => selectCategory(cat)}
                        className="flex items-center gap-3 w-full px-3 py-2 text-left text-sm hover:brightness-125"
                        style={{
                          color: 'var(--text-primary)',
                          background: cat.id === gameId ? 'var(--accent-subtle)' : 'transparent',
                        }}
                      >
                        <img
                          src={cat.box_art_url.replace('{width}', '40').replace('{height}', '56')}
                          alt=""
                          className="w-5 h-7 rounded-sm object-cover flex-shrink-0"
                        />
                        <span>{cat.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {gameName && (
                <Badge variant="info" label={gameName} />
              )}
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Tags <span className="font-normal" style={{ color: 'var(--text-muted)' }}>({tags.length}/10)</span>
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs"
                  style={{
                    background: 'var(--accent-subtle)',
                    color: 'var(--accent)',
                  }}
                >
                  <Tag size={10} />
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="ml-0.5 hover:opacity-70"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            {tags.length < 10 && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                  placeholder="Add a tag..."
                  className="flex-1 px-3 py-2 rounded-lg text-sm"
                  style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                />
                <Button size="sm" variant="ghost" onClick={addTag} disabled={!tagInput.trim()}>
                  Add
                </Button>
              </div>
            )}
          </div>

          {/* Save */}
          <div className="flex items-center gap-3 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
            <Button
              variant="primary"
              icon={<Save size={14} />}
              onClick={handleSave}
              loading={updateMutation.isPending}
              disabled={!dirty}
            >
              Save Changes
            </Button>
            {updateMutation.isSuccess && (
              <span className="text-xs" style={{ color: 'var(--status-ok)' }}>Saved</span>
            )}
            {updateMutation.isError && (
              <span className="text-xs" style={{ color: 'var(--status-error)' }}>
                {updateMutation.error instanceof Error ? updateMutation.error.message : 'Failed to save'}
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
