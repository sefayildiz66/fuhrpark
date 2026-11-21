const REPORT_APP = 'https://yildiz-mypos-haftalik.floot.app';
const reportSources = [
  { id: 'uber', label: 'Uber', fields: [['revenue', 'Umsatz'], ['net', 'Netto']] },
  { id: 'bolt', label: 'Bolt', fields: [['net', 'Nettoverdienst'], ['cash', 'Bar kassiert'], ['remaining', 'Restbetrag']] },
  { id: '40100', label: 'Taxi 40100', fields: [['card', 'Karte / App'], ['invoice', 'Rechnungsfahrten']] },
  { id: 'mypos', label: 'myPOS', fields: [['revenue', 'Kartenzahlungen'], ['fee', 'Gebühren']] }
];

function reportMonday(day) {
  const offset = (new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7;
  return addDays(day, -offset);
}

function reportMoney(value) {
  return Number.isSafeInteger(value) ? money(value / 100) : '–';
}

function reportValues(fields, values) {
  return '<dl class="report-values">' + fields.map(([key, label]) =>
    '<div><dt>' + esc(label) + '</dt><dd>' + reportMoney(values[key]) + '</dd></div>'
  ).join('') + '</dl>';
}

function reportOverview(sources) {
  return reportSources.map(({ id, label, fields }) => {
    const source = sources[id];
    if (!source) return '<section class="card"><h3>' + label + '</h3><div class="s">Kein Bericht für diese Woche.</div></section>';
    const totals = {};
    for (const [key] of fields) {
      if (source.rows.every(row => Number.isSafeInteger(row.values[key]))) {
        totals[key] = source.rows.reduce((sum, row) => sum + row.values[key], 0);
      }
    }
    const rows = source.rows.map(row => '<div class="report-line"><strong>' + esc(row.name) + '</strong>' + reportValues(fields, row.values) + '</div>').join('');
    return '<section class="card"><h3>' + label + (source.partial ? ' · Teilbericht' : '') + '</h3>' +
      reportValues(fields, totals) + '<details><summary>Einzelpositionen (' + source.rows.length + ')</summary>' + rows +
      '<p class="s">' + esc(source.source) + ' · ' + fmtDT(source.updatedAt) + '</p><p class="s">' + esc(source.note) + '</p></details></section>';
  }).join('');
}

function reportDrivers(sources) {
  const byName = new Map();
  const keyOf = name => name.trim().replace(/\s+/g, ' ').normalize('NFC').toLocaleLowerCase('de-AT');
  const registry = new Map();
  for (const driver of S.drivers) {
    const key = keyOf(driver.name);
    registry.set(key, registry.has(key) ? null : driver.name);
  }
  for (const { id, label, fields } of reportSources.slice(0, 2)) {
    for (const row of sources[id]?.rows || []) {
      const key = keyOf(row.name);
      const driver = byName.get(key) || { name: registry.get(key) || row.name, sections: [] };
      driver.sections.push('<strong>' + label + '</strong>' + reportValues(fields, row.values));
      byName.set(key, driver);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')).map(driver =>
    '<details class="card"><summary>' + esc(driver.name) + '</summary>' + driver.sections.join('') + '</details>'
  ).join('');
}

async function viewAbrechnung(main) {
  const viennaDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let week = S.reportWeek || addDays(reportMonday(viennaDay), -7);
  main.innerHTML = '<h2>Abrechnung</h2><section class="card"><label class="f">Abrechnungswoche<input type="date" id="report-date"></label>' +
    '<div class="report-nav"><button class="btn sm" data-step="-7" aria-label="Vorwoche">◀</button><strong id="report-range"></strong><button class="btn sm" data-step="7" aria-label="Folgewoche">▶</button></div></section>' +
    '<div id="report-result" aria-live="polite"></div><a class="btn" target="_blank" rel="noopener noreferrer" href="' + REPORT_APP + '">Abrechnung in Floot öffnen</a>';
  const date = $('#report-date', main);
  const range = $('#report-range', main);
  const result = $('#report-result', main);
  let requestNumber = 0;
  async function load() {
    const request = ++requestNumber;
    S.reportWeek = week;
    date.value = week;
    range.textContent = fmtD(week) + ' bis ' + fmtD(addDays(week, 6));
    result.innerHTML = '<div class="card">Berichte werden geladen …</div>';
    try {
      const ticket = await sb.rpc('request_report_ticket', { p_week: week });
      if (ticket.error || !ticket.data) throw Error();
      const response = await fetch(REPORT_APP + '/_api/fuhrpark-report', {
        method: 'POST', credentials: 'omit', body: ticket.data
      });
      if (!response.ok) throw Error();
      const data = await response.json();
      if (request !== requestNumber || !result.isConnected) return;
      if (data.week !== week || !data.sources) throw Error();
      const drivers = reportDrivers(data.sources);
      result.innerHTML = reportOverview(data.sources) + (drivers ? '<h3>Fahrerabrechnung</h3>' + drivers : '') +
        '<p class="s">Taxi 40100 wird nach Fahrzeug ausgewiesen, myPOS nach Kennzeichen oder Terminal. Kartenzahlungen werden nicht nochmals zum Umsatz addiert.</p>';
    } catch {
      if (request !== requestNumber || !result.isConnected) return;
      result.innerHTML = '<div class="card">Die Wochenberichte konnten nicht geladen werden. <button class="btn sm">Erneut versuchen</button></div>';
      $('button', result).onclick = load;
    }
  }
  date.onchange = () => { if (date.value) { week = reportMonday(date.value); load(); } };
  $$('[data-step]', main).forEach(button => button.onclick = () => { week = addDays(week, Number(button.dataset.step)); load(); });
  await load();
}
