import React, { useMemo } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { cx } from './cx.js';

const EMPTY_ARRAY = Object.freeze([]);

function dataTableColumnContent(column) {
  return typeof column === 'object' ? column.content : column;
}

function dataTableColumnLabel(column) {
  if (typeof column === 'object') {
    if (column.label !== undefined) return column.label;
    return typeof column.content === 'string' || typeof column.content === 'number' ? column.content : '';
  }
  return typeof column === 'string' || typeof column === 'number' ? column : '';
}

export const DataTable = React.memo(function DataTable({ columns, emptyText, children, className = '' }) {
  const needsCellLabels = useMediaQuery('(max-width: 760px)');
  const rows = useMemo(() => React.Children.toArray(children).filter(Boolean), [children]);
  const columnLabels = useMemo(
    () => (needsCellLabels ? columns.map(dataTableColumnLabel) : EMPTY_ARRAY),
    [columns, needsCellLabels]
  );
  const bodyRows = useMemo(() => {
    if (!needsCellLabels) return rows;
    return rows.map((row) => {
      if (!React.isValidElement(row)) return row;
      const cells = React.Children.toArray(row.props.children).filter(Boolean);
      const labelledCells = cells.map((cell, index) => {
        if (!React.isValidElement(cell) || cell.type !== 'td') return cell;
        return React.cloneElement(cell, {
          ...cell.props,
          'data-label': cell.props['data-label'] ?? columnLabels[index] ?? ''
        });
      });
      return React.cloneElement(row, row.props, labelledCells);
    });
  }, [columnLabels, needsCellLabels, rows]);
  return (
    <div className="table-shell">
      <table className={cx('data-table', className)}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={typeof column === 'object' ? column.key : column || index}>
                {dataTableColumnContent(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{bodyRows}</tbody>
      </table>
      {!rows.length && <div className="empty-state">{emptyText}</div>}
    </div>
  );
});
