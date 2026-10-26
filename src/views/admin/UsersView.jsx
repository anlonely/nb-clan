import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../shared/api.js';
import { formatCopy, localizeError } from '../../shared/format.js';
import { accountRoleLabel, ensureCurrentRoleOption, roleOptionLabel, roleOptionsForUser } from '../../shared/permissions.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

export default function UsersView({ user, setToast, t, canEdit = false }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'member_manager', boundSteamInput: '' });
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingUserId, setUpdatingUserId] = useState('');
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const assignableRoles = useMemo(() => roleOptionsForUser(user, roles), [roles, user]);

  function applyPayload(payload) {
    setUsers(payload.users || []);
    if (payload.roles) {
      setRoles(payload.roles);
      const nextOptions = roleOptionsForUser(user, payload.roles);
      setForm((current) => nextOptions.some((role) => role.code === current.role)
        ? current
        : { ...current, role: nextOptions[0]?.code || current.role });
    }
  }

  async function load() {
    setLoading(true);
    try {
      const payload = await api('/api/users');
      applyPayload(payload);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((err) => setError(localizeError(err.message, t)));
  }, []);

  async function createUser(event) {
    event.preventDefault();
    if (!canEdit || cleanupLoading) return;
    setError('');
    setTemporaryPassword('');
    try {
      const payload = await api('/api/users', { method: 'POST', body: form });
      applyPayload(payload);
      setForm({ username: '', password: '', role: assignableRoles[0]?.code || 'member', boundSteamInput: '' });
      if (payload.temporaryPassword) setTemporaryPassword(payload.temporaryPassword);
      setToast(t('accountCreated'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function resetPassword(user) {
    if (!canEdit || updatingUserId || cleanupLoading) return;
    setError('');
    setUpdatingUserId(user.id);
    try {
      const payload = await api(`/api/users/${user.id}`, { method: 'PUT', body: { resetPassword: true } });
      applyPayload(payload);
      setTemporaryPassword(payload.temporaryPassword);
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setUpdatingUserId('');
    }
  }

  async function updateRole(user, role) {
    if (!canEdit || updatingUserId || cleanupLoading) return;
    if (user.isRoot || user.username === 'root') return;
    if (role === user.role) return;
    setError('');
    setUpdatingUserId(user.id);
    try {
      const payload = await api(`/api/users/${user.id}`, { method: 'PUT', body: { role } });
      applyPayload(payload);
      setToast(t('accountUpdated'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setUpdatingUserId('');
    }
  }

  async function removeUser(user) {
    if (!canEdit || updatingUserId || cleanupLoading) return;
    if (!window.confirm(formatCopy(t('confirmDeleteUser'), { name: user.username }))) return;
    setError('');
    setUpdatingUserId(user.id);
    try {
      const payload = await api(`/api/users/${user.id}`, { method: 'DELETE' });
      applyPayload(payload);
      setToast(t('accountDeleted'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setUpdatingUserId('');
    }
  }

  async function cleanupDeletedMemberAccounts() {
    if (!canEdit || updatingUserId || cleanupLoading) return;
    if (!window.confirm(t('confirmCleanupDeletedMemberAccounts'))) return;
    setError('');
    setCleanupLoading(true);
    try {
      const payload = await api('/api/users/cleanup-orphan-member-accounts', { method: 'POST' });
      applyPayload(payload);
      setToast(formatCopy(t('deletedMemberAccountsCleanupDone'), { count: payload.cleanup?.deleted || 0 }));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setCleanupLoading(false);
    }
  }

  if (loading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('navUsers')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack">
      {canEdit && (
        <form className="tool-panel user-form" onSubmit={createUser}>
          <label>
            <span>{t('account')}</span>
            <input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              minLength={2}
              maxLength={32}
              pattern="[A-Za-z0-9_.-]{2,32}"
              title={t('errorUsernameInvalid')}
              required
            />
          </label>
          <label>
            <span>{t('initialPassword')}</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder={t('autoPassword')}
            />
          </label>
          <label>
            <span>{t('role')}</span>
            <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
              {assignableRoles.map((role) => (
                <option key={role.code} value={role.code}>{roleOptionLabel(role, t)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('bindSteam')}</span>
            <input
              value={form.boundSteamInput}
              onChange={(event) => setForm({ ...form, boundSteamInput: event.target.value })}
              placeholder={form.role === 'leader' ? t('leaderSteamRequired') : t('optional')}
              required={form.role === 'leader'}
            />
          </label>
          <button className="primary-button align-end" title={t('create')} disabled={!assignableRoles.length || cleanupLoading}>
            <UserPlus size={18} />
            <span>{t('createShort')}</span>
          </button>
          {error && <Alert tone="danger" className="span-2">{error}</Alert>}
          {temporaryPassword && (
            <Alert className="span-2">
              {t('temporaryPassword')}: <span className="mono">{temporaryPassword}</span>
            </Alert>
          )}
        </form>
      )}
      {!canEdit && error && <Alert tone="danger">{error}</Alert>}

      {canEdit && (
        <section className="tool-panel users-maintenance-panel">
          <div>
            <strong>{t('deletedMemberAccountsCleanupTitle')}</strong>
            <p>{t('deletedMemberAccountsCleanupHint')}</p>
          </div>
          <button
            type="button"
            className="action-button danger compact-form-button"
            onClick={cleanupDeletedMemberAccounts}
            disabled={cleanupLoading || Boolean(updatingUserId)}
          >
            <Trash2 size={17} />
            <span>{cleanupLoading ? t('accountUpdating') : t('cleanupDeletedMemberAccounts')}</span>
          </button>
        </section>
      )}

      <DataTable columns={canEdit ? [t('account'), t('role'), t('bindSteam'), t('steamNickname'), t('manage')] : [t('account'), t('role'), t('bindSteam'), t('steamNickname')]} emptyText={t('noAccounts')}>
        {users.map((item) => {
          const rowUpdating = updatingUserId === item.id;
          return (
            <tr key={item.id} className={cx(rowUpdating && 'is-updating')}>
              <td>
                <span>{item.username}</span>
                {rowUpdating && <span className="status-badge pending account-updating-badge" role="status" aria-live="polite">{t('accountUpdating')}</span>}
              </td>
              <td>
                {!canEdit || item.isRoot || item.username === 'root' ? (
                  <span className="status-badge active">{accountRoleLabel(item, t)}</span>
                ) : (
                  <select className="compact-select" value={item.role} onChange={(event) => updateRole(item, event.target.value)} disabled={rowUpdating || Boolean(updatingUserId) || cleanupLoading}>
                    {ensureCurrentRoleOption(assignableRoles, roles, item.role).map((role) => (
                      <option key={role.code} value={role.code}>{roleOptionLabel(role, t)}</option>
                    ))}
                  </select>
                )}
              </td>
              <td className="mono break-cell">{item.boundSteamId || '-'}</td>
              <td className="break-cell">{item.steamNickname || '-'}</td>
              {canEdit && (
                <td>
                  <div className="row-actions">
                    <button className="action-button" title={t('resetPassword')} onClick={() => resetPassword(item)} disabled={rowUpdating || Boolean(updatingUserId) || cleanupLoading}>
                      <KeyRound size={17} />
                      <span>{rowUpdating ? t('accountUpdating') : t('resetPassword')}</span>
                    </button>
                    <button className="action-button danger" title={t('delete')} onClick={() => removeUser(item)} disabled={item.username === 'root' || rowUpdating || Boolean(updatingUserId) || cleanupLoading}>
                      <Trash2 size={17} />
                      <span>{t('delete')}</span>
                    </button>
                  </div>
                </td>
              )}
            </tr>
          );
        })}
      </DataTable>
    </section>
  );
}
