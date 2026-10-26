import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../../shared/api.js';
import { displayDataValue, formatCopy, formatStatNumber, formatTime, localizeError } from '../../shared/format.js';
import { Avatar } from '../../shared/member/Avatar.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

function auditStatusLabel(status, t) {
  if (status === 'not_in_guild') return t('discordAuditNotInGuild');
  if (status === 'missing_role') return t('discordAuditMissingRole');
  if (status === 'check_failed') return t('discordAuditCheckFailed');
  if (status === 'valid') return t('discordAuditValid');
  return status || '-';
}

function auditStatusTone(status) {
  if (status === 'not_in_guild') return 'closed';
  if (status === 'missing_role') return 'pending';
  if (status === 'check_failed') return 'neutral';
  if (status === 'valid') return 'active';
  return 'neutral';
}

function roleListText(roles, fallbackRoleIds = [], roleIdLabel = 'ID') {
  const values = (Array.isArray(roles) && roles.length ? roles : fallbackRoleIds)
    .map((role) => {
      if (!role || typeof role !== 'object') return String(role || '').trim();
      const id = String(role.id || '').trim();
      const name = String(role.name || '').trim();
      if (name && id && name !== id) return `${name} (${roleIdLabel}: ${id})`;
      return name || id;
    })
    .filter(Boolean);
  return values.length ? values.join(', ') : '-';
}

function CandidateMemberCell({ member }) {
  return (
    <div className="member-name-cell member-name-cell-with-steam">
      <Avatar member={member} />
      <div className="member-name-text member-name-text-with-steam">
        <span className="strong-cell">{member.displayName || member.steamNickname || member.steamId || '-'}</span>
        <small className="muted-text">{member.squadName || '-'}</small>
        <small className="mono break-cell">{member.steamId || '-'}</small>
      </div>
    </div>
  );
}

export default function DepartedMembersView({ lang, t, setToast, canEdit = false, canDelete = false, onMembersUpdated = null }) {
  const [payload, setPayload] = useState({ candidates: [], summary: {}, configuration: {} });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const next = await api('/api/discord/member-audit');
      setPayload(next);
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  async function runAudit() {
    if (!canEdit || running) return;
    setRunning(true);
    setError('');
    try {
      const next = await api('/api/discord/member-audit/run', { method: 'POST', body: {} });
      setPayload(next);
      const summary = next.summary || {};
      setToast?.(formatCopy(t('discordAuditRunDone'), {
        checked: formatStatNumber(summary.checked || 0, lang),
        flagged: formatStatNumber(summary.currentFlagged ?? summary.flagged ?? 0, lang)
      }));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setRunning(false);
    }
  }

  async function deleteMember() {
    const target = deleteTarget;
    if (!canDelete || !target?.member?.id || deletingId) return;
    setDeletingId(target.member.id);
    setError('');
    try {
      await api(`/api/members/${encodeURIComponent(target.member.id)}?response=minimal`, { method: 'DELETE' });
      setPayload((current) => ({
        ...current,
        candidates: (current.candidates || []).filter((item) => item.member?.id !== target.member.id),
        summary: {
          ...(current.summary || {}),
          currentFlagged: Math.max(0, Number(current.summary?.currentFlagged || 0) - 1)
        }
      }));
      setDeleteTarget(null);
      setToast?.(formatCopy(t('departedMemberDeleted'), { name: target.member.displayName || target.member.steamId || '-' }));
      await onMembersUpdated?.();
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setDeletingId('');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const candidates = payload.candidates || [];
  const summary = payload.summary || {};
  const configuration = payload.configuration || {};
  const configured = Boolean(configuration.configured);
  const metricItems = useMemo(() => [
    [t('departedMemberCurrentFlagged'), summary.currentFlagged ?? candidates.length],
    [t('discordAuditNotInGuild'), summary.notInGuild || 0],
    [t('discordAuditMissingRole'), summary.missingRole || 0],
    [t('discordAuditLastChecked'), summary.lastRunAt ? formatTime(summary.lastRunAt, lang) : '-']
  ], [candidates.length, lang, summary, t]);
  const columns = useMemo(() => [
    t('memberName'),
    t('discordId'),
    t('departedMemberReason'),
    t('departedMemberRoles'),
    t('departedMemberMarkedAt'),
    t('manage')
  ], [t]);

  if (loading) return <PageLoadingState title={t('navDepartedMembers')} t={t} />;

  return (
    <section className="page-stack departed-members-page">
      <div className="page-title-row">
        <div>
          <span className="eyebrow">{t('navMembers')}</span>
          <h2>{t('departedMembersTitle')}</h2>
          <p>{t('departedMembersHint')}</p>
        </div>
        <div className="toolbar-compact">
          <button type="button" className="ghost-button" onClick={load} disabled={running || Boolean(deletingId)}>
            <RefreshCw size={16} />
            <span>{t('refresh')}</span>
          </button>
          {canEdit && (
            <button type="button" className="primary-button" onClick={runAudit} disabled={running || Boolean(deletingId)}>
              <RefreshCw size={16} className={cx(running && 'spin-icon')} />
              <span>{running ? t('discordAuditRunning') : t('discordAuditRun')}</span>
            </button>
          )}
        </div>
      </div>

      {!configured && (
        <Alert tone="warning">
          {t('discordAuditNotConfigured')}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="info-grid departed-member-metrics">
        {metricItems.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{typeof value === 'number' ? formatStatNumber(value, lang) : value}</dd>
          </div>
        ))}
      </div>

      <DataTable columns={columns} emptyText={t('departedMembersEmpty')} className="departed-members-table">
        {candidates.map((item) => {
          const member = item.member || {};
          const audit = item.audit || {};
          return (
            <tr key={member.id || member.discordId || member.steamId}>
              <td><CandidateMemberCell member={member} /></td>
              <td>
                <div className="stacked-cell">
                  <span className="mono break-cell">{member.discordId || '-'}</span>
                  <small>{displayDataValue(member.discordName, t)}</small>
                </div>
              </td>
              <td>
                <span className={cx('status-badge', auditStatusTone(audit.status))}>
                  {auditStatusLabel(audit.status, t)}
                </span>
                {audit.error && <small className="danger-text break-cell">{audit.error}</small>}
              </td>
              <td>
                <div className="stacked-cell">
                  <small>{t('departedMemberExpectedRoles')}</small>
                  <span className="mono break-cell">{roleListText(audit.expectedRoles, audit.expectedRoleIds, t('departedMemberRoleId'))}</span>
                  <small>{t('departedMemberActualRoles')}</small>
                  <span className="mono break-cell">{roleListText(audit.actualRoles, audit.actualRoleIds, t('departedMemberRoleId'))}</span>
                </div>
              </td>
              <td>
                <div className="stacked-cell">
                  <span>{formatTime(audit.missingSince, lang) || '-'}</span>
                  <small>{formatCopy(t('discordAuditCheckedAt'), { time: formatTime(audit.checkedAt, lang) || '-' })}</small>
                </div>
              </td>
              <td>
                <button
                  type="button"
                  className="action-button danger"
                  disabled={!canDelete || !member.canManage || Boolean(deletingId)}
                  onClick={() => setDeleteTarget(item)}
                >
                  <Trash2 size={16} />
                  <span>{t('deleteMember')}</span>
                </button>
              </td>
            </tr>
          );
        })}
      </DataTable>

      {deleteTarget && (
        <ModalFrame onClose={() => setDeleteTarget(null)} labelledBy="departed-member-delete-title">
          <div className="modal-title">
            <div>
              <h3 id="departed-member-delete-title">{t('confirmDeleteMemberTitle')}</h3>
              <span className="modal-subtitle">{deleteTarget.member?.displayName || deleteTarget.member?.steamId || '-'}</span>
            </div>
            <button type="button" className="icon-button" onClick={() => setDeleteTarget(null)} title={t('close')} disabled={Boolean(deletingId)}>
              <X size={18} />
            </button>
          </div>
          <Alert tone="warning">
            <AlertTriangle size={18} />
            <span>{formatCopy(t('departedMemberDeleteWarning'), { name: deleteTarget.member?.displayName || deleteTarget.member?.steamId || '-' })}</span>
          </Alert>
          <div className="modal-actions">
            <span />
            <button type="button" className="ghost-button" onClick={() => setDeleteTarget(null)} disabled={Boolean(deletingId)}>{t('cancel')}</button>
            <button type="button" className="action-button danger" onClick={deleteMember} disabled={!canDelete || Boolean(deletingId)}>
              <Trash2 size={18} />
              <span>{deletingId ? t('saving') : t('confirm')}</span>
            </button>
          </div>
        </ModalFrame>
      )}
    </section>
  );
}
