// RaportRBR v1.0 — Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const path = require('path');
const { Pool } = require('pg');
const { generateDailyExcel } = require('./report');
const { sendDailyReport } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'raportrbr-dev-secret';

// ─── DATABASE CONNECTION WITH RESILIENCE ─────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

async function testConnection() {
  let retries = 5;
  while (retries > 0) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log('✅ Database connected successfully');
      return true;
    } catch (err) {
      retries--;
      console.error(`❌ DB connection failed (${5-retries}/5): ${err.message}`);
      if (retries > 0) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('❌ Could not connect after 5 attempts');
  return false;
}
testConnection();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Nieprawidłowy token' }); }
}
function managerOnly(req, res, next) {
  if (req.user.role !== 'manager' && req.user.role !== 'supervisor' && req.user.role !== 'viewer') return res.status(403).json({ error: 'Brak uprawnień' });
  next();
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { code, password } = req.body;
  if (!code || !password) return res.status(400).json({ error: 'Podaj kod i hasło' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE UPPER(code) = UPPER($1)', [code.trim()]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Nie znaleziono konta dla tego kodu' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Nieprawidłowe hasło' });
    const token = jwt.sign({ code: user.code, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { code: user.code, name: user.name, role: user.role, mustChangePassword: user.must_change_password } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Hasło min. 4 znaki' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE code = $1', [req.user.code]);
    const user = r.rows[0];
    if (!user.must_change_password) {
      const valid = await bcrypt.compare(currentPassword || '', user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Aktualne hasło nieprawidłowe' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE code=$2', [hash, req.user.code]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Błąd serwera' }); }
});

// ─── USERS ────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, managerOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT code, name, role, must_change_password, created_at FROM users WHERE code != 'ADMIN' ORDER BY name");
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/users', auth, managerOnly, async (req, res) => {
  const { code, name, password, role } = req.body;
  if (!code || !name || !password || password.length < 4) return res.status(400).json({ error: 'Nieprawidłowe dane' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const mustChange = role === 'manager' ? false : true;
    await pool.query('INSERT INTO users (code, name, password_hash, must_change_password, role) VALUES (UPPER($1),$2,$3,$4,$5)', [code, name, hash, mustChange, role || 'worker']);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Konto już istnieje' });
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.put('/api/users/:code/reset-password', auth, managerOnly, async (req, res) => {
  // Check if target user is a manager - only supervisor/admin can reset managers
  const target = await pool.query('SELECT role FROM users WHERE code=$1', [req.params.code]);
  if (target.rows.length > 0 && target.rows[0].role === 'manager') {
    if (req.user.role !== 'supervisor' && req.user.code !== 'ADMIN') {
      return res.status(403).json({ error: 'Tylko kierownik lub admin może resetować hasła menedżerów.' });
    }
  }
  const hash = await bcrypt.hash('zmien123', 10);
  await pool.query('UPDATE users SET password_hash=$1, must_change_password=TRUE WHERE code=$2', [hash, req.params.code]);
  res.json({ success: true });
});

app.delete('/api/users/:code', auth, managerOnly, async (req, res) => {
  // Only supervisor/admin can delete managers
  const target = await pool.query('SELECT role FROM users WHERE code=$1', [req.params.code]);
  if (target.rows.length > 0 && target.rows[0].role === 'manager') {
    if (req.user.role !== 'supervisor' && req.user.code !== 'ADMIN') {
      return res.status(403).json({ error: 'Tylko kierownik lub admin może usuwać menedżerów.' });
    }
  }
  await pool.query('DELETE FROM users WHERE code=$1', [req.params.code]);
  res.json({ success: true });
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/api/reports', auth, async (req, res) => {
  try {
    const isManager = req.user.role === 'manager' || req.user.role === 'supervisor';
    const q = `
      SELECT r.id, r.worker_code, u.name as worker_name, r.report_date::text as date, r.created_at,
        json_agg(json_build_object('id',rl.id,'project',rl.project,'product',rl.product,
          'stage',rl.stage,'contractor',rl.contractor_code,'note',rl.note) ORDER BY rl.id) as lines
      FROM reports r JOIN users u ON r.worker_code=u.code JOIN report_lines rl ON rl.report_id=r.id
      ${isManager ? '' : 'WHERE r.worker_code=$1'}
      GROUP BY r.id, u.name ORDER BY r.report_date DESC, r.created_at DESC`;
    const r = await pool.query(q, isManager ? [] : [req.user.code]);
    // Normalize for frontend
    const rows = r.rows.map(row => ({ ...row, workerLogin: row.worker_code, workerName: row.worker_name }));
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/reports', auth, async (req, res) => {
  const { date, lines } = req.body;
  if (!date || !lines?.length) return res.status(400).json({ error: 'Brak danych' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('INSERT INTO reports (worker_code, report_date) VALUES ($1,$2) RETURNING id', [req.user.code, date]);
    const reportId = r.rows[0].id;

    const skipped = [];
    const saved = [];

    for (const line of lines) {
      // Check if this project+product+stage already exists in DB
      const exists = await client.query(
        `SELECT rl.id FROM report_lines rl
         JOIN reports r ON rl.report_id = r.id
         WHERE rl.project = $1 AND rl.product = $2 AND rl.stage = $3`,
        [line.project, line.product, line.stage]
      );
      if (exists.rows.length > 0) {
        skipped.push({ project: line.project, product: line.product, stage: line.stage });
        continue;
      }
      await client.query(
        'INSERT INTO report_lines (report_id,project,product,stage,contractor_code,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [reportId, line.project, line.product, line.stage, line.contractor || null, line.note || '']
      );
      saved.push(line);
    }

    // If nothing was saved, rollback the empty report
    if (saved.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: false,
        saved: 0,
        skipped,
        message: `Żadna pozycja nie została zapisana — wszystkie etapy były już zaraportowane.`
      });
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      reportId,
      saved: saved.length,
      skipped,
      message: skipped.length > 0
        ? `Zapisano ${saved.length} pozycji. Pominięto ${skipped.length}: ${skipped.map(s => `Łaz. ${s.product} (${s.stage})`).join(', ')}`
        : null
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera' });
  } finally { client.release(); }
});

app.delete('/api/report-lines/:id', auth, async (req, res) => {
  try {
    // Worker can only delete their own lines, manager can delete any
    const isManager = req.user.role === 'manager' || req.user.role === 'supervisor';
    if (isManager) {
      await pool.query('DELETE FROM report_lines WHERE id=$1', [req.params.id]);
    } else {
      // Check ownership — line must belong to a report by this worker
      const r = await pool.query(
        `SELECT rl.id FROM report_lines rl
         JOIN reports r ON rl.report_id = r.id
         WHERE rl.id = $1 AND r.worker_code = $2`,
        [req.params.id, req.user.code]
      );
      if (r.rows.length === 0) return res.status(403).json({ error: 'Brak dostępu do tego wpisu' });
      await pool.query('DELETE FROM report_lines WHERE id=$1', [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.delete('/api/reports/:id', auth, managerOnly, async (req, res) => {
  await pool.query('DELETE FROM reports WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// Manager adds report on behalf of a worker
app.post('/api/reports/as-worker', auth, managerOnly, async (req, res) => {
  const { workerCode, date, lines } = req.body;
  if (!workerCode || !date || !lines?.length) return res.status(400).json({ error: 'Brak danych' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('INSERT INTO reports (worker_code, report_date) VALUES ($1,$2) RETURNING id', [workerCode, date]);
    const reportId = r.rows[0].id;
    const skipped = [], saved = [];
    for (const line of lines) {
      const exists = await client.query(
        `SELECT rl.id FROM report_lines rl JOIN reports r ON rl.report_id = r.id
         WHERE rl.project=$1 AND rl.product=$2 AND rl.stage=$3`,
        [line.project, line.product, line.stage]
      );
      if (exists.rows.length > 0) { skipped.push(line); continue; }
      await client.query(
        'INSERT INTO report_lines (report_id,project,product,stage,contractor_code,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [reportId, line.project, line.product, line.stage, line.contractor || workerCode, line.note || '']
      );
      saved.push(line);
    }
    if (saved.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, saved: 0, skipped, message: 'Wszystkie etapy były już zaraportowane.' });
    }
    await client.query('COMMIT');
    res.json({
      success: true, reportId, saved: saved.length, skipped,
      message: skipped.length > 0
        ? `Zapisano ${saved.length}. Pominięto ${skipped.length}: ${skipped.map(s => `Łaz. ${s.product} (${s.stage})`).join(', ')}`
        : null
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── EMAIL RECIPIENTS ─────────────────────────────────────────────────────────
app.get('/api/email-recipients', auth, managerOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT email FROM email_recipients ORDER BY email');
    res.json(r.rows.map(r => r.email));
  } catch { res.json([]); }
});

app.post('/api/email-recipients', auth, managerOnly, async (req, res) => {
  const { email } = req.body;
  if (!email?.includes('@')) return res.status(400).json({ error: 'Nieprawidłowy email' });
  try {
    await pool.query('INSERT INTO email_recipients (email) VALUES ($1) ON CONFLICT DO NOTHING', [email.trim().toLowerCase()]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.delete('/api/email-recipients/:email', auth, managerOnly, async (req, res) => {
  await pool.query('DELETE FROM email_recipients WHERE email=$1', [decodeURIComponent(req.params.email)]);
  res.json({ success: true });
});

// ─── SEND REPORT ──────────────────────────────────────────────────────────────
app.post('/api/send-report', auth, managerOnly, async (req, res) => {
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  try { await sendReport(date); res.json({ success: true, message: `Raport za ${date} wysłany.` }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

async function sendReport(date) {
  const recResult = await pool.query('SELECT email FROM email_recipients');
  const recipients = recResult.rows.map(r => r.email);
  if (!recipients.length) return;
  const result = await pool.query(`
    SELECT r.id, r.worker_code, u.name as worker_name, r.report_date::text as date,
      json_agg(json_build_object('project',rl.project,'product',rl.product,'stage',rl.stage,'contractor_code',rl.contractor_code,'note',rl.note) ORDER BY rl.id) as lines
    FROM reports r JOIN users u ON r.worker_code=u.code JOIN report_lines rl ON rl.report_id=r.id
    WHERE r.report_date=$1 GROUP BY r.id, u.name`, [date]);
  if (!result.rows.length) return;
  const buffer = await generateDailyExcel(result.rows, date);
  await sendDailyReport(recipients, date, buffer);
  console.log(`Report for ${date} sent to: ${recipients.join(', ')}`);
}

// Codziennie o 23:59
cron.schedule('59 23 * * *', async () => {
  const date = new Date().toISOString().slice(0, 10);
  try { await sendReport(date); }
  catch (err) { console.error('CRON error:', err.message); }
}, { timezone: 'Europe/Warsaw' });


// ─── SEND MAP PDF ─────────────────────────────────────────────────────────────
app.post('/api/send-map-pdf', auth, async (req, res) => {
  const { email, hallName, date, pdfBase64, filename } = req.body;
  if (!email || !pdfBase64) return res.status(400).json({ error: 'Brak danych' });
  try {
    const { sendDailyReport } = require('./mailer');
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('pl-PL', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    await transporter.sendMail({
      from: `"RaportRBR" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `🗺️ RaportRBR — Mapa hali: ${hallName} — ${dateFormatted}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#6C63FF;padding:24px;border-radius:8px 8px 0 0">
            <h1 style="color:white;margin:0;font-size:20px">🗺️ Mapa hali — ${hallName}</h1>
            <p style="color:#d4d0ff;margin:8px 0 0">${dateFormatted}</p>
          </div>
          <div style="background:#f9f9f9;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0">
            <p>W załączniku mapa hali <strong>${hallName}</strong> z aktualnym rozmieszczeniem łazienek i statusem etapów produkcji.</p>
            <p style="color:#888;font-size:12px;margin-top:16px">Wiadomość automatyczna — RaportRBR v1.1 © Ready Bathroom</p>
          </div>
        </div>`,
      attachments: [{
        filename: filename || `mapa_${date}.pdf`,
        content: Buffer.from(pdfBase64, 'base64'),
        contentType: 'application/pdf',
      }],
    });
    res.json({ success: true, message: `PDF wysłany na ${email}` });
  } catch (err) {
    console.error('Send map PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── DATABASE BACKUP ──────────────────────────────────────────────────────────
app.get('/api/backup', auth, managerOnly, async (req, res) => {
  try {
    const [users, reports, lines, recipients] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM reports ORDER BY created_at'),
      pool.query('SELECT * FROM report_lines ORDER BY id'),
      pool.query('SELECT * FROM email_recipients ORDER BY id'),
    ]);

    const backup = {
      version: '1.1',
      exportedAt: new Date().toISOString(),
      data: {
        users: users.rows,
        reports: reports.rows,
        report_lines: lines.rows,
        email_recipients: recipients.rows,
      },
      counts: {
        users: users.rows.length,
        reports: reports.rows.length,
        report_lines: lines.rows.length,
      }
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="raportrbr_backup_${new Date().toISOString().slice(0,10)}.json"`);
    res.json(backup);
    console.log(`Backup exported: ${lines.rows.length} report lines`);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DATABASE RESTORE ─────────────────────────────────────────────────────────
app.post('/api/restore', auth, managerOnly, async (req, res) => {
  const { data } = req.body;
  if (!data?.reports || !data?.report_lines) return res.status(400).json({ error: 'Nieprawidłowy format backupu' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Restore reports (skip existing)
    let added = 0;
    for (const r of data.reports) {
      const exists = await client.query('SELECT id FROM reports WHERE id=$1', [r.id]);
      if (exists.rows.length === 0) {
        await client.query(
          'INSERT INTO reports (id, worker_code, report_date, created_at) VALUES ($1,$2,$3,$4)',
          [r.id, r.worker_code, r.report_date, r.created_at]
        );
        added++;
      }
    }
    
    // Restore report lines (skip existing)
    let linesAdded = 0;
    for (const l of data.report_lines) {
      const exists = await client.query('SELECT id FROM report_lines WHERE id=$1', [l.id]);
      if (exists.rows.length === 0) {
        await client.query(
          'INSERT INTO report_lines (id, report_id, project, product, stage, contractor_code, note, photos, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [l.id, l.report_id, l.project, l.product, l.stage, l.contractor_code, l.note||'', l.photos||null, l.created_at]
        );
        linesAdded++;
      }
    }
    
    await client.query('COMMIT');
    res.json({ success: true, message: `Przywrócono ${added} raportów, ${linesAdded} wpisów` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
// index.html is in the same directory as server.js
const publicPath = path.join(__dirname);
app.use(express.static(publicPath));

// PWA files
app.get('/manifest.json', (req, res) => res.sendFile(path.join(publicPath, 'manifest.json')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(publicPath, 'sw.js'));
});
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(publicPath, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(publicPath, 'icon-512.png')));

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as reports FROM reports');
    const r2 = await pool.query('SELECT COUNT(*) as lines FROM report_lines');
    res.json({
      status: 'ok',
      version: '1.1',
      time: new Date(),
      db: {
        connected: true,
        reports: parseInt(r.rows[0].reports),
        lines: parseInt(r2.rows[0].lines),
      }
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: { connected: false, error: err.message } });
  }
});

app.listen(PORT, () => console.log(`RaportRBR v1.0 running on port ${PORT}`));
