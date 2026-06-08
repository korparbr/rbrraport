// RaportRBR v1.2 - Backend
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

const MAP_HALLS = {
  betonowanie: { rows: ['F', 'E'], cols: 23 },
  namiot1: { rows: ['F', 'E', 'D', 'C', 'B', 'A'], cols: 22 },
  namiot2: { rows: ['F', 'E', 'D', 'C', 'B', 'A'], cols: 22 },
};

function canManageMaps(req, res, next) {
  const role = req.user.role;
  const code = String(req.user.code || '').toUpperCase();
  if (role !== 'manager' && role !== 'supervisor' && role !== 'admin' && code !== 'ADMIN' && code !== 'RBR056' && code !== 'POM80' && code !== 'POM82') {
    return res.status(403).json({ error: 'Brak uprawnień do modyfikacji map' });
  }
  next();
}

function normalizeMapCell(hallId, raw) {
  const hall = MAP_HALLS[hallId];
  if (!hall || !raw) return null;
  const row = String(raw.row || '').trim().toUpperCase();
  const col = Number(raw.col);
  const project = String(raw.project || '').replace(/\D/g, '');
  const product = Number(String(raw.product || '').replace(/\D/g, ''));
  if (!hall.rows.includes(row)) return null;
  if (!Number.isInteger(col) || col < 1 || col > hall.cols) return null;
  if (!project || !Number.isInteger(product) || product < 1) return null;
  return { row, col, project, product };
}

function normalizeMapLayouts(rawLayouts) {
  const result = {};
  for (const hallId of Object.keys(MAP_HALLS)) {
    const cells = Array.isArray(rawLayouts?.[hallId]) ? rawLayouts[hallId] : [];
    const byCell = new Map();
    for (const raw of cells) {
      const cell = normalizeMapCell(hallId, raw);
      if (cell) byCell.set(`${cell.row}-${cell.col}`, cell);
    }
    result[hallId] = [...byCell.values()].sort((a, b) => {
      return MAP_HALLS[hallId].rows.indexOf(a.row) - MAP_HALLS[hallId].rows.indexOf(b.row) || a.col - b.col;
    });
  }
  return result;
}

function normalizeMapPhotos(rawPhotos) {
  const result = {};
  for (const hallId of Object.keys(MAP_HALLS)) {
    const entry = rawPhotos?.[hallId];
    const src = typeof entry === 'string' ? entry : entry?.src;
    const rotation = Number(typeof entry === 'object' && entry ? entry.rotation || 0 : 0);
    if (typeof src === 'string' && src.startsWith('data:image/')) {
      result[hallId] = {
        src,
        rotation: ((rotation % 360) + 360) % 360
      };
    }
  }
  return result;
}

async function ensureMapLayoutsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS map_layouts (
      id TEXT PRIMARY KEY,
      layouts JSONB NOT NULL DEFAULT '{}'::jsonb,
      photos JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE map_layouts ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query(
    "INSERT INTO map_layouts (id, layouts, photos) VALUES ('main', '{}'::jsonb, '{}'::jsonb) ON CONFLICT (id) DO NOTHING"
  );
}

async function ensureUsersBlockColumn() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE");
}

async function ensureStagePermissionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stage_permissions (
      stage TEXT NOT NULL,
      worker_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (stage, worker_code)
    )
  `);
}

async function ensureTransportDatesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transport_dates (
      project TEXT NOT NULL,
      product INTEGER NOT NULL,
      load_date DATE NOT NULL,
      lkw_number INTEGER,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, product)
    )
  `);
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS lkw_number INTEGER");
}

async function ensureProjectsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      project TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      closed BOOLEAN NOT NULL DEFAULT FALSE,
      calculation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS calculation_enabled BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_bathrooms (
      project TEXT NOT NULL REFERENCES projects(project) ON DELETE CASCADE,
      product INTEGER NOT NULL,
      external_id TEXT,
      ventilation_variant TEXT,
      visible_high_walls TEXT,
      requested_delivery TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, product)
    )
  `);
}

async function ensureMaterialUsagesTable() {
  await ensureProjectsTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS material_usages (
      id SERIAL PRIMARY KEY,
      project TEXT NOT NULL,
      product INTEGER NOT NULL,
      stage TEXT NOT NULL,
      type_key TEXT NOT NULL,
      type_label TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      worker_code TEXT,
      worker_name TEXT,
      report_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project, stage, type_key)
    )
  `);
}

async function ensureBathroomCommentsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bathroom_comments (
      id SERIAL PRIMARY KEY,
      project TEXT NOT NULL,
      product INTEGER NOT NULL,
      comment TEXT NOT NULL,
      author_code TEXT,
      author_name TEXT,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_by TEXT,
      done_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE bathroom_comments ADD COLUMN IF NOT EXISTS done BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE bathroom_comments ADD COLUMN IF NOT EXISTS done_by TEXT");
  await pool.query("ALTER TABLE bathroom_comments ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ");
}

async function ensureBathroomChecksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bathroom_checks (
      project TEXT NOT NULL,
      product INTEGER NOT NULL,
      check_type TEXT NOT NULL DEFAULT 'tiling',
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      checked_by TEXT,
      checked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, product, check_type)
    )
  `);
  await pool.query("ALTER TABLE bathroom_checks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Nieprawidłowy token' }); }
}
function managerOnly(req, res, next) {
  const role = req.user.role;
  const code = String(req.user.code || '').toUpperCase();
  if (role !== 'manager' && role !== 'supervisor' && role !== 'admin' && code !== 'ADMIN' && code !== 'RBR056') return res.status(403).json({ error: 'Brak uprawnien' });
  next();
}

function normalizeUserRole(role) {
  const value = String(role || 'worker').trim().toLowerCase();
  return ['worker', 'manager', 'viewer', 'supervisor', 'admin'].includes(value) ? value : 'worker';
}

function assertRoleAllowedForCode(code, role, res) {
  if (role === 'supervisor' && String(code || '').toUpperCase() !== 'RBR056') {
    res.status(400).json({ error: 'Rola supervisor jest zastrzezona tylko dla konta RBR056' });
    return false;
  }
  return true;
}

async function forbiddenStagesForWorker(client, workerCode, lines) {
  const code = String(workerCode || '').trim().toUpperCase();
  const stages = [...new Set((lines || []).map(line => String(line.stage || '').trim()).filter(Boolean))];
  if (!code || !stages.length) return [];
  await ensureStagePermissionsTable();
  const r = await client.query(
    `SELECT stage, array_agg(UPPER(worker_code)) AS workers
     FROM stage_permissions
     WHERE stage = ANY($1)
     GROUP BY stage`,
    [stages]
  );
  return r.rows
    .filter(row => Array.isArray(row.workers) && row.workers.length && !row.workers.includes(code))
    .map(row => row.stage);
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { code, password } = req.body;
  if (!code || !password) return res.status(400).json({ error: 'Podaj kod i hasło' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE UPPER(code) = UPPER($1)', [code.trim()]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Nie znaleziono konta dla tego kodu' });
    if (user.is_blocked) return res.status(403).json({ error: 'Konto jest zablokowane. Skontaktuj się z przełożonym.' });
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
    await ensureUsersBlockColumn();
    const r = await pool.query("SELECT code, name, role, must_change_password, is_blocked, created_at FROM users WHERE code != 'ADMIN' ORDER BY name");
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/users', auth, managerOnly, async (req, res) => {
  const { code, name, password } = req.body;
  const userCode = String(code || '').trim().toUpperCase();
  const role = normalizeUserRole(req.body.role);
  const requesterCode = String(req.user.code || '').toUpperCase();
  if (!userCode || !name || !password || password.length < 4) return res.status(400).json({ error: 'Nieprawidlowe dane' });
  if (!assertRoleAllowedForCode(userCode, role, res)) return;
  if (role === 'admin' && requesterCode !== 'ADMIN' && requesterCode !== 'RBR056') return res.status(403).json({ error: 'Tylko admin moze tworzyc konta admin' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const mustChange = role === 'manager' || role === 'supervisor' || role === 'admin' ? false : true;
    await pool.query('INSERT INTO users (code, name, password_hash, must_change_password, role) VALUES ($1,$2,$3,$4,$5)', [userCode, name, hash, mustChange, role]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Konto już istnieje' });
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.put('/api/users/:code/role', auth, managerOnly, async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const role = normalizeUserRole(req.body.role);
  const requesterCode = String(req.user.code || '').toUpperCase();
  if (!code || code === 'ADMIN') return res.status(400).json({ error: 'Nieprawidlowy uzytkownik' });
  if (code === requesterCode) return res.status(400).json({ error: 'Nie mozesz zmienic roli swojego konta' });
  if (!assertRoleAllowedForCode(code, role, res)) return;
  try {
    const target = await pool.query('SELECT role FROM users WHERE code=$1', [code]);
    if (!target.rows.length) return res.status(404).json({ error: 'Nie znaleziono uzytkownika' });
    const targetRole = target.rows[0].role;
    const canManagePrivileged = req.user.role === 'supervisor' || req.user.role === 'admin' || requesterCode === 'ADMIN' || requesterCode === 'RBR056';
    if ((targetRole === 'manager' || targetRole === 'supervisor' || targetRole === 'admin' || role === 'manager' || role === 'supervisor' || role === 'admin') && !canManagePrivileged) {
      return res.status(403).json({ error: 'Tylko supervisor lub admin moze zmieniac konta uprzywilejowane' });
    }
    await pool.query('UPDATE users SET role=$1 WHERE code=$2', [role, code]);
    res.json({ success: true, code, role });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad serwera' });
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

app.put('/api/users/:code/block', auth, managerOnly, async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const blocked = !!req.body.blocked;
  if (!code || code === 'ADMIN') return res.status(400).json({ error: 'Nieprawidłowy użytkownik' });
  if (code === String(req.user.code || '').toUpperCase()) return res.status(400).json({ error: 'Nie możesz zablokować swojego konta' });
  try {
    await ensureUsersBlockColumn();
    const target = await pool.query('SELECT role FROM users WHERE code=$1', [code]);
    if (!target.rows.length) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
    if (target.rows[0].role === 'manager' && req.user.role !== 'supervisor' && req.user.code !== 'ADMIN') {
      return res.status(403).json({ error: 'Tylko supervisor lub admin może blokować menedżerów.' });
    }
    await pool.query('UPDATE users SET is_blocked=$1 WHERE code=$2', [blocked, code]);
    res.json({ success: true, code, blocked });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd serwera' });
  }
});

app.delete('/api/users/:code', auth, managerOnly, async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const requesterCode = String(req.user.code || '').toUpperCase();
  if (!code || code === 'ADMIN') return res.status(400).json({ error: 'Nieprawidlowy uzytkownik' });
  if (code === requesterCode) return res.status(400).json({ error: 'Nie mozesz usunac swojego konta' });
  const target = await pool.query('SELECT role FROM users WHERE code=$1', [code]);
  if (!target.rows.length) return res.status(404).json({ error: 'Nie znaleziono uzytkownika' });
  if (target.rows[0].role === 'manager' || target.rows[0].role === 'supervisor') {
    if (req.user.role !== 'supervisor' && req.user.role !== 'admin' && requesterCode !== 'ADMIN' && requesterCode !== 'RBR056') {
      return res.status(403).json({ error: 'Tylko supervisor lub admin moze usuwac konta managerow i supervisora' });
    }
  }
  await pool.query('DELETE FROM users WHERE code=$1', [code]);
  res.json({ success: true });
});

app.get('/api/stage-permissions', auth, async (req, res) => {
  try {
    await ensureStagePermissionsTable();
    const r = await pool.query(
      `SELECT stage, worker_code AS "workerCode", updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM stage_permissions
       ORDER BY stage, worker_code`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu przypisan etapow' });
  }
});

app.put('/api/stage-permissions/:stage', auth, managerOnly, async (req, res) => {
  const stage = String(req.params.stage || '').trim();
  const workerCodes = Array.isArray(req.body.workerCodes) ? req.body.workerCodes : [];
  const normalized = [...new Set(workerCodes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean))];
  if (!stage) return res.status(400).json({ error: 'Brak etapu' });
  const client = await pool.connect();
  try {
    await ensureStagePermissionsTable();
    await client.query('BEGIN');
    await client.query('DELETE FROM stage_permissions WHERE stage=$1', [stage]);
    for (const code of normalized) {
      const exists = await client.query('SELECT code FROM users WHERE code=$1 AND role=$2', [code, 'worker']);
      if (!exists.rows.length) continue;
      await client.query(
        `INSERT INTO stage_permissions (stage, worker_code, updated_by, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (stage, worker_code) DO UPDATE SET updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [stage, code, req.user.code]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, stage, workerCodes: normalized });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad zapisu przypisan etapow' });
  } finally {
    client.release();
  }
});

// PROJECTS
app.get('/api/projects', auth, async (req, res) => {
  try {
    await ensureProjectsTables();
    const [projects, bathrooms] = await Promise.all([
      pool.query('SELECT project, count, closed, calculation_enabled AS "calculationEnabled", updated_by AS "updatedBy", updated_at AS "updatedAt", created_at AS "createdAt" FROM projects ORDER BY project'),
      pool.query(`SELECT project, product, external_id AS "externalId", ventilation_variant AS "ventilationVariant",
                  visible_high_walls AS "visibleHighWalls", requested_delivery AS "requestedDelivery"
                  FROM project_bathrooms ORDER BY project, product`)
    ]);
    const byProject = {};
    bathrooms.rows.forEach(row => {
      if (!byProject[row.project]) byProject[row.project] = [];
      byProject[row.project].push(row);
    });
    res.json(projects.rows.map(p => ({ ...p, bathrooms: byProject[p.project] || [] })));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu projektow' });
  }
});

app.post('/api/projects', auth, managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const count = Number(req.body.count);
  if (!project || !Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'Brak numeru projektu lub ilosci lazienek' });
  try {
    await ensureProjectsTables();
    await pool.query(
      `INSERT INTO projects (project, count, closed, updated_by, updated_at)
       VALUES ($1,$2,FALSE,$3,NOW())
       ON CONFLICT (project) DO UPDATE SET count=EXCLUDED.count, closed=FALSE, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, count, req.user.code]
    );
    res.json({ success: true, project, count });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu projektu' });
  }
});

app.put('/api/projects/:project', auth, managerOnly, async (req, res) => {
  const project = String(req.params.project || '').trim();
  const count = Number(req.body.count);
  const closed = req.body.closed == null ? null : !!req.body.closed;
  const calculationEnabled = req.body.calculationEnabled == null ? null : !!req.body.calculationEnabled;
  if (!project) return res.status(400).json({ error: 'Brak projektu' });
  try {
    await ensureProjectsTables();
    if (Number.isInteger(count) && count > 0) {
      await pool.query(
        `INSERT INTO projects (project, count, closed, calculation_enabled, updated_by, updated_at)
         VALUES ($1,$2,COALESCE($3,FALSE),COALESCE($4,FALSE),$5,NOW())
         ON CONFLICT (project) DO UPDATE SET count=EXCLUDED.count, closed=COALESCE($3, projects.closed), calculation_enabled=COALESCE($4, projects.calculation_enabled), updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [project, count, closed, calculationEnabled, req.user.code]
      );
    } else if (closed !== null || calculationEnabled !== null) {
      await pool.query(
        'UPDATE projects SET closed=COALESCE($1, closed), calculation_enabled=COALESCE($2, calculation_enabled), updated_by=$3, updated_at=NOW() WHERE project=$4',
        [closed, calculationEnabled, req.user.code, project]
      );
    } else {
      return res.status(400).json({ error: 'Brak danych do zmiany' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad edycji projektu' });
  }
});

app.post('/api/projects/import', auth, managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const bathrooms = Array.isArray(req.body.bathrooms) ? req.body.bathrooms : [];
  if (!project || !bathrooms.length) return res.status(400).json({ error: 'Brak projektu lub lazienek do importu' });
  const client = await pool.connect();
  try {
    await ensureProjectsTables();
    await client.query('BEGIN');
    const normalized = bathrooms
      .map(raw => ({
        product: Number(raw.product),
        externalId: String(raw.externalId || raw.id || '').trim(),
        ventilationVariant: String(raw.ventilationVariant || '').trim(),
        visibleHighWalls: String(raw.visibleHighWalls || '').trim(),
        requestedDelivery: String(raw.requestedDelivery || '').trim()
      }))
      .filter(row => Number.isInteger(row.product) && row.product > 0);
    const count = Math.max(Number(req.body.count) || 0, ...normalized.map(row => row.product));
    if (!count) return res.status(400).json({ error: 'Nie znaleziono numerow lazienek w pliku' });
    await client.query(
      `INSERT INTO projects (project, count, closed, updated_by, updated_at)
       VALUES ($1,$2,FALSE,$3,NOW())
       ON CONFLICT (project) DO UPDATE SET count=GREATEST(projects.count, EXCLUDED.count), closed=FALSE, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, count, req.user.code]
    );
    for (const row of normalized) {
      await client.query(
        `INSERT INTO project_bathrooms (project, product, external_id, ventilation_variant, visible_high_walls, requested_delivery, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (project, product) DO UPDATE SET external_id=EXCLUDED.external_id,
           ventilation_variant=EXCLUDED.ventilation_variant, visible_high_walls=EXCLUDED.visible_high_walls,
           requested_delivery=EXCLUDED.requested_delivery, updated_at=NOW()`,
        [project, row.product, row.externalId, row.ventilationVariant, row.visibleHighWalls, row.requestedDelivery]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, project, count, imported: normalized.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad importu projektu' });
  } finally {
    client.release();
  }
});

app.get('/api/material-usages', auth, async (req, res) => {
  try {
    await ensureMaterialUsagesTable();
    const r = await pool.query(
      `SELECT id, project, product, stage, type_key AS "typeKey", type_label AS "typeLabel", data,
              worker_code AS "workerCode", worker_name AS "workerName", report_date::text AS "reportDate", created_at AS "createdAt"
       FROM material_usages
       ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu kalkulacji' });
  }
});

app.post('/api/material-usages', auth, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const product = Number(req.body.product);
  const stage = String(req.body.stage || '').trim();
  const typeKey = String(req.body.typeKey || '').trim();
  const typeLabel = String(req.body.typeLabel || '').trim();
  const data = req.body.data && typeof req.body.data === 'object' ? req.body.data : {};
  const reportDate = String(req.body.reportDate || '').trim() || null;
  if (!project || !Number.isInteger(product) || product < 1 || !stage || !typeKey) return res.status(400).json({ error: 'Brak danych zuzycia' });
  try {
    await ensureMaterialUsagesTable();
    const p = await pool.query('SELECT calculation_enabled FROM projects WHERE project=$1', [project]);
    if (!p.rows.length || !p.rows[0].calculation_enabled) return res.status(400).json({ error: 'Projekt nie jest objety kalkulacjami' });
    const r = await pool.query(
      `INSERT INTO material_usages (project, product, stage, type_key, type_label, data, worker_code, worker_name, report_date)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
       ON CONFLICT (project, stage, type_key) DO NOTHING
       RETURNING id`,
      [project, product, stage, typeKey, typeLabel, JSON.stringify(data), req.user.code, req.user.name || req.user.code, reportDate]
    );
    res.json({ success: true, inserted: r.rows.length > 0, id: r.rows[0] && r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu zuzycia' });
  }
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/api/reports', auth, async (req, res) => {
  try {
    const isManager = true;
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
    const forbidden = await forbiddenStagesForWorker(client, req.user.code, lines);
    if (forbidden.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Nie masz uprawnien do raportowania etapow: ${forbidden.join(', ')}` });
    }
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
    const forbidden = await forbiddenStagesForWorker(client, workerCode, lines);
    if (forbidden.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Pracownik nie ma uprawnien do raportowania etapow: ${forbidden.join(', ')}` });
    }
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
app.get('/api/maps-layouts', auth, async (req, res) => {
  try {
    await ensureMapLayoutsTable();
    const r = await pool.query("SELECT layouts, photos FROM map_layouts WHERE id='main'");
    res.json({
      layouts: normalizeMapLayouts(r.rows[0]?.layouts || {}),
      photos: normalizeMapPhotos(r.rows[0]?.photos || {})
    });
  } catch (err) {
    console.error('Maps layouts GET error:', err);
    res.status(500).json({ error: err.message || 'Błąd odczytu map' });
  }
});

app.put('/api/maps-layouts', auth, canManageMaps, async (req, res) => {
  try {
    await ensureMapLayoutsTable();
    const layouts = normalizeMapLayouts(req.body?.layouts || {});
    await pool.query(
      `INSERT INTO map_layouts (id, layouts, updated_by, updated_at)
       VALUES ('main', $1::jsonb, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET layouts=EXCLUDED.layouts, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [JSON.stringify(layouts), req.user.code]
    );
    res.json({ success: true, layouts });
  } catch (err) {
    console.error('Maps layouts PUT error:', err);
    res.status(500).json({ error: err.message || 'Błąd zapisu map' });
  }
});

app.put('/api/maps-photos', auth, canManageMaps, async (req, res) => {
  try {
    await ensureMapLayoutsTable();
    const photos = normalizeMapPhotos(req.body?.photos || {});
    await pool.query(
      `INSERT INTO map_layouts (id, layouts, photos, updated_by, updated_at)
       VALUES ('main', '{}'::jsonb, $1::jsonb, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET photos=EXCLUDED.photos, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [JSON.stringify(photos), req.user.code]
    );
    res.json({ success: true, photos });
  } catch (err) {
    console.error('Maps photos PUT error:', err);
    res.status(500).json({ error: err.message || 'Błąd zapisu zdjęcia mapy' });
  }
});

app.get('/api/transport-dates', auth, async (req, res) => {
  try {
    await ensureTransportDatesTable();
    const r = await pool.query('SELECT project, product, load_date::text AS "loadDate", lkw_number AS "lkwNumber", updated_by AS "updatedBy", updated_at AS "updatedAt" FROM transport_dates ORDER BY load_date, project, COALESCE(lkw_number, 999999), product');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd odczytu transportu' });
  }
});

app.get('/api/bathroom-comments', auth, async (req, res) => {
  try {
    await ensureBathroomCommentsTable();
    const r = await pool.query('SELECT id, project, product, comment, author_code AS "authorCode", author_name AS "authorName", done, done_by AS "doneBy", done_at AS "doneAt", created_at AS "createdAt" FROM bathroom_comments ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd odczytu komentarzy' });
  }
});

app.post('/api/bathroom-comments', auth, managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const product = Number(req.body.product);
  const comment = String(req.body.comment || '').trim();
  if (!project || !Number.isInteger(product) || product < 1 || !comment) return res.status(400).json({ error: 'Brak projektu, łazienki lub komentarza' });
  try {
    await ensureBathroomCommentsTable();
    const r = await pool.query(
      'INSERT INTO bathroom_comments (project, product, comment, author_code, author_name) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [project, product, comment, req.user.code, req.user.name || req.user.code]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd zapisu komentarza' });
  }
});

app.put('/api/bathroom-comments/:id/done', auth, managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  const done = !!req.body.done;
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Nieprawidlowy komentarz' });
  try {
    await ensureBathroomCommentsTable();
    const r = await pool.query(
      `UPDATE bathroom_comments
       SET done=$2, done_by=$3, done_at=CASE WHEN $2 THEN NOW() ELSE NULL END
       WHERE id=$1
       RETURNING id`,
      [id, done, done ? req.user.code : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Komentarz nie istnieje' });
    res.json({ success: true, id, done });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd zapisu statusu komentarza' });
  }
});

app.get('/api/bathroom-checks', auth, async (req, res) => {
  try {
    await ensureBathroomChecksTable();
    const r = await pool.query(
      `SELECT project, product, check_type AS "checkType", checked, status,
              checked_by AS "checkedBy", checked_at AS "checkedAt", updated_at AS "updatedAt"
       FROM bathroom_checks
       ORDER BY updated_at DESC, project, product`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu kontroli' });
  }
});

app.put('/api/bathroom-checks', auth, managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const product = Number(req.body.product);
  const checkType = String(req.body.checkType || 'tiling').trim() || 'tiling';
  const requestedStatus = String(req.body.status || '').trim().toLowerCase();
  const status = ['pending', 'checked', 'rework'].includes(requestedStatus) ? requestedStatus : (req.body.checked ? 'checked' : 'pending');
  const checked = status === 'checked';
  if (!project || !Number.isInteger(product) || product < 1) return res.status(400).json({ error: 'Brak projektu lub numeru lazienki' });
  try {
    await ensureBathroomChecksTable();
    await pool.query(
      `INSERT INTO bathroom_checks (project, product, check_type, checked, status, checked_by, checked_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $4 THEN NOW() ELSE NULL END,NOW())
       ON CONFLICT (project, product, check_type)
       DO UPDATE SET checked=EXCLUDED.checked, status=EXCLUDED.status, checked_by=EXCLUDED.checked_by,
         checked_at=EXCLUDED.checked_at, updated_at=NOW()`,
      [project, product, checkType, checked, status, checked ? req.user.code : null]
    );
    res.json({ success: true, project, product, checkType, checked, status });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu kontroli' });
  }
});

app.put('/api/transport-dates', auth, managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const product = Number(req.body.product);
  const loadDate = String(req.body.loadDate || '').trim();
  let lkwNumber = req.body.lkwNumber === '' || req.body.lkwNumber == null ? null : Number(req.body.lkwNumber);
  if (!project || !Number.isInteger(product) || product < 1) return res.status(400).json({ error: 'Brak projektu lub numeru łazienki' });
  try {
    await ensureTransportDatesTable();
    if (!loadDate) {
      await pool.query('DELETE FROM transport_dates WHERE project=$1 AND product=$2', [project, product]);
      return res.json({ success: true, deleted: true });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(loadDate)) return res.status(400).json({ error: 'Nieprawidłowa data załadunku' });
    if (lkwNumber !== null && (!Number.isInteger(lkwNumber) || lkwNumber < 1)) return res.status(400).json({ error: 'Nieprawidlowy numer LKW' });
    if (lkwNumber === null) {
      const current = await pool.query(
        'SELECT lkw_number FROM transport_dates WHERE project=$1 AND load_date=$2 AND lkw_number IS NOT NULL ORDER BY lkw_number LIMIT 1',
        [project, loadDate]
      );
      if (current.rows.length) {
        lkwNumber = current.rows[0].lkw_number;
      } else {
        const next = await pool.query('SELECT COALESCE(MAX(lkw_number), 0) + 1 AS next FROM transport_dates WHERE project=$1', [project]);
        lkwNumber = Number(next.rows[0].next) || 1;
      }
    }
    await pool.query(
      `INSERT INTO transport_dates (project, product, load_date, lkw_number, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (project, product) DO UPDATE SET load_date=EXCLUDED.load_date, lkw_number=EXCLUDED.lkw_number, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, product, loadDate, lkwNumber, req.user.code]
    );
    res.json({ success: true, project, product, loadDate, lkwNumber });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd zapisu transportu' });
  }
});

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
            <p style="color:#888;font-size:12px;margin-top:16px">Wiadomość automatyczna — RaportRBR v1.2 © Ready Bathroom</p>
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
    await ensureUsersBlockColumn();
    await ensureMapLayoutsTable();
    await ensureTransportDatesTable();
    await ensureBathroomCommentsTable();
    await ensureBathroomChecksTable();
    await ensureStagePermissionsTable();
    await ensureProjectsTables();
    await ensureMaterialUsagesTable();
    const [users, reports, lines, recipients, mapLayouts, transportDates, comments, checks, stagePermissions, projects, projectBathrooms, materialUsages] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM reports ORDER BY created_at'),
      pool.query('SELECT * FROM report_lines ORDER BY id'),
      pool.query('SELECT * FROM email_recipients ORDER BY id'),
      pool.query('SELECT * FROM map_layouts ORDER BY id'),
      pool.query('SELECT * FROM transport_dates ORDER BY load_date, project, product'),
      pool.query('SELECT * FROM bathroom_comments ORDER BY created_at'),
      pool.query('SELECT * FROM bathroom_checks ORDER BY updated_at'),
      pool.query('SELECT * FROM stage_permissions ORDER BY stage, worker_code'),
      pool.query('SELECT * FROM projects ORDER BY project'),
      pool.query('SELECT * FROM project_bathrooms ORDER BY project, product'),
      pool.query('SELECT * FROM material_usages ORDER BY created_at'),
    ]);

    const backup = {
      version: '1.2',
      exportedAt: new Date().toISOString(),
      data: {
        users: users.rows,
        reports: reports.rows,
        report_lines: lines.rows,
        email_recipients: recipients.rows,
        map_layouts: mapLayouts.rows,
        transport_dates: transportDates.rows,
        bathroom_comments: comments.rows,
        bathroom_checks: checks.rows,
        stage_permissions: stagePermissions.rows,
        projects: projects.rows,
        project_bathrooms: projectBathrooms.rows,
        material_usages: materialUsages.rows,
      },
      counts: {
        users: users.rows.length,
        reports: reports.rows.length,
        report_lines: lines.rows.length,
        map_layouts: mapLayouts.rows.length,
        transport_dates: transportDates.rows.length,
        bathroom_comments: comments.rows.length,
        bathroom_checks: checks.rows.length,
        stage_permissions: stagePermissions.rows.length,
        projects: projects.rows.length,
        project_bathrooms: projectBathrooms.rows.length,
        material_usages: materialUsages.rows.length,
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

    let transportRestored = 0;
    if (Array.isArray(data.transport_dates)) {
      await ensureTransportDatesTable();
      for (const t of data.transport_dates) {
        await client.query(
          `INSERT INTO transport_dates (project, product, load_date, lkw_number, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW()))
           ON CONFLICT (project, product) DO UPDATE SET load_date=EXCLUDED.load_date, lkw_number=EXCLUDED.lkw_number, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [t.project, t.product, t.load_date || t.loadDate, t.lkw_number || t.lkwNumber || null, t.updated_by || t.updatedBy || req.user.code, t.updated_at || t.updatedAt || null]
        );
        transportRestored++;
      }
    }

    let projectsRestored = 0;
    if (Array.isArray(data.projects) || Array.isArray(data.project_bathrooms)) {
      await ensureProjectsTables();
      for (const p of (data.projects || [])) {
        await client.query(
          `INSERT INTO projects (project, count, closed, calculation_enabled, updated_by, updated_at, created_at)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW()),COALESCE($7,NOW()))
           ON CONFLICT (project) DO UPDATE SET count=EXCLUDED.count, closed=EXCLUDED.closed, calculation_enabled=EXCLUDED.calculation_enabled, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [p.project, p.count || 0, !!p.closed, !!(p.calculation_enabled || p.calculationEnabled), p.updated_by || p.updatedBy || req.user.code, p.updated_at || p.updatedAt || null, p.created_at || p.createdAt || null]
        );
        projectsRestored++;
      }
      for (const b of (data.project_bathrooms || [])) {
        await client.query(
          `INSERT INTO project_bathrooms (project, product, external_id, ventilation_variant, visible_high_walls, requested_delivery, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()))
           ON CONFLICT (project, product) DO UPDATE SET external_id=EXCLUDED.external_id,
             ventilation_variant=EXCLUDED.ventilation_variant, visible_high_walls=EXCLUDED.visible_high_walls,
             requested_delivery=EXCLUDED.requested_delivery, updated_at=EXCLUDED.updated_at`,
          [b.project, b.product, b.external_id || b.externalId || null, b.ventilation_variant || b.ventilationVariant || null, b.visible_high_walls || b.visibleHighWalls || null, b.requested_delivery || b.requestedDelivery || null, b.updated_at || b.updatedAt || null]
        );
      }
    }

    let materialRestored = 0;
    if (Array.isArray(data.material_usages)) {
      await ensureMaterialUsagesTable();
      for (const m of data.material_usages) {
        await client.query(
          `INSERT INTO material_usages (id, project, product, stage, type_key, type_label, data, worker_code, worker_name, report_date, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,COALESCE($11,NOW()))
           ON CONFLICT (project, stage, type_key) DO NOTHING`,
          [m.id, m.project, m.product, m.stage, m.type_key || m.typeKey, m.type_label || m.typeLabel || null, JSON.stringify(m.data || {}), m.worker_code || m.workerCode || null, m.worker_name || m.workerName || null, m.report_date || m.reportDate || null, m.created_at || m.createdAt || null]
        );
        materialRestored++;
      }
      await client.query("SELECT setval(pg_get_serial_sequence('material_usages','id'), COALESCE((SELECT MAX(id) FROM material_usages), 1), true)");
    }

    let mapsRestored = 0;
    if (Array.isArray(data.map_layouts)) {
      await ensureMapLayoutsTable();
      for (const m of data.map_layouts) {
        await client.query(
          `INSERT INTO map_layouts (id, layouts, photos, updated_by, updated_at)
           VALUES ($1,$2::jsonb,$3::jsonb,$4,COALESCE($5,NOW()))
           ON CONFLICT (id) DO UPDATE SET layouts=EXCLUDED.layouts, photos=EXCLUDED.photos, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [m.id || 'main', JSON.stringify(normalizeMapLayouts(m.layouts || {})), JSON.stringify(normalizeMapPhotos(m.photos || {})), m.updated_by || req.user.code, m.updated_at || null]
        );
        mapsRestored++;
      }
    }

    let commentsRestored = 0;
    if (Array.isArray(data.bathroom_comments)) {
      await ensureBathroomCommentsTable();
      for (const c of data.bathroom_comments) {
        const exists = await client.query('SELECT id FROM bathroom_comments WHERE id=$1', [c.id]);
        if (exists.rows.length === 0) {
          await client.query(
            `INSERT INTO bathroom_comments (id, project, product, comment, author_code, author_name, done, done_by, done_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,NOW()))`,
            [
              c.id, c.project, c.product, c.comment,
              c.author_code || c.authorCode || null,
              c.author_name || c.authorName || null,
              !!c.done,
              c.done_by || c.doneBy || null,
              c.done_at || c.doneAt || null,
              c.created_at || c.createdAt || null
            ]
          );
          commentsRestored++;
        }
      }
      await client.query("SELECT setval(pg_get_serial_sequence('bathroom_comments','id'), COALESCE((SELECT MAX(id) FROM bathroom_comments), 1), true)");
    }

    let checksRestored = 0;
    if (Array.isArray(data.bathroom_checks)) {
      await ensureBathroomChecksTable();
      for (const c of data.bathroom_checks) {
        await client.query(
          `INSERT INTO bathroom_checks (project, product, check_type, checked, status, checked_by, checked_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,NOW()))
           ON CONFLICT (project, product, check_type)
           DO UPDATE SET checked=EXCLUDED.checked, status=EXCLUDED.status, checked_by=EXCLUDED.checked_by,
             checked_at=EXCLUDED.checked_at, updated_at=EXCLUDED.updated_at`,
          [
            c.project,
            c.product,
            c.check_type || c.checkType || 'tiling',
            !!c.checked,
            c.status || (c.checked ? 'checked' : 'pending'),
            c.checked_by || c.checkedBy || null,
            c.checked_at || c.checkedAt || null,
            c.updated_at || c.updatedAt || null
          ]
        );
        checksRestored++;
      }
    }

    let stagePermissionsRestored = 0;
    if (Array.isArray(data.stage_permissions)) {
      await ensureStagePermissionsTable();
      for (const p of data.stage_permissions) {
        const stage = String(p.stage || '').trim();
        const workerCode = String(p.worker_code || p.workerCode || '').trim().toUpperCase();
        if (!stage || !workerCode) continue;
        await client.query(
          `INSERT INTO stage_permissions (stage, worker_code, updated_by, updated_at)
           VALUES ($1,$2,$3,COALESCE($4,NOW()))
           ON CONFLICT (stage, worker_code) DO UPDATE SET updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [stage, workerCode, p.updated_by || p.updatedBy || req.user.code, p.updated_at || p.updatedAt || null]
        );
        stagePermissionsRestored++;
      }
    }
    
    await client.query('COMMIT');
    res.json({ success: true, message: `Przywrocono ${added} raportow, ${linesAdded} wpisow, ${transportRestored} dat transportu, ${projectsRestored} projektow, ${mapsRestored} map, ${commentsRestored} komentarzy, ${checksRestored} kontroli, ${stagePermissionsRestored} przypisan etapow, ${materialRestored} kalkulacji` });
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
      version: '1.2',
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

app.listen(PORT, () => console.log(`RaportRBR v1.2 running on port ${PORT}`));
