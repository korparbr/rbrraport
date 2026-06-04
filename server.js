// RaportRBR v1.0 — Backend
// require('dotenv').config();
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
console.log('ALL ENV:', JSON.stringify(Object.keys(process.env)));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Brak uprawnień' });
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
  const hash = await bcrypt.hash('zmien123', 10);
  await pool.query('UPDATE users SET password_hash=$1, must_change_password=TRUE WHERE code=$2', [hash, req.params.code]);
  res.json({ success: true });
});

app.delete('/api/users/:code', auth, managerOnly, async (req, res) => {
  await pool.query('DELETE FROM users WHERE code=$1', [req.params.code]);
  res.json({ success: true });
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/api/reports', auth, async (req, res) => {
  try {
    const isManager = req.user.role === 'manager';
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
    for (const line of lines) {
      await client.query('INSERT INTO report_lines (report_id,project,product,stage,contractor_code,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [reportId, line.project, line.product, line.stage, line.contractor || null, line.note || '']);
    }
    await client.query('COMMIT');
    res.json({ success: true, reportId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Błąd serwera' });
  } finally { client.release(); }
});

app.delete('/api/reports/:id', auth, managerOnly, async (req, res) => {
  await pool.query('DELETE FROM reports WHERE id=$1', [req.params.id]);
  res.json({ success: true });
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

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
const publicPath = path.join(__dirname);
app.use(express.static(publicPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0', time: new Date() }));

app.listen(PORT, () => console.log(`RaportRBR v1.0 running on port ${PORT}`));
