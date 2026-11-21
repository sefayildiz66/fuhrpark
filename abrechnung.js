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

function reportTables(sources) {
  function total(rows, read) {
    const values = rows.map(read);
    return values.every(Number.isSafeInteger) ? values.reduce((a, b) => a + b, 0) : null;
  }
  const overview = { title: 'Wochenübersicht', headers: ['Anbieter', 'Position', 'Betrag', 'Bericht'], rows: [] };
  for (const { id, label, fields } of reportSources) {
    const source = sources[id];
    fields.forEach(([key, title], index) => {
      overview.rows.push([index ? '' : label, title, source ? reportMoney(total(source.rows, r => r.values[key])) : '–',
        index ? '' : !source ? 'Fehlt' : source.partial ? 'Teilbericht' : 'Vorhanden']);
    });
  }
  const tables = [overview];
  for (const id of ['40100', 'mypos']) {
    const source = sources[id];
    const taxi = id === '40100';
    const columns = taxi ? [
      ['Karte / App · Anzahl', r => r.counts?.card, false], ['Karte / App', r => r.values.card, true],
      ['Rechnung · Anzahl', r => r.counts?.invoice, false], ['Rechnung', r => r.values.invoice, true]
    ] : [
      ['Kartenzahlungen', r => r.values.revenue, true], ['Gebühren', r => r.values.fee, true],
      ['Nach Gebühren', r => Number.isSafeInteger(r.values.revenue) && Number.isSafeInteger(r.values.fee) ? r.values.revenue - r.values.fee : null, true]
    ];
    const format = (n, monetary) => monetary ? reportMoney(n) : Number.isSafeInteger(n) ? String(n) : '–';
    tables.push({ title: taxi ? 'Taxi 40100 nach Fahrzeug' : 'myPOS nach Kennzeichen oder Terminal',
      headers: [taxi ? 'Fahrzeug' : 'Kennzeichen / Terminal', ...columns.map(c => c[0])],
      rows: (source?.rows || []).map(r => [r.name, ...columns.map(([,read,m]) => format(read(r), m))]),
      sum: source && ['Summe', ...columns.map(([,read,m]) => format(total(source.rows, read), m))],
      note: !source ? 'Kein Bericht für diese Woche.' : source.partial ? 'Teilbericht.' : '' });
  }
  const people = new Map();
  for (const id of ['uber','bolt']) {
    for (const r of sources[id]?.rows || []) {
      const key = r.name.trim().normalize('NFC').replace(/\s+/g,' ').toLocaleLowerCase('de-AT');
      const person = people.get(key) || { name: r.name };
      person[id] = r.values;
      people.set(key, person);
    }
  }
  const fields = [['uber','revenue'],['uber','net'],['bolt','net'],['bolt','cash'],['bolt','remaining']];
  tables.push({ title: 'Fahrerabrechnung', headers: ['Fahrer','Uber Umsatz','Uber Netto','Bolt Verdienst','Bolt bar','Bolt Rest'],
    rows: [...people.values()].sort((a,b) => a.name.localeCompare(b.name,'de')).map(p => [p.name,...fields.map(([id,k]) => reportMoney(p[id]?.[k]))]),
    sum: people.size ? ['Summe', ...fields.map(([id,k]) => reportMoney(sources[id] ? total(sources[id].rows, r => r.values[k]) : null))] : null,
    note: '– = keine Angabe. Der Bolt-Restbetrag ist der Verdienst abzüglich Barinkasso. Eine endgültige Fahrerauszahlung ist damit nicht bestätigt.' });
  return tables;
}

function reportTableHtml(table) {
  const cells = (row, tag) => '<tr>' + row.map(value => '<' + tag + '>' + esc(value) + '</' + tag + '>').join('') + '</tr>';
  return '<section class="card"><h3>' + esc(table.title) + '</h3><div style="overflow-x:auto"><table class="week-table"><thead>' +
    cells(table.headers,'th') + '</thead><tbody>' + table.rows.map(r => cells(r,'td')).join('') + '</tbody>' +
    (table.sum ? '<tfoot>' + cells(table.sum,'td') + '</tfoot>' : '') + '</table></div>' +
    (table.note ? '<p class="s">' + esc(table.note) + '</p>' : '') + '</section>';
}

function reportPdf(week, tables, sources) {
  const period = fmtD(week) + ' bis ' + fmtD(addDays(week, 6));
  const content = [{text:'YILDIZ TAXI KG',bold:true,color:'#735600',characterSpacing:1.6},
    {text:'Wochenabrechnung',fontSize:24,bold:true,margin:[0,5,0,2]}, {text:period,color:'#495461',margin:[0,0,0,8]}];
  for (const table of tables) {
    const row = (cells, style) => cells.map((text,i) => ({text, ...style,
      alignment: i && table.title !== 'Wochenübersicht' ? 'right' : 'left'}));
    const body = [row(table.headers,{bold:true,fillColor:'#233443',color:'white'}), ...table.rows.map((r,i) => row(r,{fillColor:i%2 ? '#f2f5f6':'white'}))];
    if (table.sum) body.push(row(table.sum,{bold:true,fillColor:'#fff1bc'}));
    content.push({text:table.title,bold:true,fontSize:13,margin:[0,9,0,4],pageBreak:table.title==='Fahrerabrechnung'?'before':undefined},
      {table:{headerRows:1,dontBreakRows:true,widths:table.headers.map((_,i) => i===0 ? '*' : 'auto'),body},layout:'noBorders'});
    if (table.note) content.push({text:table.note,fontSize:8,color:'#44515b',margin:[0,4,0,0]});
  }
  content.push({text:'Quellen und Prüfvermerke',fontSize:13,bold:true,margin:[0,12,0,3]});
  for (const {id,label} of reportSources) {
    const s = sources[id];
    content.push({text:label+' · '+(s?.source || 'Kein Bericht'),bold:true,margin:[0,5,0,1]});
    if (s?.note) content.push({text:s.note,fontSize:8,color:'#45535e'});
  }
  return {pageSize:'A4',pageMargins:[32,30,32,36],defaultStyle:{font:'Roboto',fontSize:9,color:'#182736'},
    info:{title:'YILDIZ TAXI KG · Wochenabrechnung '+period},content,
    footer:(page,count)=>({text:period+'   |   '+page+' / '+count,alignment:'right',fontSize:8,color:'#52616d',margin:[0,8,32,0]})};
}

let reportPdfLibraries;
function loadReportPdfLibraries() {
  const load = (file, integrity) => new Promise((resolve,reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/'+file;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  if (!reportPdfLibraries) reportPdfLibraries = load('pdfmake.min.js','sha384-G23ofMOEI98f9UnroUBjDi6Ll55Y5E6bOX4VAMJo0nIbuQRIxzn0g4athUOb58zs')
    .then(() => load('vfs_fonts.js','sha384-pv+tpy6KGI5sKXJDf7oGPdvyVNKYXfAmDYpZ3r3PNP0d13PJQ6YMiiAEndd5sU15')).catch(error => {reportPdfLibraries=null; throw error;});
  return reportPdfLibraries;
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
      const tables = reportTables(data.sources);
      result.innerHTML = '<button class="btn pri" style="margin-bottom:12px" id="report-pdf">PDF herunterladen</button>' +
        tables.map(reportTableHtml).join('') +
        '<details class="card"><summary>Quellen und Prüfvermerke</summary>' + reportSources.map(({id,label}) => {
          const s = data.sources[id];
          return '<p><b>'+label+'</b> · '+esc(s?.source || 'Kein Bericht')+'<br>'+esc(s?.note || '')+'</p>';
        }).join('') + '</details>';
      const button = $('#report-pdf', result);
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = 'PDF wird erstellt …';
        try {
          await loadReportPdfLibraries();
          if (!button.isConnected) return;
          const filename = 'Yildiz-Taxi-Abrechnung_'+data.week+'.pdf';
          const pdf = window.pdfMake.createPdf(reportPdf(data.week,tables,data.sources));
          const blob = await new Promise(resolve => pdf.getBlob(resolve));
          if (!button.isConnected) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url; link.download = filename; link.className = 'btn pri';
          link.textContent = 'PDF herunterladen'; button.replaceWith(link);
          link.click();
          const observer = new MutationObserver(() => {
            if (!link.isConnected) { URL.revokeObjectURL(url); observer.disconnect(); }
          });
          observer.observe(document.body,{childList:true,subtree:true});
        } catch {
          button.disabled = false;
          button.textContent = 'PDF erneut laden';
          toast('PDF konnte nicht erstellt werden.');
        }
      };
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
