// The approved July 2026 leaderboard layout, kept independent of legacy runtime.
export const LEADERBOARD_STYLE = `
  @page { size: A4 landscape; margin: 12mm; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f5f7fb;
    color: #172033;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", "Noto Sans Thai", "Noto Sans CJK KR", "Segoe UI", Arial, sans-serif;
    font-size: 12px;
    line-height: 1.48;
  }
  .sheet { max-width: 1260px; margin: 0 auto; padding: 0; }
  .cover {
    padding: 18px 20px 16px;
    margin-bottom: 12px;
    border-radius: 16px;
    color: white;
    background: linear-gradient(135deg, #5263d8, #5f8f86);
    box-shadow: 0 9px 24px rgba(31,42,68,.12);
    break-inside: avoid;
    page-break-inside: avoid;
  }
  h1 { margin: 0; font-size: 21px; line-height: 1.25; letter-spacing: 0; overflow-wrap: anywhere; }
  h2 { margin: 0 0 8px; font-size: 14px; line-height: 1.3; overflow-wrap: anywhere; }
  .cover-brand { margin-top: 5px; font-size: 12px; font-weight: 700; }
  .ranking-page { page-break-before: always; break-before: page; }
  .ranking-heading {
    margin: 0 0 12px;
    padding: 9px 12px;
    border: 1px solid #d8e0ee;
    border-radius: 14px;
    background: linear-gradient(#fff, #fff) padding-box, linear-gradient(135deg, #d8e0ee, #eef5f2) border-box;
    text-align: center;
    page-break-after: avoid;
    break-after: avoid;
  }
  .ranking-title {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    max-width: 100%;
    margin: 0;
    padding: 7px 16px;
    border: 1px solid #cbd7ea;
    border-radius: 999px;
    color: #273e91;
    background: linear-gradient(135deg, #eef3ff, #f4fbf8);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.72);
    font-size: 19px;
    font-weight: 850;
    line-height: 1.25;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }
  .ranking-title::before {
    content: "";
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #5f8f86;
    box-shadow: 0 0 0 4px rgba(95,143,134,.13);
  }
  .ranking-title span { min-width: 0; }
  .meta-chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .chip {
    min-width: 0;
    max-width: 100%;
    padding: 5px 9px;
    border: 1px solid rgba(255,255,255,.42);
    border-radius: 999px;
    background: rgba(255,255,255,.16);
    font-size: 11px;
    color: rgba(255,255,255,.94);
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
  .stat, .section {
    min-width: 0;
    border: 1px solid #c7d1e1;
    border-radius: 12px;
    background: #f8fafd;
    padding: 10px;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .stat label, .label {
    display: block;
    margin-bottom: 4px;
    color: #6f7c95;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }
  .stat strong { display: block; color: #172033; font-size: 17px; line-height: 1.2; overflow-wrap: anywhere; }
  .section { margin-bottom: 10px; }
  .section.result { background: #f4fbf8; border-color: #b7d8ca; }
  .kv-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .kv { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
  .kv strong { display: block; color: #172033; font-size: 12px; }
  .leaderboard {
    margin-bottom: 10px;
    border: 1.4px solid transparent;
    border-radius: 14px;
    background: linear-gradient(#fff, #fff) padding-box, linear-gradient(135deg, #d8e0ee, #edf2f8) border-box;
    box-shadow: inset 0 0 0 1px #f5f8fc, 0 5px 18px rgba(31,42,68,.08);
    break-inside: auto;
    page-break-inside: auto;
  }
  .leaderboard-table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
  .leaderboard-table thead { display: table-header-group; }
  .leaderboard-table th {
    padding: 8px 5px;
    border-bottom: 1px solid #dfe7f2;
    background: #f8fafd;
    color: #6f7c95;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: .02em;
    text-align: center;
    text-transform: uppercase;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .leaderboard-table td {
    padding: 7px 5px;
    border-bottom: 1px solid #edf1f7;
    color: #172033;
    font-size: 10px;
    text-align: center;
    vertical-align: middle;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .leaderboard-table tr { break-inside: avoid; page-break-inside: avoid; }
  .leaderboard-table tbody tr:nth-child(odd) td { background: #fcfdff; }
  .leaderboard-table tbody tr:last-child td { border-bottom: 0; }
  .leaderboard-table tr.rank-gold td { border-top: 1.6px solid #e1b84e; border-bottom-color: #efd98f; background: #fffaf0; }
  .leaderboard-table tr.rank-silver td { border-top: 1.6px solid #aab4c5; border-bottom-color: #d5dbe5; background: #f8fafc; }
  .leaderboard-table tr.rank-bronze td { border-top: 1.6px solid #c9874e; border-bottom-color: #e6c0a0; background: #fff7ef; }
  .leaderboard-table tr.rank-gold td:first-child { box-shadow: inset 4px 0 0 #d8a828; }
  .leaderboard-table tr.rank-silver td:first-child { box-shadow: inset 4px 0 0 #9aa6ba; }
  .leaderboard-table tr.rank-bronze td:first-child { box-shadow: inset 4px 0 0 #b66e38; }
  .leaderboard-rank { width: 36px; color: #5263d8; font-weight: 900; }
  .leaderboard-primary-stat {
    width: 66px;
    color: #273e91;
    background: #eef3ff !important;
    font-size: 12px !important;
    font-weight: 900;
    box-shadow: inset 2px 0 0 #5263d8, inset -2px 0 0 #5263d8;
  }
  .leaderboard-table th.leaderboard-primary-stat { color: #fff; background: #5263d8 !important; border-bottom-color: #5263d8; }
  .leaderboard-player { width: 174px; text-align: left !important; }
  .leaderboard-squad { width: 82px; }
  .leaderboard-online { width: 70px; }
  .leaderboard-stat { width: 52px; }
  .leaderboard-wide-stat { width: 62px; }
  .leaderboard-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .leaderboard-identity > div { min-width: 0; flex: 1 1 0; }
  .avatar-wrap { position: relative; flex: 0 0 34px; width: 34px; height: 34px; }
  .avatar-fallback {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    border: 1px solid #c7d1e1;
    background: #edf2f8;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #5263d8;
    font-weight: 800;
  }
  .medal {
    position: absolute;
    top: -6px;
    right: -7px;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,.96);
    color: #172033;
    font-size: 11px;
    font-weight: 900;
    line-height: 1;
    box-shadow: 0 2px 6px rgba(31,42,68,.14);
  }
  .medal-gold { background: #f4c84f; }
  .medal-silver { background: #d8dee8; }
  .medal-bronze { background: #d79a64; color: #fff; }
  .leaderboard-name { min-width: 0; font-weight: 800; color: #172033; font-size: 10px; overflow-wrap: anywhere; word-break: break-word; }
  .leaderboard-steam { color: #56627a; font-size: 10px; line-height: 1.35; overflow-wrap: anywhere; word-break: break-all; }
  .sub { color: #56627a; font-size: 11px; overflow-wrap: anywhere; word-break: break-word; }
  .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
  .report-note { margin: 7px 0; color: #6f7c95; font-size: 10px; overflow-wrap: anywhere; }
  .empty { padding: 22px; border: 1px dashed #cfd8e8; border-radius: 14px; background: #fff; text-align: center; color: #6f7c95; }
  .footer { margin-top: 10px; color: #6f7c95; font-size: 10px; overflow-wrap: anywhere; }
  @media print { body { background: #fff; } .cover, .leaderboard { box-shadow: none; } }
`;
