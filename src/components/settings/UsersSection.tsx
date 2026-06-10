/**
 * v2.1 — UsersSection extracted from SettingsModal.tsx.
 *
 * Self-contained admin pane for local-account management. Fetches its
 * own data, doesn't take props. Mounted lazily by SettingsModal so its
 * ~320 LOC + its lucide-react icon subset only enter the bundle when
 * the operator opens Settings → Users.
 */
import React from 'react';
import {
  AlertCircle, Check, Loader2, Lock, UserPlus, KeyRound, Trash2,
  ShieldCheck, ShieldOff, Eye, EyeOff, RefreshCw,
} from 'lucide-react';
import { useAuth, useIsAdmin } from '../../hooks/useAuth';
import { meshDataService } from '../../services/meshDataService';
import { cn } from '../../lib/utils';

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

interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  createdAt: number;
  lastLoginAt: number | null;
  locked: number;
}

function UsersSection() {
  const { user: me } = useAuth();
  const isAdmin = useIsAdmin();

  const [users, setUsers] = React.useState<UserRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // New user form
  const [showCreate, setShowCreate] = React.useState(false);
  const [newUsername, setNewUsername] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newRole, setNewRole] = React.useState<'admin' | 'viewer'>('viewer');

  // Per-row password reset state — keyed by user id so we can show the
  // form inline for one row at a time without complicating the row data.
  const [resetForUserId, setResetForUserId] = React.useState<number | null>(null);
  const [resetPassword, setResetPassword] = React.useState('');

  const refresh = React.useCallback(async () => {
    setLoading(true);
    const r = await meshDataService.listUsers();
    setLoading(false);
    setUsers(r?.users ?? []);
  }, []);

  React.useEffect(() => { if (isAdmin) refresh(); }, [isAdmin, refresh]);

  if (!isAdmin) {
    return (
      <div className="space-y-3">
        <SectionHeader title="Users" subtitle="Account management is restricted to administrators." />
        <div className="flex items-start gap-2 rounded border border-brand-warning/40 bg-brand-warning/10 text-brand-warning text-[11px] p-3">
          <Lock size={12} className="mt-0.5 shrink-0" />
          <span>
            You're signed in as a <span className="font-bold uppercase">viewer</span>. Ask an admin
            to manage accounts on your behalf, or sign in with an admin account.
          </span>
        </div>
      </div>
    );
  }

  const adminCount = users?.filter(u => u.role === 'admin' && !u.locked).length ?? 0;

  const handleCreate = async () => {
    setMsg(null);
    const r = await meshDataService.createUser({ username: newUsername, password: newPassword, role: newRole });
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Create failed' }); return; }
    setMsg({ tone: 'ok', text: `Created ${newUsername} (${newRole}).` });
    setNewUsername(''); setNewPassword(''); setNewRole('viewer'); setShowCreate(false);
    refresh();
  };

  const handleRoleToggle = async (u: UserRow) => {
    setMsg(null);
    const newRole = u.role === 'admin' ? 'viewer' : 'admin';
    const r = await meshDataService.updateUser(u.id, { role: newRole });
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Role change failed' }); return; }
    setMsg({ tone: 'ok', text: `Set ${u.username} → ${newRole}.` });
    refresh();
  };

  const handleLockToggle = async (u: UserRow) => {
    setMsg(null);
    const r = await meshDataService.updateUser(u.id, { locked: !u.locked });
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Lock toggle failed' }); return; }
    setMsg({ tone: 'ok', text: u.locked ? `Unlocked ${u.username}.` : `Locked ${u.username} — their sessions were dropped.` });
    refresh();
  };

  const handleResetPassword = async (u: UserRow) => {
    if (resetPassword.length < 8) {
      setMsg({ tone: 'err', text: 'Password must be at least 8 characters' });
      return;
    }
    const r = await meshDataService.updateUser(u.id, { password: resetPassword });
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Reset failed' }); return; }
    setMsg({ tone: 'ok', text: `Reset password for ${u.username}. Their sessions were dropped.` });
    setResetForUserId(null);
    setResetPassword('');
    refresh();
  };

  const handleDelete = async (u: UserRow) => {
    if (!confirm(`Delete user "${u.username}"? Their sessions get dropped immediately and any per-user state is lost.`)) return;
    setMsg(null);
    const r = await meshDataService.deleteUser(u.id);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Delete failed' }); return; }
    setMsg({ tone: 'ok', text: `Deleted ${u.username}.` });
    refresh();
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Users"
        subtitle="Local accounts stored in SQLite. Admins can create / promote / lock / reset / delete. Sessions for a locked or deleted user are dropped immediately so existing browser tabs bounce to the login screen."
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
          {users == null ? '…' : `${users.length} account(s) · ${adminCount} active admin(s)`}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => setShowCreate(s => !s)}
            className="flex items-center gap-1 bg-brand-accent/10 hover:bg-brand-accent/20 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            <UserPlus size={11} /> Add user
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="rounded border border-brand-line bg-brand-bg/40 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Username</label>
              <input
                type="text"
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
                placeholder="e.g. mike"
                autoComplete="off"
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="≥ 8 chars"
                autoComplete="new-password"
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Role</label>
              <div className="flex items-center gap-1">
                {(['admin', 'viewer'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setNewRole(r)}
                    className={cn(
                      'flex-1 text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 border transition-colors',
                      newRole === r
                        ? 'bg-brand-accent/15 border-brand-accent/50 text-brand-accent'
                        : 'border-brand-line text-brand-muted hover:text-brand-ink',
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              disabled={!newUsername || newPassword.length < 8}
              className="bg-brand-accent text-black text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5 hover:brightness-110 disabled:opacity-40"
            >
              Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewUsername(''); setNewPassword(''); }}
              className="text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* User table */}
      {users && users.length > 0 && (
        <div className="rounded border border-brand-line overflow-hidden">
          <table className="w-full text-[11px]">
            <thead className="bg-brand-line/30 text-brand-muted">
              <tr>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Username</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Role</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Last login</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Status</th>
                <th className="text-right py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const isSelf = me?.id === u.id;
                const isResetting = resetForUserId === u.id;
                return (
                  <React.Fragment key={u.id}>
                    <tr className="border-t border-brand-line/50 hover:bg-brand-line/10">
                      <td className="py-2 px-3 mono-text">
                        {u.username}
                        {isSelf && <span className="ml-1 text-[9px] uppercase tracking-widest text-brand-muted">(you)</span>}
                      </td>
                      <td className="py-2 px-3">
                        <span className={cn(
                          'text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded',
                          u.role === 'admin'
                            ? 'bg-brand-accent/20 text-brand-accent border border-brand-accent/40'
                            : 'bg-brand-line text-brand-muted border border-brand-line',
                        )}>
                          {u.role}
                        </span>
                      </td>
                      <td className="py-2 px-3 mono-text text-[10px] text-brand-muted">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never'}
                      </td>
                      <td className="py-2 px-3">
                        {u.locked
                          ? <span className="text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/40">locked</span>
                          : <span className="text-[9px] uppercase tracking-widest text-brand-muted">active</span>}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleRoleToggle(u)}
                            title={u.role === 'admin' ? 'Demote to viewer' : 'Promote to admin'}
                            className="p-1 rounded text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
                          >
                            {u.role === 'admin' ? <ShieldOff size={11} /> : <ShieldCheck size={11} />}
                          </button>
                          <button
                            onClick={() => handleLockToggle(u)}
                            title={u.locked ? 'Unlock' : 'Lock — drops their sessions, blocks future logins'}
                            className="p-1 rounded text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
                          >
                            {u.locked ? <Lock size={11} /> : <Lock size={11} className="opacity-40" />}
                          </button>
                          <button
                            onClick={() => { setResetForUserId(isResetting ? null : u.id); setResetPassword(''); }}
                            title="Reset password"
                            className="p-1 rounded text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
                          >
                            <KeyRound size={11} />
                          </button>
                          <button
                            onClick={() => handleDelete(u)}
                            disabled={isSelf}
                            title={isSelf ? "Can't delete yourself — log out first" : 'Delete user'}
                            className="p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isResetting && (
                      <tr className="bg-brand-line/10">
                        <td colSpan={5} className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Reset {u.username}:</span>
                            <input
                              type="password"
                              value={resetPassword}
                              onChange={e => setResetPassword(e.target.value)}
                              placeholder="New password (≥ 8 chars)"
                              autoComplete="new-password"
                              className="bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[11px] mono-text focus:outline-none focus:border-brand-accent flex-1"
                            />
                            <button
                              onClick={() => handleResetPassword(u)}
                              disabled={resetPassword.length < 8}
                              className="bg-brand-accent text-black text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 disabled:opacity-40"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setResetForUserId(null); setResetPassword(''); }}
                              className="text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-brand-muted/80 italic leading-snug">
        Passwords are stored as scrypt hashes — there's no recovery if you forget yours, only reset by another admin.
        The last unlocked admin can't be demoted, locked, or deleted; the install must always have at least one admin.
        Deleting a user drops their sessions immediately via the foreign-key cascade.
      </p>
    </div>
  );
}


export default UsersSection;
