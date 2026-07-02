/**
 * v2.1 — WorkspacesSection extracted from SettingsModal.tsx.
 *
 * Admin pane for tenant-scope management (workspaces, members, radio
 * assignments). Self-contained, lazy-loaded by SettingsModal.
 */
import React from 'react';
import {
  AlertCircle, Check, Loader2, Plus, Trash2, Star, Lock, KeyRound,
  Users as UsersIcon, ChevronDown, RefreshCw, History,
} from 'lucide-react';
import { useIsAdmin } from '../../hooks/useAuth';
import { meshDataService } from '../../services/meshDataService';
import { cn } from '../../lib/utils';
import type { WorkspaceAuditEntry } from '../../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Local section header. Inline-duplicated per section so each lazy
 *  chunk is self-contained — no cross-section import. */
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold uppercase tracking-tight text-brand-ink">{title}</h4>
      <p className="text-[11px] text-brand-muted mt-0.5">{subtitle}</p>
    </div>
  );
}

interface WorkspaceListRow {
  id: number;
  name: string;
  slug: string;
  ownerUserId: number | null;
  createdAt: number;
  memberCount: number;
  radioCount: number;
}

interface WorkspaceDetail {
  workspace: WorkspaceListRow;
  members: Array<{ userId: number; username: string; role: 'admin' | 'viewer'; joinedAt: number; isOwner: number }>;
  radios: Array<{ radio_id: string; long_name: string; workspace_id: number | null }>;
}

function WorkspacesSection() {
  const isAdmin = useIsAdmin();

  const [workspaces, setWorkspaces] = React.useState<WorkspaceListRow[] | null>(null);
  const [allUsers, setAllUsers] = React.useState<Array<{ id: number; username: string; role: 'admin' | 'viewer'; locked: number }> | null>(null);
  const [allRadios, setAllRadios] = React.useState<Array<{ radio_id: string; long_name: string; workspace_id: number | null }> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Expanded workspace id (for the inline detail panel).
  const [expandedId, setExpandedId] = React.useState<number | null>(null);
  const [detail, setDetail] = React.useState<WorkspaceDetail | null>(null);

  // Create-workspace form
  const [showCreate, setShowCreate] = React.useState(false);
  const [newName, setNewName] = React.useState('');

  // Rename inline state (per workspace)
  const [renamingId, setRenamingId] = React.useState<number | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');

  const refreshList = React.useCallback(async () => {
    setLoading(true);
    const [wsR, usersR, radiosR] = await Promise.all([
      meshDataService.listWorkspaces(),
      meshDataService.listUsers(),
      // We need ALL radios across workspaces for the assign-radio
      // dropdown, not the workspace-filtered list. There's no admin
      // bypass endpoint for this — but the workspace-detail endpoint
      // surfaces radios per workspace, which is enough when combined.
      // For the global view we just walk through all workspaces.
      meshDataService.listWorkspaces().then(async wsList => {
        if (!wsList) return null;
        const all: Array<{ radio_id: string; long_name: string; workspace_id: number | null }> = [];
        for (const w of wsList.workspaces) {
          const d = await meshDataService.getWorkspaceDetail(w.id);
          if (d?.radios) for (const r of d.radios) all.push(r);
        }
        return all;
      }),
    ]);
    setLoading(false);
    setWorkspaces(wsR?.workspaces ?? []);
    setAllUsers(usersR?.users ?? []);
    setAllRadios(radiosR ?? []);
  }, []);

  React.useEffect(() => { if (isAdmin) refreshList(); }, [isAdmin, refreshList]);

  // Re-fetch the expanded workspace's detail whenever the expansion changes.
  React.useEffect(() => {
    if (!expandedId) { setDetail(null); return; }
    let cancelled = false;
    meshDataService.getWorkspaceDetail(expandedId).then(d => {
      if (!cancelled) setDetail(d);
    });
    return () => { cancelled = true; };
  }, [expandedId, workspaces]);

  if (!isAdmin) {
    return (
      <div className="space-y-3">
        <SectionHeader title="Workspaces" subtitle="Workspace management is restricted to administrators." />
        <div className="flex items-start gap-2 rounded border border-brand-warning/40 bg-brand-warning/10 text-brand-warning text-[11px] p-3">
          <Lock size={12} className="mt-0.5 shrink-0" />
          <span>
            You're signed in as a <span className="font-bold uppercase">viewer</span>. Ask an admin
            to manage workspaces, or sign in with an admin account.
          </span>
        </div>
      </div>
    );
  }

  const handleCreate = async () => {
    setMsg(null);
    const r = await meshDataService.createWorkspace(newName.trim());
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Create failed' }); return; }
    setMsg({ tone: 'ok', text: `Created workspace "${newName.trim()}".` });
    setNewName(''); setShowCreate(false);
    refreshList();
  };

  const handleDelete = async (ws: WorkspaceListRow) => {
    if (!confirm(`Delete workspace "${ws.name}"? Its radios will be reassigned to the first remaining workspace; members lose access.`)) return;
    setMsg(null);
    const r = await meshDataService.deleteWorkspace(ws.id);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Delete failed' }); return; }
    setMsg({ tone: 'ok', text: `Deleted "${ws.name}".` });
    if (expandedId === ws.id) setExpandedId(null);
    refreshList();
  };

  const handleRename = async (ws: WorkspaceListRow) => {
    if (!renameDraft.trim()) { setRenamingId(null); return; }
    setMsg(null);
    const r = await meshDataService.renameWorkspace(ws.id, renameDraft.trim());
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Rename failed' }); return; }
    setRenamingId(null); setRenameDraft('');
    refreshList();
  };

  const handleAddMember = async (workspaceId: number, userId: number) => {
    setMsg(null);
    const r = await meshDataService.addWorkspaceMember(workspaceId, userId);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Add failed' }); return; }
    refreshList();
  };

  const handleRemoveMember = async (workspaceId: number, userId: number, username: string) => {
    if (!confirm(`Remove ${username} from this workspace?`)) return;
    setMsg(null);
    const r = await meshDataService.removeWorkspaceMember(workspaceId, userId);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Remove failed' }); return; }
    refreshList();
  };

  const handleReassignRadio = async (workspaceId: number, radioId: string) => {
    setMsg(null);
    const r = await meshDataService.assignRadioToWorkspace(workspaceId, radioId);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Reassign failed' }); return; }
    refreshList();
  };

  const handleSetOwner = async (workspaceId: number, ownerUserId: number | null) => {
    setMsg(null);
    const r = await meshDataService.setWorkspaceOwner(workspaceId, ownerUserId);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Owner change failed' }); return; }
    refreshList();
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Workspaces"
        subtitle="Tenant scopes for radios + messages + nodes. Each radio belongs to one workspace; users can be members of multiple. The default 'Household' workspace contains your existing radios + every user; create more workspaces to give household members their own scoped views."
      />

      {msg && (
        <div className={cn(
          'flex items-start gap-2 rounded border text-[11px] px-3 py-2',
          msg.tone === 'ok'
            ? 'border-brand-accent/40 bg-brand-accent/10 text-brand-accent'
            : 'border-red-500/40 bg-red-500/10 text-red-300',
        )}>
          {msg.tone === 'ok' ? <Check size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[10px] text-brand-muted">
          {workspaces == null ? '…' : `${workspaces.length} workspace(s)`}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshList}
            disabled={loading}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => setShowCreate(s => !s)}
            className="flex items-center gap-1 bg-brand-accent/10 hover:bg-brand-accent/20 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            <Plus size={11} /> New workspace
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="rounded border border-brand-line bg-brand-bg/40 p-3 space-y-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Name</label>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Kid's radios"
              maxLength={64}
              autoFocus
              className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] focus:outline-none focus:border-brand-accent"
            />
            <p className="text-[10px] text-brand-muted">
              You'll automatically join the new workspace as its owner. Add members + assign radios below after creation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="bg-brand-accent text-black text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5 hover:brightness-110 disabled:opacity-40"
            >
              Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewName(''); }}
              className="text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Workspace list */}
      {workspaces && workspaces.length > 0 && (
        <div className="space-y-2">
          {workspaces.map(ws => {
            const expanded = expandedId === ws.id;
            const isRenaming = renamingId === ws.id;
            return (
              <div key={ws.id} className="rounded border border-brand-line bg-brand-bg/30">
                {/* Header row */}
                <div className="flex items-center justify-between px-3 py-2 gap-2">
                  <button
                    onClick={() => setExpandedId(expanded ? null : ws.id)}
                    className="flex-1 flex items-center gap-2 text-left text-[12px]"
                  >
                    <ChevronDown
                      size={12}
                      className={cn('text-brand-muted transition-transform', expanded ? 'rotate-0' : '-rotate-90')}
                    />
                    {isRenaming ? (
                      <input
                        type="text"
                        value={renameDraft}
                        onChange={e => setRenameDraft(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => { if (e.key === 'Enter') handleRename(ws); if (e.key === 'Escape') { setRenamingId(null); } }}
                        autoFocus
                        className="flex-1 bg-brand-line/50 border border-brand-line rounded px-2 py-0.5 text-[12px] focus:outline-none focus:border-brand-accent"
                      />
                    ) : (
                      <span className="font-bold mono-text text-brand-ink">{ws.name}</span>
                    )}
                    <span className="text-[9px] mono-text text-brand-muted">
                      {ws.radioCount} radio{ws.radioCount === 1 ? '' : 's'} · {ws.memberCount} member{ws.memberCount === 1 ? '' : 's'}
                    </span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    {isRenaming ? (
                      <>
                        <button onClick={() => handleRename(ws)} className="text-[10px] font-bold uppercase text-brand-accent hover:underline">Save</button>
                        <button onClick={() => setRenamingId(null)} className="text-[10px] font-bold uppercase text-brand-muted hover:text-brand-ink">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
                          title="Rename"
                          className="p-1 rounded text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
                        >
                          <KeyRound size={11} />
                        </button>
                        <button
                          onClick={() => handleDelete(ws)}
                          disabled={(workspaces?.length ?? 0) <= 1}
                          title={(workspaces?.length ?? 0) <= 1 ? "Can't delete the last workspace" : 'Delete workspace'}
                          className="p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Trash2 size={11} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Expanded detail */}
                {expanded && detail && detail.workspace.id === ws.id && (
                  <div className="border-t border-brand-line/60 p-3 space-y-3">
                    {/* Members */}
                    <div>
                      <h6 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1.5">Members</h6>
                      <div className="space-y-1">
                        {detail.members.map(m => (
                          <div key={m.userId} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-brand-line/20 text-[11px]">
                            <div className="flex items-center gap-2">
                              <span className="mono-text">{m.username}</span>
                              <span className={cn(
                                'text-[8px] uppercase tracking-widest font-bold px-1 py-0.5 rounded',
                                m.role === 'admin'
                                  ? 'bg-brand-accent/20 text-brand-accent border border-brand-accent/40'
                                  : 'bg-brand-line text-brand-muted border border-brand-line',
                              )}>
                                {m.role}
                              </span>
                              {m.isOwner ? (
                                <span className="text-[8px] uppercase tracking-widest font-bold px-1 py-0.5 rounded bg-brand-warning/20 text-brand-warning border border-brand-warning/40">
                                  owner
                                </span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-1">
                              {!m.isOwner && (
                                <button
                                  onClick={() => handleSetOwner(ws.id, m.userId)}
                                  title="Make owner"
                                  className="text-[9px] uppercase font-bold tracking-widest text-brand-muted hover:text-brand-accent"
                                >
                                  Make owner
                                </button>
                              )}
                              <button
                                onClick={() => handleRemoveMember(ws.id, m.userId, m.username)}
                                disabled={!!m.isOwner}
                                title={m.isOwner ? 'Reassign ownership before removing' : 'Remove from workspace'}
                                className="p-0.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Add member control */}
                      {allUsers && allUsers.length > detail.members.length && (
                        <div className="mt-2">
                          <select
                            onChange={e => { const uid = parseInt(e.target.value, 10); if (Number.isInteger(uid)) handleAddMember(ws.id, uid); e.target.value = ''; }}
                            defaultValue=""
                            className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[11px] focus:outline-none focus:border-brand-accent"
                          >
                            <option value="" disabled>+ Add member…</option>
                            {allUsers
                              .filter(u => !detail.members.some(m => m.userId === u.id))
                              .map(u => (
                                <option key={u.id} value={u.id}>{u.username} ({u.role})</option>
                              ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Radios in this workspace */}
                    <div>
                      <h6 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1.5">Radios</h6>
                      {detail.radios.length === 0 ? (
                        <p className="text-[10px] text-brand-muted italic">No radios assigned. Move one in from the list below.</p>
                      ) : (
                        <div className="space-y-1">
                          {detail.radios.map(r => (
                            <div key={r.radio_id} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-brand-line/20 text-[11px]">
                              <div className="flex items-center gap-2">
                                <span className="mono-text">{r.radio_id}</span>
                                <span className="text-brand-muted">{r.long_name}</span>
                              </div>
                              {/* Reassign-to dropdown */}
                              <select
                                onChange={e => { const wid = parseInt(e.target.value, 10); if (Number.isInteger(wid) && wid !== ws.id) handleReassignRadio(wid, r.radio_id); e.target.value = ''; }}
                                defaultValue=""
                                className="bg-brand-line/40 border border-brand-line rounded px-1.5 py-0.5 text-[10px] focus:outline-none focus:border-brand-accent"
                              >
                                <option value="" disabled>Move to…</option>
                                {workspaces?.filter(w => w.id !== ws.id).map(w => (
                                  <option key={w.id} value={w.id}>{w.name}</option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Pull-in for radios that live in other workspaces */}
                      {allRadios && allRadios.some(r => r.workspace_id !== ws.id) && (
                        <div className="mt-2">
                          <select
                            onChange={e => { const rid = e.target.value; if (rid) handleReassignRadio(ws.id, rid); e.target.value = ''; }}
                            defaultValue=""
                            className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[11px] focus:outline-none focus:border-brand-accent"
                          >
                            <option value="" disabled>+ Pull radio in from another workspace…</option>
                            {allRadios
                              .filter(r => r.workspace_id !== ws.id)
                              .map(r => {
                                const sourceWs = workspaces?.find(w => w.id === r.workspace_id);
                                return (
                                  <option key={r.radio_id} value={r.radio_id}>
                                    {r.radio_id} — {r.long_name}{sourceWs ? ` (from "${sourceWs.name}")` : ''}
                                  </option>
                                );
                              })}
                          </select>
                        </div>
                      )}

                      {/* v3.0 Multi-tenant cleanup — audit log panel */}
                      <WorkspaceAuditLogPanel workspaceId={ws.id} expanded={expanded} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-brand-muted/80 italic leading-snug">
        Deleting a workspace reassigns its radios to the first remaining workspace (radios never orphan).
        The last workspace can't be deleted. Owner can't be removed without reassigning ownership first.
        Radios + messages physically keep flowing even when a workspace they belong to isn't currently being viewed — the workspace filter is read-side only.
      </p>
    </div>
  );
}


/**
 * v3.0 multi-tenant cleanup — audit log for a single workspace.
 * Renders the workspace's mutation history (create, rename, member
 * add/remove, radio assign/unassign, primary radio changes) so an
 * operator can answer "who did what, when?" as a trust-but-verify
 * for the multi-tenant isolation guarantees.
 *
 * Lazy: only fetches when the parent workspace row is expanded.
 * Auto-refreshes every 20s while visible so member/radio mutations
 * elsewhere in this session appear without a manual refresh.
 */
function WorkspaceAuditLogPanel({
  workspaceId,
  expanded,
}: {
  workspaceId: number;
  expanded: boolean;
}) {
  const [entries, setEntries] = React.useState<WorkspaceAuditEntry[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(true);

  const reload = React.useCallback(async () => {
    if (!expanded || collapsed) return;
    setLoading(true);
    const r = await meshDataService.workspaceAuditLog(workspaceId, { limit: 200 });
    setLoading(false);
    setEntries(r?.entries ?? []);
  }, [workspaceId, expanded, collapsed]);

  React.useEffect(() => { reload(); }, [reload]);
  React.useEffect(() => {
    if (!expanded || collapsed) return;
    const t = setInterval(reload, 20_000);
    return () => clearInterval(t);
  }, [reload, expanded, collapsed]);

  if (!expanded) return null;

  return (
    <div className="pt-3 border-t border-brand-line/40">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-2 text-[10px] uppercase font-bold tracking-widest text-brand-muted hover:text-brand-ink transition-colors w-full"
      >
        <History size={11} />
        Audit Log
        <ChevronDown
          size={11}
          className={cn('transition-transform', collapsed ? '-rotate-90' : 'rotate-0')}
        />
        <span className="ml-auto text-brand-muted/60 normal-case tracking-normal font-normal">
          {entries === null ? '' : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}
          {loading && <RefreshCw size={9} className="ml-1 animate-spin inline" />}
        </span>
      </button>

      {!collapsed && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-brand-line/60 bg-brand-bg/40">
          {entries === null || entries.length === 0 ? (
            <div className="text-[10px] text-brand-muted p-3 text-center">
              {loading ? 'Loading…' : entries === null ? '—' : 'No audit entries yet.'}
            </div>
          ) : (
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-brand-bg/95 backdrop-blur border-b border-brand-line/60">
                <tr>
                  <th className="text-left px-2 py-1 font-bold uppercase tracking-widest text-brand-muted">When</th>
                  <th className="text-left px-2 py-1 font-bold uppercase tracking-widest text-brand-muted">Actor</th>
                  <th className="text-left px-2 py-1 font-bold uppercase tracking-widest text-brand-muted">Action</th>
                  <th className="text-left px-2 py-1 font-bold uppercase tracking-widest text-brand-muted">Target / Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className="border-b border-brand-line/30 hover:bg-brand-line/20">
                    <td className="px-2 py-1 mono-text text-brand-muted whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString([], {
                        month: 'numeric', day: 'numeric',
                        hour: 'numeric', minute: '2-digit',
                      })}
                    </td>
                    <td className="px-2 py-1 mono-text">
                      {e.actorUsername}
                    </td>
                    <td className="px-2 py-1">
                      <ActionBadge action={e.action} />
                    </td>
                    <td className="px-2 py-1 text-brand-muted">
                      {formatEntryDetails(e)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** Turn an action string like 'workspace.member.add' into a compact
 *  badge with contextual color. */
function ActionBadge({ action }: { action: string }) {
  const tone = action.includes('.delete') || action.includes('.remove')
    ? 'error'
    : action.includes('.create') || action.includes('.add')
    ? 'accent'
    : action.includes('.rename') || action.includes('.change') || action.includes('.set') || action.includes('.assign')
    ? 'warning'
    : 'muted';
  const cls =
    tone === 'error'   ? 'bg-brand-error/15 text-brand-error border-brand-error/30'
    : tone === 'accent'  ? 'bg-brand-accent/15 text-brand-accent border-brand-accent/30'
    : tone === 'warning' ? 'bg-brand-warning/15 text-brand-warning border-brand-warning/30'
    : 'bg-brand-line/40 text-brand-muted border-brand-line';
  return (
    <span className={cn(
      'inline-block text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border mono-text',
      cls,
    )}>
      {action.replace(/^workspace\./, '')}
    </span>
  );
}

/** Compact human-readable rendering of the entry's target + details
 *  columns. Avoids showing raw JSON in the table — that's tucked
 *  into a title tooltip for anyone who wants the raw form. */
function formatEntryDetails(e: WorkspaceAuditEntry): string {
  const parts: string[] = [];
  if (e.targetType && e.targetId) {
    parts.push(`${e.targetType}=${e.targetId}`);
  }
  const d = e.details as Record<string, unknown> | null;
  if (d && typeof d === 'object') {
    if ('fromName' in d && 'toName' in d) parts.push(`"${d.fromName}" → "${d.toName}"`);
    if ('name' in d && typeof d.name === 'string' && !('fromName' in d)) parts.push(`name="${d.name}"`);
    if ('fromWorkspaceId' in d && d.fromWorkspaceId !== null) parts.push(`from ws#${d.fromWorkspaceId}`);
    if ('toWorkspaceId' in d) parts.push(`to ws#${d.toWorkspaceId}`);
    if ('migratedRadiosTo' in d && d.migratedRadiosTo !== null) parts.push(`radios → ws#${d.migratedRadiosTo}`);
    if ('previousPrimary' in d && d.previousPrimary !== undefined) parts.push(`was="${d.previousPrimary ?? '<none>'}"`);
  }
  return parts.join(' · ') || '—';
}


export default WorkspacesSection;
