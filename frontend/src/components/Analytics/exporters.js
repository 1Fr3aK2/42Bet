// Formatting and export files of the analytics dashboard, all built in the
// browser from the data already loaded: CSV (the bets), JSON (everything
// shown) and PDF (a text report).

export const fmt = (n) => Number(n).toLocaleString('en-US');
export const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
export const price = (n) =>
  n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// "YYYY-MM-DD HH:MM" in local time.
function stamp(iso) {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16).replace('T', ' ');
}

const pad = (value, width, right = false) =>
  right ? String(value).padStart(width) : String(value).padEnd(width);

export function download(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function betsToCsv(bets) {
  const header = ['id', 'placed_at', 'settled_at', 'coin', 'direction', 'amount', 'entry_price',
    'exit_price', 'status', 'payout', 'profit'];
  const rows = bets.map((b) => [b.id, b.createdAt, b.settledAt, b.coin, b.direction, b.amount,
    b.entryPrice, b.exitPrice, b.status, b.payout, b.status === 'active' ? '' : b.payout - b.amount]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

// Text lines of the PDF report (at most 80 characters, plain ASCII).
export function reportLines({ data, filters, username }) {
  const s = data.summary;
  const rate = (r) => (r === null ? '-' : `${r} %`);
  return [
    'Transcendence - betting analytics',
    '',
    `User:       ${username ?? '-'}`,
    `Period:     ${filters.from || 'first bet'} to ${filters.to || 'today'}`,
    `Coin:       ${filters.coin || 'all'}`,
    `Direction:  ${filters.direction || 'all'}`,
    `Generated:  ${stamp(new Date().toISOString())}`,
    '',
    'SUMMARY',
    `  Balance    ${pad(fmt(s.balance), 10, true)} T$`,
    `  Profit     ${pad(signed(s.profit), 10, true)} T$`,
    `  Win rate   ${pad(rate(s.winRate), 10, true)}    (${s.won} won, ${s.lost} lost, ${s.refunded} refunded)`,
    `  Bets       ${pad(s.bets, 10, true)}    (${s.active} active)`,
    `  Wagered    ${pad(fmt(s.wagered), 10, true)} T$`,
    `  Paid out   ${pad(fmt(s.paidOut), 10, true)} T$`,
    '',
    'BY COIN AND DIRECTION',
    ...[...data.byCoin, ...data.byDirection].map((g) =>
      `  ${pad(g.name, 6)} ${pad(g.bets, 4, true)} bets   win rate ${pad(rate(g.winRate), 7, true)}   profit ${pad(signed(g.profit), 8, true)} T$`),
    '',
    'PROFIT BY DAY',
    ...data.profitByDay.map((d) => `  ${d.day}   ${pad(d.bets, 4, true)} bets   ${pad(signed(d.profit), 8, true)} T$`),
    '',
    `BETS (${data.bets.length}, newest first)`,
    `  ${pad('Placed', 17)} ${pad('Coin', 4)} ${pad('Dir', 4)} ${pad('Stake', 6, true)} ${pad('Entry', 10, true)} ${pad('Exit', 10, true)} ${pad('Result', 8)} ${pad('Profit', 6, true)}`,
    ...data.bets.map((b) =>
      `  ${pad(stamp(b.createdAt), 17)} ${pad(b.coin, 4)} ${pad(b.direction, 4)} ${pad(b.amount, 6, true)} ${pad(price(b.entryPrice), 10, true)} ${pad(price(b.exitPrice), 10, true)} ${pad(b.status, 8)} ${pad(b.status === 'active' ? '-' : signed(b.payout - b.amount), 6, true)}`),
  ];
}

// A minimal PDF writer: plain text in Courier on A4 pages. It is enough for a
// report and avoids adding a PDF library to the project.
export function textToPdf(lines) {
  const width = 595;
  const height = 842;
  const margin = 50;
  const lineHeight = 14;
  const perPage = Math.floor((height - 2 * margin) / lineHeight);
  const escape = (text) => text.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?');

  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));

  // Objects 1-3: catalog, page tree, font; then one page + one content stream per page.
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];
  const pageIds = [];
  for (const pageLines of pages) {
    const text = pageLines
      .map((line, j) => `1 0 0 1 ${margin} ${height - margin - j * lineHeight} Tm (${escape(line)}) Tj`)
      .join('\n');
    const stream = `BT /F1 10 Tf\n${text}\nET`;
    const pageId = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(pageId);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // Everything is ASCII, so string lengths are byte offsets.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: 'application/pdf' });
}
