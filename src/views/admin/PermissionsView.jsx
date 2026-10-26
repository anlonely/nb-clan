import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../../shared/api.js';
import { formatCopy, localizeError } from '../../shared/format.js';
import { normalizePermissionDraft, roleOptionLabel, updatePermissionDraft } from '../../shared/permissions.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

export default function PermissionsView({ user, setToast, t, canEdit = false }) {
  const [roles, setRoles] = useState([]);
  const [modules, setModules] = useState([]);
  const [selectedCode, setSelectedCode] = useState('');
  const [draft, setDraft] = useState(null);
  const [newRole, setNewRole] = useState({ code: '', name: '', description: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedRole = roles.find((role) => role.code === selectedCode) || roles[0] || null;
  const selectedEditable = Boolean(canEdit && selectedRole);
  const selectedDeletable = Boolean(canEdit && selectedRole && !selectedRole.builtIn && !selectedRole.locked && selectedRole.userCount === 0);

  function applyPayload(payload) {
    const nextRoles = payload.roles || [];
    setRoles(nextRoles);
    setModules(payload.modules || []);
    setSelectedCode((current) => {
      if (current && nextRoles.some((role) => role.code === current)) return current;
      const firstCustom = nextRoles.find((role) => !role.builtIn);
      return (firstCustom || nextRoles[0])?.code || '';
    });
  }

  async function load() {
    setLoading(true);
    try {
      const payload = await api('/api/permissions');
      applyPayload(payload);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((err) => setError(localizeError(err.message, t)));
  }, []);

  useEffect(() => {
    if (!selectedRole) {
      setDraft(null);
      return;
    }
    setDraft({
      name: selectedRole.name || selectedRole.code,
      description: selectedRole.description || '',
      permissions: normalizePermissionDraft(selectedRole.permissions)
    });
  }, [selectedRole?.code]);

  function changePermission(moduleId, action, checked) {
    if (!selectedEditable) return;
    setDraft((current) => ({
      ...(current || {}),
      permissions: updatePermissionDraft(current?.permissions || selectedRole?.permissions || {}, moduleId, action, checked)
    }));
  }

  async function createRole(event) {
    event.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api('/api/permissions/roles', {
        method: 'POST',
        body: {
          ...newRole,
          permissions: normalizePermissionDraft(selectedRole?.permissions || {})
        }
      });
      applyPayload(payload);
      setSelectedCode(newRole.code.trim().toLowerCase());
      setNewRole({ code: '', name: '', description: '' });
      setToast(t('roleCreated'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  async function saveRole(event) {
    event.preventDefault();
    if (!selectedEditable || !selectedRole) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api(`/api/permissions/roles/${encodeURIComponent(selectedRole.code)}`, {
        method: 'PUT',
        body: draft
      });
      applyPayload(payload);
      setToast(t('permissionsSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRole() {
    if (!selectedDeletable || !selectedRole) return;
    if (!window.confirm(formatCopy(t('deleteRoleConfirm'), { name: roleOptionLabel(selectedRole, t) }))) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api(`/api/permissions/roles/${encodeURIComponent(selectedRole.code)}`, { method: 'DELETE' });
      applyPayload(payload);
      setToast(t('roleDeleted'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('navPermissions')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack permissions-page">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="permissions-layout">
        <section className="tool-panel permission-role-list-panel">
          <div className="section-heading compact-heading">
            <h3>{t('role')}</h3>
            <div className="row-actions">
              <span className="status-badge neutral">{roles.length}</span>
              {canEdit && (
                <button type="button" className="ghost-button danger" onClick={deleteRole} disabled={!selectedDeletable || saving} title={!selectedRole || selectedRole.builtIn ? t('builtinRole') : (selectedRole.userCount > 0 ? t('roleInUse') : t('delete'))}>
                  <Trash2 size={16} />
                  <span>{t('delete')}</span>
                </button>
              )}
            </div>
          </div>
          <div className="permission-role-list">
            {roles.map((role) => (
              <button
                key={role.code}
                type="button"
                className={cx('permission-role-item', selectedCode === role.code && 'active')}
                onClick={() => setSelectedCode(role.code)}
              >
                <span>
                  <strong>{roleOptionLabel(role, t)}</strong>
                  <small>{role.code}</small>
                </span>
                <span className={cx('status-badge', role.builtIn ? 'neutral' : 'active')}>
                  {role.builtIn ? t('builtinRole') : t('customRole')}
                </span>
              </button>
            ))}
          </div>
          {canEdit && (
            <form className="permission-create-form" onSubmit={createRole}>
              <label>
                <span>{t('roleCode')}</span>
                <input value={newRole.code} onChange={(event) => setNewRole({ ...newRole, code: event.target.value })} pattern="[a-z][a-z0-9_]{1,31}" required />
              </label>
              <label>
                <span>{t('roleName')}</span>
                <input value={newRole.name} onChange={(event) => setNewRole({ ...newRole, name: event.target.value })} required maxLength={40} />
              </label>
              <label>
                <span>{t('roleDescription')}</span>
                <input value={newRole.description} onChange={(event) => setNewRole({ ...newRole, description: event.target.value })} maxLength={120} />
              </label>
              <button className="primary-button" disabled={saving}>
                <Plus size={17} />
                <span>{t('createRole')}</span>
              </button>
            </form>
          )}
        </section>

        <section className="tool-panel permission-editor-panel">
          <form className="permission-role-form" onSubmit={saveRole}>
            <div className="section-heading compact-heading">
              <div className="heading-stack">
                <h3>{selectedRole ? roleOptionLabel(selectedRole, t) : t('navPermissions')}</h3>
                <small>{selectedRole?.code || '-'}</small>
              </div>
              <div className="row-actions">
                {selectedRole?.builtIn && <span className="status-badge neutral">{t('builtinRole')}</span>}
                {!selectedRole?.builtIn && <span className="status-badge active">{formatCopy(t('assignedAccounts'), { count: selectedRole?.userCount || 0 })}</span>}
                {selectedEditable && (
                  <button className="primary-button" disabled={saving}>
                    <Save size={17} />
                    <span>{saving ? t('saving') : t('saveShort')}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="permission-role-fields">
              <label>
                <span>{t('roleName')}</span>
                <input value={draft?.name || ''} onChange={(event) => setDraft({ ...(draft || {}), name: event.target.value })} disabled={!selectedEditable || saving} maxLength={40} />
              </label>
              <label>
                <span>{t('roleDescription')}</span>
                <input value={draft?.description || ''} onChange={(event) => setDraft({ ...(draft || {}), description: event.target.value })} disabled={!selectedEditable || saving} maxLength={120} />
              </label>
            </div>

            <DataTable className="permission-matrix-table" columns={[t('module'), t('canView'), t('canModify')]} emptyText={t('noData')}>
              {modules.map((module) => {
                const cell = draft?.permissions?.[module.id] || selectedRole?.permissions?.[module.id] || {};
                return (
                  <tr key={module.id}>
                    <td>
                      <div className="permission-module-name">
                        <strong>{t(module.labelKey)}</strong>
                        <span>{module.id}</span>
                      </div>
                    </td>
                    <td>
                      <label className="permission-checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(cell.view || cell.edit)}
                          disabled={!selectedEditable || saving}
                          onChange={(event) => changePermission(module.id, 'view', event.target.checked)}
                        />
                        <span>{t('canView')}</span>
                      </label>
                    </td>
                    <td>
                      <label className="permission-checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(cell.edit)}
                          disabled={!selectedEditable || saving}
                          onChange={(event) => changePermission(module.id, 'edit', event.target.checked)}
                        />
                        <span>{t('canModify')}</span>
                      </label>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </form>
        </section>
      </div>
    </section>
  );
}
