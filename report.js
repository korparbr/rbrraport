const xl = require('excel4node');

const STAGES = {
  "2.1": "2.1 — Wyprodukowanie profilów ścian i sufitu",
  "4": "4 — Skręcanie", "5": "5 — Nawożenie",
  "6.1": "6.1 — Szlifowanie", "6.2": "6.2 — Osadzanie rurek",
  "7": "7 — Kosmetyka Grób", "7.1": "7.1 — Izolowanie", "7.2": "7.2 — Izolacja dachu",
  "8.1": "8.1 — Montaż sanitarny Grób", "8.2": "8.2 — Montaż elektryczny Grób",
  "9": "9 — Szpachlowanie", "9.1": "9.1 — Stelaż", "9.2": "9.2 — Rekuperator",
  "10": "10 — Malowanie i tapetowanie",
  "11.1": "11.1 — Ceramika ściany", "11.2": "11.2 — Ceramika podłogi",
  "13.1": "13.1 — Fugowanie", "13.2": "13.2 — Silikonowanie",
  "14": "14 — Montaż wentylacji",
  "15.0": "15.0 — Lustro", "15.1": "15.1 — Montaż elementów sanitarnych",
  "15.2": "15.2 — Montaż elementów elektro", "15.3": "15.3 — Kosmetyka Fain",
  "16": "16 — Tynkowanie ścian zewnętrznych",
  "16.1": "16.1 — Test szczelności wody", "16.2": "16.2 — Oznaczenie poziomu +1m",
  "17": "17 — Czyszczenie", "18": "18 — Kontrola jakości",
  "19": "19 — Pakowanie", "21": "21 — Załadunek"
};

function formatDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('pl-PL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

async function generateDailyExcel(reports, date) {
  const wb = new xl.Workbook({ defaultFont: { name: 'Calibri', size: 11 } });

  const hStyle = wb.createStyle({
    font: { bold: true, color: '#FFFFFF', size: 12 },
    fill: { type: 'pattern', patternType: 'solid', fgColor: '#6C63FF' },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: { left: { style: 'thin' }, right: { style: 'thin' }, top: { style: 'thin' }, bottom: { style: 'thin' } },
  });
  const subStyle = wb.createStyle({
    font: { bold: true, size: 11, color: '#FFFFFF' },
    fill: { type: 'pattern', patternType: 'solid', fgColor: '#3D3A6E' },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: { left: { style: 'thin' }, right: { style: 'thin' }, top: { style: 'thin' }, bottom: { style: 'thin' } },
  });
  const cellStyle = wb.createStyle({
    alignment: { vertical: 'center', wrapText: true },
    border: { left: { style: 'thin' }, right: { style: 'thin' }, top: { style: 'thin' }, bottom: { style: 'thin' } },
  });
  const altStyle = wb.createStyle({
    alignment: { vertical: 'center', wrapText: true },
    fill: { type: 'pattern', patternType: 'solid', fgColor: '#F5F4FF' },
    border: { left: { style: 'thin' }, right: { style: 'thin' }, top: { style: 'thin' }, bottom: { style: 'thin' } },
  });

  // Group by project
  const byProject = {};
  reports.forEach(r => {
    (r.lines || []).forEach(line => {
      if (!byProject[line.project]) byProject[line.project] = [];
      byProject[line.project].push({
        product: line.product,
        stage: STAGES[line.stage] || line.stage,
        contractor: line.contractor_code || '—',
        worker: r.worker_name,
        note: line.note || '',
      });
    });
  });

  const projects = Object.keys(byProject).sort();
  const totalLines = reports.reduce((s, r) => s + (r.lines?.length || 0), 0);

  // Summary sheet
  const ws = wb.addWorksheet('Podsumowanie');
  ws.column(1).setWidth(30); ws.column(2).setWidth(20);
  ws.cell(1, 1, 1, 2, true).string(`RaportRBR — ${formatDate(date)}`).style(hStyle);
  ws.row(1).setHeight(36);
  ws.cell(3, 1).string('Raportów').style(subStyle); ws.cell(3, 2).number(reports.length).style(cellStyle);
  ws.cell(4, 1).string('Pozycji łącznie').style(subStyle); ws.cell(4, 2).number(totalLines).style(cellStyle);
  ws.cell(5, 1).string('Projektów').style(subStyle); ws.cell(5, 2).number(projects.length).style(cellStyle);
  let row = 7;
  ws.cell(row, 1).string('Projekt').style(hStyle); ws.cell(row, 2).string('Pozycji').style(hStyle); row++;
  projects.forEach((p, i) => {
    const s = i % 2 === 0 ? cellStyle : altStyle;
    ws.cell(row, 1).string(`Projekt ${p}`).style(s);
    ws.cell(row, 2).number(byProject[p].length).style(s);
    row++;
  });

  // Per-project sheets
  projects.forEach(projectId => {
    const lines = byProject[projectId].sort((a, b) => a.product - b.product);
    const wsP = wb.addWorksheet(`Projekt ${projectId}`);
    wsP.column(1).setWidth(12); wsP.column(2).setWidth(36); wsP.column(3).setWidth(20);
    wsP.column(4).setWidth(25); wsP.column(5).setWidth(30);
    wsP.cell(1, 1, 1, 5, true).string(`Projekt ${projectId} — ${formatDate(date)}`).style(hStyle);
    wsP.row(1).setHeight(30);
    ['Nr produktu', 'Etap', 'Wykonawca', 'Pracownik', 'Uwagi'].forEach((h, i) => {
      wsP.cell(2, i + 1).string(h).style(subStyle);
    });
    wsP.row(2).setHeight(22);
    lines.forEach((line, i) => {
      const s = i % 2 === 0 ? cellStyle : altStyle;
      const r = i + 3;
      wsP.cell(r, 1).number(line.product).style(s);
      wsP.cell(r, 2).string(line.stage).style(s);
      wsP.cell(r, 3).string(line.contractor).style(s);
      wsP.cell(r, 4).string(line.worker).style(s);
      wsP.cell(r, 5).string(line.note).style(s);
      wsP.row(r).setHeight(20);
    });
  });

  return wb.writeToBuffer();
}

module.exports = { generateDailyExcel };
