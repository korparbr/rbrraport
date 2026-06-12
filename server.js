// RaportRBR v1.91 - Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cron = require('node-cron');
const path = require('path');
const { Pool } = require('pg');
const { generateDailyExcel } = require('./report');
const { sendDailyReport } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = String(process.env.JWT_SECRET || '');
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET musi byc ustawiony w .env i miec minimum 32 znaki.');
}
const LOGIN_LOCK_MAX = Number(process.env.LOGIN_LOCK_MAX || 5);
const LOGIN_LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);

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

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const rateBuckets = new Map();
function rateLimit({ windowMs, max, prefix }) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${prefix}:${ip}`;
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    rateBuckets.set(key, bucket);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Za duzo prob. Sprobuj ponownie pozniej.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, prefix: 'login' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 900, prefix: 'api' }));

const MAP_HALLS = {
  betonowanie: { rows: ['F', 'E'], cols: 23 },
  namiot1: { rows: ['F', 'E', 'D', 'C', 'B', 'A'], cols: 22 },
  namiot2: { rows: ['F', 'E', 'D', 'C', 'B', 'A'], cols: 22 },
};

function canManageMaps(req, res, next) {
  const role = req.user.role;
  const code = String(req.user.code || '').toUpperCase();
  if (role !== 'worker+' && role !== 'manager' && role !== 'supervisor' && role !== 'admin' && code !== 'ADMIN' && code !== 'RBR056' && code !== 'POM80' && code !== 'POM82') {
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
  const placedDate = String(raw.placedDate || raw.placed_date || raw.date || '').trim();
  if (!hall.rows.includes(row)) return null;
  if (!Number.isInteger(col) || col < 1 || col > hall.cols) return null;
  if (!project || !Number.isInteger(product) || product < 1) return null;
  return {
    row,
    col,
    project,
    product,
    placedDate: /^\d{4}-\d{2}-\d{2}$/.test(placedDate) ? placedDate : ''
  };
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

async function productionHallMapFromLayouts(client) {
  await ensureMapLayoutsTable();
  const result = {};
  const r = await client.query("SELECT layouts FROM map_layouts WHERE id='main'");
  const layouts = normalizeMapLayouts(r.rows[0]?.layouts || {});
  for (const hallId of Object.keys(layouts)) {
    for (const cell of layouts[hallId] || []) {
      result[`${cell.project}#${Number(cell.product)}`] = hallId;
    }
  }
  return result;
}

function productionHallForLine(line, hallMap) {
  const explicit = String(line?.hall || '').trim();
  if (explicit) return explicit;
  const project = String(line?.project || '').trim();
  const product = Number(line?.product);
  return hallMap[`${project}#${product}`] || '';
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

function normalizeMapDates(rawDates) {
  const result = {};
  for (const hallId of Object.keys(MAP_HALLS)) {
    const value = String(rawDates?.[hallId] || '').trim();
    result[hallId] = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  }
  return result;
}

function normalizeMapWidths(rawWidths, layouts = {}) {
  const result = {};
  for (const hallId of Object.keys(MAP_HALLS)) {
    const hall = MAP_HALLS[hallId];
    const cells = Array.isArray(layouts?.[hallId]) ? layouts[hallId] : [];
    const maxOccupied = cells.reduce((max, cell) => Math.max(max, Number(cell.col || 0)), 0);
    const raw = Number(rawWidths?.[hallId]);
    const desired = Number.isInteger(raw) && raw > 0 ? raw : hall.cols;
    result[hallId] = Math.min(hall.cols, Math.max(maxOccupied || 1, desired));
  }
  return result;
}

function normalizeMapStarts(rawStarts, layouts = {}) {
  const result = {};
  for (const hallId of Object.keys(MAP_HALLS)) {
    const hall = MAP_HALLS[hallId];
    const cells = Array.isArray(layouts?.[hallId]) ? layouts[hallId] : [];
    const minOccupied = cells.reduce((min, cell) => {
      const col = Number(cell.col || 0);
      return col > 0 ? Math.min(min, col) : min;
    }, hall.cols + 1);
    const maxStart = minOccupied <= hall.cols ? minOccupied : hall.cols;
    const raw = Number(rawStarts?.[hallId]);
    const desired = Number.isInteger(raw) && raw > 0 ? raw : 1;
    result[hallId] = Math.max(1, Math.min(desired, maxStart));
  }
  return result;
}

async function ensureMapLayoutsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS map_layouts (
      id TEXT PRIMARY KEY,
      layouts JSONB NOT NULL DEFAULT '{}'::jsonb,
      photos JSONB NOT NULL DEFAULT '{}'::jsonb,
      map_dates JSONB NOT NULL DEFAULT '{}'::jsonb,
      map_widths JSONB NOT NULL DEFAULT '{}'::jsonb,
      map_starts JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE map_layouts ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE map_layouts ADD COLUMN IF NOT EXISTS map_dates JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE map_layouts ADD COLUMN IF NOT EXISTS map_widths JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE map_layouts ADD COLUMN IF NOT EXISTS map_starts JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query(
    "INSERT INTO map_layouts (id, layouts, photos, map_dates, map_widths, map_starts) VALUES ('main', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) ON CONFLICT (id) DO NOTHING"
  );
}

async function ensureUsersBlockColumn() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_until TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0");
}

async function ensureUserSessionsTable() {
  await ensureUsersBlockColumn();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE,
      token_version INTEGER NOT NULL DEFAULT 0,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_user_sessions_user_code ON user_sessions(user_code)");
}

async function ensureReportsCreatedByColumn() {
  await pool.query("ALTER TABLE reports ADD COLUMN IF NOT EXISTS created_by TEXT");
  await pool.query("ALTER TABLE report_lines ADD COLUMN IF NOT EXISTS hall TEXT NOT NULL DEFAULT ''");
}

async function ensureAuditLogsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      actor_code TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      target TEXT,
      ip TEXT,
      user_agent TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)");
}

async function auditLog(req, action, target, details = {}) {
  try {
    await ensureAuditLogsTable();
    await pool.query(
      `INSERT INTO audit_logs (actor_code, actor_role, action, target, ip, user_agent, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        req.user?.code || details.code || null,
        req.user?.role || null,
        action,
        target || null,
        req.ip || req.socket?.remoteAddress || null,
        String(req.headers['user-agent'] || '').slice(0, 300),
        JSON.stringify(details || {})
      ]
    );
    await pool.query("DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '60 days'");
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

function passwordValidationError(password, { allowDefault = false } = {}) {
  const value = String(password || '');
  if (allowDefault && value === 'zmien123') return null;
  if (value.length < 8) return 'Haslo musi miec minimum 8 znakow.';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Haslo musi zawierac litery i cyfry.';
  if (value === 'zmien123') return 'Domyslne haslo moze byc uzyte tylko do resetu lub pierwszego logowania.';
  return null;
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

async function ensureUserStagePreferencesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stage_preferences (
      user_code TEXT PRIMARY KEY REFERENCES users(code) ON DELETE CASCADE,
      visible_stages JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureRolePermissionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role TEXT PRIMARY KEY,
      tabs JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureFertilizationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fertilization_settings (
      project TEXT NOT NULL,
      delivery_date TEXT NOT NULL,
      hall TEXT NOT NULL DEFAULT '',
      car_capacity INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, delivery_date)
    )
  `);
  await pool.query(`ALTER TABLE fertilization_settings ALTER COLUMN delivery_date TYPE TEXT USING delivery_date::text`);
}

async function ensureBackupSnapshotsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_snapshots (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'auto',
      payload JSONB NOT NULL,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_backup_snapshots_created_at ON backup_snapshots(created_at DESC)");
}

const DEFAULT_CALCULATION_STAGES = {
  '7.1': [
    ['tapeMb', 'Ilosc tasmy (mb)', 'number'],
    ['insideCorners', 'Narozniki wew. (szt)', 'number'],
    ['outsideCorners', 'Narozniki zew. (szt)', 'number'],
    ['isolationSystem', 'System izolowania', 'text'],
    ['singleCuffs', 'Manszety pojedyncze', 'number'],
    ['doubleCuffs', 'Manszety podwojne', 'number'],
    ['other', 'Inne', 'text']
  ],
  '11.1': [
    ['tileSize1', 'Rozmiar plytki 1 (mm)', 'text'],
    ['tileCount1', 'Ilosc plytek 1 (szt.)', 'number'],
    ['tileSize2', 'Rozmiar plytki 2 (mm)', 'text'],
    ['tileCount2', 'Ilosc plytek 2 (szt.)', 'number'],
    ['tileSize3', 'Rozmiar plytki 3 (mm)', 'text'],
    ['tileCount3', 'Ilosc plytek 3 (szt.)', 'number'],
    ['glue', 'Ilosc i rodzaj kleju (kg)', 'text'],
    ['stripType', 'Rodzaj listwy', 'text'],
    ['stripCount', 'Ilosc listew', 'number'],
    ['other', 'Inne', 'text']
  ],
  '11.2': [
    ['tileSize1', 'Rozmiar plytki 1 (mm)', 'text'],
    ['tileCount1', 'Ilosc plytek 1 (szt.)', 'number'],
    ['tileSize2', 'Rozmiar plytki 2 (mm)', 'text'],
    ['tileCount2', 'Ilosc plytek 2 (szt.)', 'number'],
    ['tileSize3', 'Rozmiar plytki 3 (mm)', 'text'],
    ['tileCount3', 'Ilosc plytek 3 (szt.)', 'number'],
    ['glue', 'Ilosc i rodzaj kleju (kg)', 'text'],
    ['stripType', 'Rodzaj listwy', 'text'],
    ['stripCount', 'Ilosc listew', 'number'],
    ['other', 'Inne', 'text']
  ],
  '13.1': [
    ['color1', 'Kolor fugi 1', 'text'],
    ['amountKg1', 'Ilosc fugi 1 (kg)', 'number'],
    ['color2', 'Kolor fugi 2', 'text'],
    ['amountKg2', 'Ilosc fugi 2 (kg)', 'number'],
    ['color3', 'Kolor fugi 3', 'text'],
    ['amountKg3', 'Ilosc fugi 3 (kg)', 'number']
  ],
  '13.2': [
    ['color1', 'Kolor silikonu 1', 'text'],
    ['amountPcs1', 'Ilosc silikonu 1 (szt)', 'number'],
    ['color2', 'Kolor silikonu 2', 'text'],
    ['amountPcs2', 'Ilosc silikonu 2 (szt)', 'number'],
    ['color3', 'Kolor silikonu 3', 'text'],
    ['amountPcs3', 'Ilosc silikonu 3 (szt)', 'number']
  ],
  '8.2': [
    ['wireUsageSent', 'Wyslales zuzycie przewodow?', 'checkbox']
  ]
};

async function ensureCalculationStagesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calculation_stages (
      stage TEXT PRIMARY KEY,
      fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const [stage, fields] of Object.entries(DEFAULT_CALCULATION_STAGES)) {
    await pool.query(
      `INSERT INTO calculation_stages (stage, fields, updated_by)
       VALUES ($1,$2::jsonb,'system')
       ON CONFLICT (stage) DO NOTHING`,
      [stage, JSON.stringify(fields)]
    );
  }
}

async function ensureAppSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureReportControlsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_controls (
      project TEXT NOT NULL DEFAULT '*',
      stage TEXT NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      question TEXT NOT NULL DEFAULT '',
      question_type TEXT NOT NULL DEFAULT 'confirm',
      question_required BOOLEAN NOT NULL DEFAULT TRUE,
      question_options JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, stage)
    )
  `);
  await pool.query("ALTER TABLE report_controls ADD COLUMN IF NOT EXISTS question_type TEXT NOT NULL DEFAULT 'confirm'");
  await pool.query("ALTER TABLE report_controls ADD COLUMN IF NOT EXISTS question_required BOOLEAN NOT NULL DEFAULT TRUE");
  await pool.query("ALTER TABLE report_controls ADD COLUMN IF NOT EXISTS question_options JSONB NOT NULL DEFAULT '[]'::jsonb");
}

function normalizeReportControlInput(body) {
  const projectRaw = String(body?.project || '*').trim();
  const project = !projectRaw || projectRaw === 'all' ? '*' : projectRaw;
  const stage = String(body?.stage || '').trim();
  const disabled = !!body?.disabled;
  const question = String(body?.question || '').trim().slice(0, 500);
  const allowedTypes = new Set(['confirm', 'text', 'single', 'multi']);
  const questionType = allowedTypes.has(String(body?.questionType || body?.question_type || '').trim()) ? String(body?.questionType || body?.question_type).trim() : 'confirm';
  const questionRequired = body?.questionRequired ?? body?.question_required;
  const options = uniqueTextList(body?.questionOptions || body?.question_options).slice(0, 20);
  return { project, stage, disabled, question, questionType, questionRequired: questionRequired == null ? true : !!questionRequired, questionOptions: options };
}

async function disabledReportControlsForLines(client, lines) {
  await ensureReportControlsTable();
  const normalized = (lines || []).map(line => ({
    project: String(line.project || '').trim(),
    stage: String(line.stage || '').trim(),
    product: Number(line.product)
  })).filter(line => line.project && line.stage);
  if (!normalized.length) return [];
  const stages = [...new Set(normalized.map(line => line.stage))];
  const projects = [...new Set(normalized.map(line => line.project))];
  const r = await client.query(
    `SELECT project, stage FROM report_controls
     WHERE disabled=TRUE AND stage=ANY($1) AND (project='*' OR project=ANY($2))`,
    [stages, projects]
  );
  const disabled = new Set(r.rows.map(row => `${row.project}#${row.stage}`));
  return normalized.filter(line => disabled.has(`*#${line.stage}`) || disabled.has(`${line.project}#${line.stage}`));
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
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS order_name TEXT");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS trailer TEXT");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS direction TEXT");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS size_label TEXT");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS unload_date DATE");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS carrier TEXT");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS note TEXT");
  await pool.query("ALTER TABLE transport_dates ADD COLUMN IF NOT EXISTS delay_note TEXT");
}

async function ensureTransportReplacementsTable() {
  await ensureTransportDatesTable();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transport_replacements (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      project TEXT NOT NULL,
      from_product INTEGER NOT NULL,
      to_product INTEGER NOT NULL,
      load_date DATE,
      lkw_number INTEGER,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureTransportExtrasTable() {
  await ensureTransportDatesTable();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transport_extras (
      id SERIAL PRIMARY KEY,
      project TEXT NOT NULL,
      product INTEGER NOT NULL,
      load_date DATE NOT NULL,
      lkw_number INTEGER,
      order_name TEXT,
      trailer TEXT,
      direction TEXT,
      size_label TEXT,
      unload_date DATE,
      carrier TEXT,
      note TEXT,
      delay_note TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureProjectsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      project TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      closed BOOLEAN NOT NULL DEFAULT FALSE,
      calculation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      imported_from_excel BOOLEAN NOT NULL DEFAULT FALSE,
      import_source TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS calculation_enabled BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS imported_from_excel BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS import_source TEXT");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_bathrooms (
      project TEXT NOT NULL REFERENCES projects(project) ON DELETE CASCADE,
      product INTEGER NOT NULL,
      external_id TEXT,
      rbr_type TEXT,
      ventilation_variant TEXT,
      visible_high_walls TEXT,
      requested_delivery TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, product)
    )
  `);
  await pool.query("ALTER TABLE project_bathrooms ADD COLUMN IF NOT EXISTS rbr_type TEXT");
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
  await pool.query("ALTER TABLE material_usages ADD COLUMN IF NOT EXISTS approved_by TEXT");
  await pool.query("ALTER TABLE material_usages ADD COLUMN IF NOT EXISTS approved_name TEXT");
  await pool.query("ALTER TABLE material_usages ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ");
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
      comment TEXT,
      checked_by TEXT,
      checked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, product, check_type)
    )
  `);
  await pool.query("ALTER TABLE bathroom_checks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query("ALTER TABLE bathroom_checks ADD COLUMN IF NOT EXISTS comment TEXT");
}

async function ensureQualityTables() {
  await ensureBathroomCommentsTable();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_items (
      project TEXT NOT NULL,
      item_name TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, item_name)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_records (
      project TEXT NOT NULL,
      product INTEGER NOT NULL,
      goat BOOLEAN NOT NULL DEFAULT FALSE,
      goat_done BOOLEAN NOT NULL DEFAULT FALSE,
      missing_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      resolved_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project, product)
    )
  `);
}

const uniqueTextList = value => {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(x => String(x || '').trim()).filter(Boolean))];
};

const allowDuplicateReportLine = line => {
  const stage = String(line?.stage || '').trim().toLowerCase();
  return stage === 'transport';
};

const todayWarsaw = () => {
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

async function saveQualityFromLine(client, line, actorCode) {
  if (String(line?.stage || '').trim() !== '18' || !line.quality) return;
  const project = String(line.project || '').trim();
  const product = Number(line.product);
  if (!project || !Number.isInteger(product)) return;
  const missingItems = uniqueTextList(line.quality.missingItems);
  const goat = !!line.quality.goat;
  if (!goat && !missingItems.length) return;

  await ensureQualityTables();
  for (const item of missingItems) {
    await client.query(
      `INSERT INTO quality_items (project, item_name, created_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (project, item_name) DO NOTHING`,
      [project, item, actorCode]
    );
  }
  const current = await client.query(
    'SELECT missing_items, resolved_items FROM quality_records WHERE project=$1 AND product=$2',
    [project, product]
  );
  const oldMissing = uniqueTextList(current.rows[0]?.missing_items);
  const oldResolved = uniqueTextList(current.rows[0]?.resolved_items);
  const mergedMissing = [...new Set([...oldMissing, ...missingItems])];
  const resolved = oldResolved.filter(item => !missingItems.includes(item));
  await client.query(
    `INSERT INTO quality_records (project, product, goat, goat_done, missing_items, resolved_items, updated_by, updated_at)
     VALUES ($1,$2,$3,FALSE,$4::jsonb,$5::jsonb,$6,NOW())
     ON CONFLICT (project, product) DO UPDATE SET
       goat = quality_records.goat OR EXCLUDED.goat,
       goat_done = CASE WHEN EXCLUDED.goat THEN FALSE ELSE quality_records.goat_done END,
       missing_items = EXCLUDED.missing_items,
       resolved_items = EXCLUDED.resolved_items,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [project, product, goat, JSON.stringify(mergedMissing), JSON.stringify(resolved), actorCode]
  );
  if (goat) {
    await client.query(
      `INSERT INTO bathroom_comments (project, product, comment, author_code, author_name)
       VALUES ($1,$2,$3,$4,$5)`,
      [project, product, 'Koza - kontrola jakosci', actorCode, actorCode]
    );
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function syncQualityItemsForProject(client, project) {
  const records = await client.query('SELECT missing_items FROM quality_records WHERE project=$1', [project]);
  const usedItems = [...new Set(records.rows.flatMap(row => uniqueTextList(row.missing_items)))];
  if (!usedItems.length) {
    await client.query('DELETE FROM quality_items WHERE project=$1', [project]);
    return;
  }
  await client.query('DELETE FROM quality_items WHERE project=$1 AND NOT (item_name = ANY($2::text[]))', [project, usedItems]);
}

function authOld(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });
  try { req.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); next(); }
  catch { res.status(401).json({ error: 'Nieprawidłowy token' }); }
}
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    await ensureUserSessionsTable();
    if (!payload.jti) {
      const legacy = await pool.query('SELECT token_version, is_blocked FROM users WHERE code=$1', [payload.code]);
      if (!legacy.rows.length || legacy.rows[0].is_blocked || Number(legacy.rows[0].token_version) !== Number(payload.tokenVersion || 0)) {
        return res.status(401).json({ error: 'Sesja wygasla. Zaloguj sie ponownie.' });
      }
      req.user = payload;
      return next();
    }
    const r = await pool.query(
      `SELECT s.id, s.revoked_at, u.token_version, u.is_blocked
       FROM user_sessions s JOIN users u ON u.code=s.user_code
       WHERE s.id=$1 AND s.user_code=$2`,
      [payload.jti, payload.code]
    );
    if (!r.rows.length || r.rows[0].revoked_at || r.rows[0].is_blocked || Number(r.rows[0].token_version) !== Number(payload.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Sesja wygasla. Zaloguj sie ponownie.' });
    }
    await pool.query('UPDATE user_sessions SET last_seen_at=NOW() WHERE id=$1', [payload.jti]);
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Nieprawidlowy token' });
  }
}
function managerOnly(req, res, next) {
  const role = req.user.role;
  const code = String(req.user.code || '').toUpperCase();
  if (role !== 'manager' && role !== 'kontroler' && role !== 'supervisor' && role !== 'admin' && code !== 'ADMIN' && code !== 'RBR056') return res.status(403).json({ error: 'Brak uprawnien' });
  next();
}

function supervisorOrAdminOnly(req, res, next) {
  const role = req.user.role;
  const code = String(req.user.code || '').toUpperCase();
  if (role !== 'supervisor' && role !== 'admin' && code !== 'ADMIN' && code !== 'RBR056') {
    return res.status(403).json({ error: 'Brak uprawnien' });
  }
  next();
}

const DEFAULT_ROLE_TABS = {
  worker: ['reports', 'maps', 'sessions', 'account'],
  'worker+': ['reports', 'maps', 'sessions', 'account'],
  kontroler: ['reports', 'production', 'warehouse', 'transport', 'quality', 'calculations', 'projects', 'maps', 'users', 'sessions', 'account'],
  manager: ['reports', 'production', 'warehouse', 'transport', 'quality', 'calculations', 'projects', 'maps', 'users', 'sessions', 'account'],
  viewer: ['reports', 'production', 'warehouse', 'transport', 'quality', 'calculations', 'projects', 'maps', 'users', 'sessions', 'account'],
  supervisor: ['reports', 'fertilization', 'production', 'warehouse', 'transport', 'quality', 'calculations', 'projects', 'maps', 'users', 'permissions', 'database', 'sessions', 'account'],
  admin: ['reports', 'fertilization', 'production', 'warehouse', 'transport', 'quality', 'calculations', 'projects', 'maps', 'users', 'permissions', 'database', 'sessions', 'account']
};

async function roleHasTab(role, tab) {
  const normalized = normalizeUserRole(role);
  if ((normalized === 'admin' || normalized === 'supervisor') && (tab === 'permissions' || tab === 'database' || tab === 'fertilization')) return true;
  await ensureRolePermissionsTable();
  const r = await pool.query('SELECT tabs FROM role_permissions WHERE role=$1', [normalized]);
  const tabs = r.rows.length && Array.isArray(r.rows[0].tabs) ? r.rows[0].tabs : (DEFAULT_ROLE_TABS[normalized] || DEFAULT_ROLE_TABS.worker);
  return tabs.includes(tab);
}

function requireTab(tab) {
  return async (req, res, next) => {
    try {
      if (await roleHasTab(req.user.role, tab)) return next();
      return res.status(403).json({ error: 'Brak uprawnien do zakladki: ' + tab });
    } catch (err) {
      return res.status(500).json({ error: 'Nie udalo sie sprawdzic uprawnien zakladki' });
    }
  };
}

function requireAnyTab(tabs) {
  return async (req, res, next) => {
    try {
      for (const tab of tabs) {
        if (await roleHasTab(req.user.role, tab)) return next();
      }
      return res.status(403).json({ error: 'Brak uprawnien do wymaganej zakladki' });
    } catch (err) {
      return res.status(500).json({ error: 'Nie udalo sie sprawdzic uprawnien zakladki' });
    }
  };
}

function normalizeUserRole(role) {
  const value = String(role || 'worker').trim().toLowerCase();
  return ['worker', 'worker+', 'kontroler', 'manager', 'viewer', 'supervisor', 'admin'].includes(value) ? value : 'worker';
}

function normalizeStageId(stage) {
  const value = String(stage || '').trim();
  return value.toLowerCase() === 'transport' ? 'transport' : value;
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
  const stages = [...new Set((lines || []).map(line => normalizeStageId(line.stage)).filter(Boolean))];
  if (!code || !stages.length) return [];
  await ensureStagePermissionsTable();
  const r = await client.query(
    `SELECT CASE WHEN LOWER(stage)='transport' THEN 'transport' ELSE stage END AS stage, array_agg(UPPER(worker_code)) AS workers
     FROM stage_permissions
     GROUP BY CASE WHEN LOWER(stage)='transport' THEN 'transport' ELSE stage END`
  );
  return stages.filter(stage => {
    const row = r.rows.find(item => normalizeStageId(item.stage) === stage);
    return !!(row && Array.isArray(row.workers) && row.workers.length && !row.workers.includes(code));
  });
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { code, password } = req.body;
  if (!code || !password) return res.status(400).json({ error: 'Podaj kod i haslo' });
  const loginCode = String(code || '').trim().toUpperCase();
  try {
    await ensureUsersBlockColumn();
    const r = await pool.query('SELECT * FROM users WHERE UPPER(code) = UPPER($1)', [loginCode]);
    const user = r.rows[0];
    if (!user) {
      await auditLog(req, 'login_failed', loginCode, { code: loginCode, reason: 'unknown_code' });
      return res.status(401).json({ error: 'Nie znaleziono konta dla tego kodu' });
    }
    if (user.is_blocked) {
      await auditLog(req, 'login_blocked', user.code, { reason: 'account_blocked' });
      return res.status(403).json({ error: 'Konto jest zablokowane. Skontaktuj sie z przelozonym.' });
    }
    if (user.lock_until && new Date(user.lock_until).getTime() > Date.now()) {
      await auditLog(req, 'login_blocked', user.code, { reason: 'temporary_lock', lockUntil: user.lock_until });
      return res.status(423).json({ error: 'Za duzo blednych prob. Konto chwilowo zablokowane.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const failedCount = Number(user.failed_login_count || 0) + 1;
      const lockUntil = failedCount >= LOGIN_LOCK_MAX ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000) : null;
      await pool.query('UPDATE users SET failed_login_count=$1, lock_until=$2, last_failed_login_at=NOW() WHERE code=$3', [failedCount, lockUntil, user.code]);
      await auditLog(req, 'login_failed', user.code, { reason: 'bad_password', failedCount, locked: !!lockUntil });
      return res.status(lockUntil ? 423 : 401).json({ error: lockUntil ? 'Za duzo blednych prob. Konto chwilowo zablokowane.' : 'Nieprawidlowe haslo' });
    }
    await ensureUserSessionsTable();
    await ensureUserStagePreferencesTable();
    await pool.query('UPDATE users SET failed_login_count=0, lock_until=NULL, last_login_at=NOW() WHERE code=$1', [user.code]);
    const freshUser = await pool.query('SELECT token_version FROM users WHERE code=$1', [user.code]);
    const tokenVersion = Number((freshUser.rows[0] && freshUser.rows[0].token_version) || 0);
    const prefs = await pool.query('SELECT visible_stages FROM user_stage_preferences WHERE user_code=$1', [user.code]);
    const visibleStages = prefs.rows.length && Array.isArray(prefs.rows[0].visible_stages)
      ? prefs.rows[0].visible_stages.map(normalizeStageId).filter(Boolean)
      : null;
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const token = jwt.sign({ code: user.code, name: user.name, role: user.role, mustChangePassword: !!user.must_change_password, visibleStages, jti: sessionId, tokenVersion }, JWT_SECRET, { expiresIn: '12h' });
    await pool.query(
      'INSERT INTO user_sessions (id, user_code, token_version, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [sessionId, user.code, tokenVersion, req.ip || req.socket.remoteAddress || '', String(req.headers['user-agent'] || '').slice(0, 500)]
    );
    await auditLog(req, 'login_success', user.code);
    res.json({ token, user: { code: user.code, name: user.name, role: user.role, mustChangePassword: user.must_change_password, visibleStages } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Blad serwera' }); }
});

app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const passwordError = passwordValidationError(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  try {
    const r = await pool.query('SELECT * FROM users WHERE code = $1', [req.user.code]);
    const user = r.rows[0];
    if (!user.must_change_password) {
      const valid = await bcrypt.compare(currentPassword || '', user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Aktualne haslo nieprawidlowe' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE code=$2', [hash, req.user.code]);
    await auditLog(req, 'password_changed', req.user.code);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Blad serwera' }); }
});
// ─── USERS ────────────────────────────────────────────────────────────────────
app.get('/api/sessions', auth, async (req, res) => {
  try {
    await ensureUserSessionsTable();
    const r = await pool.query(
      `SELECT id, ip, user_agent AS "userAgent", created_at AS "createdAt", last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt",
              CASE WHEN id=$2 THEN TRUE ELSE FALSE END AS "current"
       FROM user_sessions
       WHERE user_code=$1
       ORDER BY last_seen_at DESC
       LIMIT 50`,
      [req.user.code, req.user.jti]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu sesji' });
  }
});

app.post('/api/sessions/logout-all', auth, async (req, res) => {
  try {
    await ensureUserSessionsTable();
    await pool.query('UPDATE users SET token_version=token_version+1 WHERE code=$1', [req.user.code]);
    await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE user_code=$1 AND revoked_at IS NULL', [req.user.code]);
    await auditLog(req, 'sessions_logout_all', req.user.code);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad wylogowania sesji' });
  }
});

app.get('/api/users', auth, requireTab('users'), async (req, res) => {
  const role = req.user.role;
  const code = String(req.user.code || '').toUpperCase();
  if (role !== 'manager' && role !== 'kontroler' && role !== 'viewer' && role !== 'supervisor' && role !== 'admin' && code !== 'ADMIN' && code !== 'RBR056') {
    return res.status(403).json({ error: 'Brak uprawnien' });
  }
  try {
    await ensureUsersBlockColumn();
    const r = await pool.query("SELECT code, name, role, must_change_password, is_blocked, created_at FROM users WHERE code != 'ADMIN' ORDER BY name");
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/users', auth, requireTab('users'), managerOnly, async (req, res) => {
  const { code, name, password } = req.body;
  const userCode = String(code || '').trim().toUpperCase();
  const role = normalizeUserRole(req.body.role);
  const requesterCode = String(req.user.code || '').toUpperCase();
  if (!userCode || !name || !password) return res.status(400).json({ error: 'Nieprawidlowe dane' });
  const passwordError = passwordValidationError(password, { allowDefault: true });
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (!assertRoleAllowedForCode(userCode, role, res)) return;
  if (role === 'admin' && requesterCode !== 'ADMIN' && requesterCode !== 'RBR056') return res.status(403).json({ error: 'Tylko admin moze tworzyc konta admin' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const mustChange = password === 'zmien123' ? true : !(role === 'manager' || role === 'supervisor' || role === 'admin');
    await pool.query('INSERT INTO users (code, name, password_hash, must_change_password, role) VALUES ($1,$2,$3,$4,$5)', [userCode, name, hash, mustChange, role]);
    await auditLog(req, 'user_created', userCode, { role });
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Konto już istnieje' });
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.put('/api/users/:code/role', auth, requireTab('users'), managerOnly, async (req, res) => {
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
    await auditLog(req, 'user_role_changed', code, { from: targetRole, to: role });
    res.json({ success: true, code, role });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad serwera' });
  }
});

app.put('/api/users/:code/reset-password', auth, requireTab('users'), managerOnly, async (req, res) => {
  await ensureUsersBlockColumn();
  // Check if target user is a manager - only supervisor/admin can reset managers
  const target = await pool.query('SELECT role FROM users WHERE code=$1', [req.params.code]);
  if (target.rows.length > 0 && target.rows[0].role === 'manager') {
    if (req.user.role !== 'supervisor' && req.user.code !== 'ADMIN') {
      return res.status(403).json({ error: 'Tylko kierownik lub admin może resetować hasła menedżerów.' });
    }
  }
  const hash = await bcrypt.hash('zmien123', 10);
  await pool.query('UPDATE users SET password_hash=$1, must_change_password=TRUE, failed_login_count=0, lock_until=NULL WHERE code=$2', [hash, req.params.code]);
  await auditLog(req, 'password_reset', String(req.params.code || '').toUpperCase());
  res.json({ success: true });
});

app.put('/api/users/:code/block', auth, requireTab('users'), managerOnly, async (req, res) => {
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
    await auditLog(req, blocked ? 'user_blocked' : 'user_unblocked', code);
    res.json({ success: true, code, blocked });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd serwera' });
  }
});

app.delete('/api/users/:code', auth, requireTab('users'), managerOnly, async (req, res) => {
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
  await auditLog(req, 'user_deleted', code, { role: target.rows[0].role });
  res.json({ success: true });
});

app.get('/api/audit-logs', auth, requireTab('database'), managerOnly, async (req, res) => {
  try {
    await ensureAuditLogsTable();
    await pool.query("DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '60 days'");
    const r = await pool.query(
      `SELECT id, actor_code AS "actorCode", actor_role AS "actorRole", action, target, ip, user_agent AS "userAgent", details, created_at AS "createdAt"
       FROM audit_logs
       WHERE created_at >= NOW() - INTERVAL '60 days'
       ORDER BY created_at DESC
       LIMIT 20000`
    );
    const esc = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
    const header = ['id', 'createdAt', 'actorCode', 'actorRole', 'action', 'target', 'ip', 'userAgent', 'details'];
    const rows = r.rows.map(row => [
      row.id,
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      row.actorCode,
      row.actorRole,
      row.action,
      row.target,
      row.ip,
      row.userAgent,
      JSON.stringify(row.details || {})
    ].map(esc).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="flowrbr_historia_dzialan_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send([header.map(esc).join(';'), ...rows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu audytu' });
  }
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

app.put('/api/stage-permissions/:stage', auth, requireTab('users'), managerOnly, async (req, res) => {
  const stage = normalizeStageId(req.params.stage);
  const workerCodes = Array.isArray(req.body.workerCodes) ? req.body.workerCodes : [];
  const normalized = [...new Set(workerCodes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean))];
  if (!stage) return res.status(400).json({ error: 'Brak etapu' });
  const client = await pool.connect();
  try {
    await ensureStagePermissionsTable();
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM stage_permissions
       WHERE CASE WHEN LOWER(stage)='transport' THEN 'transport' ELSE stage END=$1`,
      [stage]
    );
    for (const code of normalized) {
      const exists = await client.query("SELECT code FROM users WHERE code=$1 AND role IN ('worker','worker+','kontroler')", [code]);
      if (!exists.rows.length) continue;
      await client.query(
        `INSERT INTO stage_permissions (stage, worker_code, updated_by, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (stage, worker_code) DO UPDATE SET updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [stage, code, req.user.code]
      );
    }
    await client.query('COMMIT');
    await auditLog(req, 'stage_permissions_changed', stage, { workerCodes: normalized });
    res.json({ success: true, stage, workerCodes: normalized });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad zapisu przypisan etapow' });
  } finally {
    client.release();
  }
});

app.get('/api/my-stage-preferences', auth, requireTab('reports'), async (req, res) => {
  try {
    await ensureUserStagePreferencesTable();
    const r = await pool.query(
      `SELECT visible_stages AS "visibleStages", updated_at AS "updatedAt"
       FROM user_stage_preferences WHERE user_code=$1`,
      [req.user.code]
    );
    if (!r.rows.length) return res.json({ visibleStages: null, updatedAt: null });
    const stages = Array.isArray(r.rows[0].visibleStages) ? r.rows[0].visibleStages : [];
    res.json({ visibleStages: stages.map(normalizeStageId).filter(Boolean), updatedAt: r.rows[0].updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu widocznych etapow' });
  }
});

app.put('/api/my-stage-preferences', auth, requireTab('reports'), async (req, res) => {
  try {
    await ensureUserStagePreferencesTable();
    const raw = Array.isArray(req.body?.visibleStages) ? req.body.visibleStages : [];
    const visibleStages = [...new Set(raw.map(normalizeStageId).filter(Boolean))];
    await pool.query(
      `INSERT INTO user_stage_preferences (user_code, visible_stages, updated_at)
       VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_code) DO UPDATE SET visible_stages=EXCLUDED.visible_stages, updated_at=NOW()`,
      [req.user.code, JSON.stringify(visibleStages)]
    );
    await auditLog(req, 'my_stage_preferences_changed', req.user.code, { visibleStages });
    res.json({ success: true, visibleStages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu widocznych etapow' });
  }
});

app.get('/api/role-permissions', auth, requireTab('permissions'), async (req, res) => {
  try {
    await ensureRolePermissionsTable();
    const r = await pool.query('SELECT role, tabs, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM role_permissions ORDER BY role');
    res.json(r.rows.map(row => ({ ...row, tabs: Array.isArray(row.tabs) ? row.tabs : [] })));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu uprawnien rol' });
  }
});

app.put('/api/role-permissions/:role', auth, requireTab('permissions'), supervisorOrAdminOnly, async (req, res) => {
  const role = normalizeUserRole(req.params.role);
  const allowedTabs = new Set(['reports', 'fertilization', 'production', 'warehouse', 'transport', 'quality', 'calculations', 'projects', 'maps', 'users', 'permissions', 'database', 'sessions', 'account']);
  const tabs = [...new Set((Array.isArray(req.body.tabs) ? req.body.tabs : []).map(tab => String(tab || '').trim()).filter(tab => allowedTabs.has(tab)))];
  if (role === 'admin' || role === 'supervisor') {
    if (!tabs.includes('permissions')) tabs.push('permissions');
    if (!tabs.includes('account')) tabs.push('account');
  }
  try {
    await ensureRolePermissionsTable();
    await pool.query(
      `INSERT INTO role_permissions (role, tabs, updated_by, updated_at)
       VALUES ($1,$2::jsonb,$3,NOW())
       ON CONFLICT (role) DO UPDATE SET tabs=EXCLUDED.tabs, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [role, JSON.stringify(tabs), req.user.code || null]
    );
    await auditLog(req, 'role_permissions_changed', role, { tabs });
    res.json({ role, tabs });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu uprawnien roli' });
  }
});

app.get('/api/fertilization', auth, requireTab('fertilization'), supervisorOrAdminOnly, async (req, res) => {
  try {
    await ensureFertilizationTable();
    const r = await pool.query(
      `SELECT project, delivery_date AS "deliveryDate", hall, car_capacity AS "carCapacity", note,
              updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM fertilization_settings
       ORDER BY CASE WHEN delivery_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN delivery_date ELSE '9999-12-31' END, project, delivery_date`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu nawozenia' });
  }
});

app.put('/api/fertilization', auth, requireTab('fertilization'), supervisorOrAdminOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const rawDeliveryDate = String(req.body.deliveryDate || req.body.delivery_date || '').trim();
  const deliveryDate = rawDeliveryDate === 'kolejnosc' ? 'kolejnosc' : rawDeliveryDate.slice(0, 10);
  const hall = String(req.body.hall || '').trim();
  const carCapacity = Math.max(0, Math.floor(Number(req.body.carCapacity || req.body.car_capacity || 0)));
  const note = String(req.body.note || '').trim();
  if (!project || !(/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || deliveryDate === 'kolejnosc')) return res.status(400).json({ error: 'Brak projektu lub daty terminu' });
  try {
    await ensureFertilizationTable();
    await pool.query(
      `INSERT INTO fertilization_settings (project, delivery_date, hall, car_capacity, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (project, delivery_date) DO UPDATE SET hall=EXCLUDED.hall, car_capacity=EXCLUDED.car_capacity,
         note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, deliveryDate, hall, carCapacity, note, req.user.code || null]
    );
    await auditLog(req, 'fertilization_changed', project + '#' + deliveryDate, { hall, carCapacity, note });
    res.json({ success: true, project, deliveryDate, hall, carCapacity, note });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu nawozenia' });
  }
});

app.delete('/api/fertilization', auth, requireTab('fertilization'), supervisorOrAdminOnly, async (req, res) => {
  const project = String(req.query.project || '').trim();
  const rawDeliveryDate = String(req.query.deliveryDate || req.query.delivery_date || '').trim();
  const deliveryDate = rawDeliveryDate === 'kolejnosc' ? 'kolejnosc' : rawDeliveryDate.slice(0, 10);
  if (!project || !(/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || deliveryDate === 'kolejnosc')) return res.status(400).json({ error: 'Brak projektu lub daty terminu' });
  try {
    await ensureFertilizationTable();
    await pool.query('DELETE FROM fertilization_settings WHERE project=$1 AND delivery_date=$2', [project, deliveryDate]);
    await auditLog(req, 'fertilization_deleted', project + '#' + deliveryDate);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad usuwania nawozenia' });
  }
});

// PROJECTS
app.get('/api/projects', auth, async (req, res) => {
  try {
    await ensureProjectsTables();
    const [projects, bathrooms] = await Promise.all([
      pool.query('SELECT project, count, closed, calculation_enabled AS "calculationEnabled", imported_from_excel AS "importedFromExcel", import_source AS "importSource", updated_by AS "updatedBy", updated_at AS "updatedAt", created_at AS "createdAt" FROM projects ORDER BY project'),
      pool.query(`SELECT project, product, external_id AS "externalId", rbr_type AS "rbrType", ventilation_variant AS "ventilationVariant",
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

app.post('/api/projects', auth, requireTab('projects'), managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const count = Number(req.body.count);
  if (!project || !Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'Brak numeru projektu lub ilosci lazienek' });
  try {
    await ensureProjectsTables();
    await pool.query(
      `INSERT INTO projects (project, count, closed, imported_from_excel, import_source, updated_by, updated_at)
       VALUES ($1,$2,FALSE,FALSE,NULL,$3,NOW())
       ON CONFLICT (project) DO UPDATE SET count=EXCLUDED.count, closed=FALSE, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, count, req.user.code]
    );
    await auditLog(req, 'project_saved', project, { count });
    res.json({ success: true, project, count });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu projektu' });
  }
});

app.put('/api/projects/:project', auth, requireTab('projects'), managerOnly, async (req, res) => {
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
    await auditLog(req, 'project_updated', project, { count: Number.isInteger(count) && count > 0 ? count : null, closed, calculationEnabled });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad edycji projektu' });
  }
});

app.post('/api/projects/import', auth, requireTab('projects'), managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const sourceFile = String(req.body.sourceFile || req.body.importSource || '').trim();
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
        rbrType: String(raw.rbrType || raw.rbr_type || '').trim(),
        ventilationVariant: String(raw.ventilationVariant || '').trim(),
        visibleHighWalls: String(raw.visibleHighWalls || '').trim(),
        requestedDelivery: String(raw.requestedDelivery || '').trim()
      }))
      .filter(row => Number.isInteger(row.product) && row.product > 0);
    const count = Math.max(Number(req.body.count) || 0, ...normalized.map(row => row.product));
    if (!count) return res.status(400).json({ error: 'Nie znaleziono numerow lazienek w pliku' });
    await client.query(
      `INSERT INTO projects (project, count, closed, imported_from_excel, import_source, updated_by, updated_at)
       VALUES ($1,$2,FALSE,TRUE,$3,$4,NOW())
       ON CONFLICT (project) DO UPDATE SET count=EXCLUDED.count, closed=FALSE,
         imported_from_excel=TRUE, import_source=COALESCE(EXCLUDED.import_source, projects.import_source),
         updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, count, sourceFile || null, req.user.code]
    );
    await client.query(
      'DELETE FROM project_bathrooms WHERE project=$1 AND NOT (product = ANY($2::int[]))',
      [project, normalized.map(row => row.product)]
    );
    for (const row of normalized) {
      await client.query(
        `INSERT INTO project_bathrooms (project, product, external_id, rbr_type, ventilation_variant, visible_high_walls, requested_delivery, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (project, product) DO UPDATE SET external_id=EXCLUDED.external_id, rbr_type=EXCLUDED.rbr_type,
           ventilation_variant=EXCLUDED.ventilation_variant, visible_high_walls=EXCLUDED.visible_high_walls,
           requested_delivery=EXCLUDED.requested_delivery, updated_at=NOW()`,
        [project, row.product, row.externalId, row.rbrType, row.ventilationVariant, row.visibleHighWalls, row.requestedDelivery]
      );
    }
    await client.query('COMMIT');
    await auditLog(req, 'project_imported', project, { count, imported: normalized.length, sourceFile });
    res.json({ success: true, project, count, imported: normalized.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad importu projektu' });
  } finally {
    client.release();
  }
});

app.get('/api/material-usages', auth, requireTab('calculations'), async (req, res) => {
  try {
    await ensureMaterialUsagesTable();
    const r = await pool.query(
      `SELECT id, project, product, stage, type_key AS "typeKey", type_label AS "typeLabel", data,
              worker_code AS "workerCode", worker_name AS "workerName", report_date::text AS "reportDate",
              approved_by AS "approvedBy", approved_name AS "approvedName", approved_at AS "approvedAt",
              created_at AS "createdAt"
       FROM material_usages
       ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu kalkulacji' });
  }
});

app.get('/api/calculation-stages', auth, async (req, res) => {
  try {
    await ensureCalculationStagesTable();
    const r = await pool.query(
      `SELECT stage, fields, updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM calculation_stages ORDER BY stage`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu etapow kalkulacji' });
  }
});

app.put('/api/calculation-stages/:stage', auth, requireTab('calculations'), managerOnly, async (req, res) => {
  const stage = String(req.params.stage || '').trim();
  const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];
  const normalized = fields
    .map(field => Array.isArray(field) ? field : [field.key, field.label, field.type])
    .map(field => [
      String(field[0] || '').trim(),
      String(field[1] || '').trim(),
      ['text', 'number', 'checkbox'].includes(String(field[2] || '').trim()) ? String(field[2] || '').trim() : 'text'
    ])
    .filter(field => field[0] && field[1]);
  if (!stage) return res.status(400).json({ error: 'Brak etapu kalkulacji' });
  try {
    await ensureCalculationStagesTable();
    await pool.query(
      `INSERT INTO calculation_stages (stage, fields, updated_by, updated_at)
       VALUES ($1,$2::jsonb,$3,NOW())
       ON CONFLICT (stage) DO UPDATE SET fields=EXCLUDED.fields, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [stage, JSON.stringify(normalized), req.user.code]
    );
    await auditLog(req, 'calculation_stage_saved', stage, { fields: normalized });
    res.json({ success: true, stage, fields: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu etapu kalkulacji' });
  }
});

app.delete('/api/calculation-stages/:stage', auth, requireTab('calculations'), managerOnly, async (req, res) => {
  const stage = String(req.params.stage || '').trim();
  if (!stage) return res.status(400).json({ error: 'Brak etapu kalkulacji' });
  try {
    await ensureCalculationStagesTable();
    const r = await pool.query('DELETE FROM calculation_stages WHERE stage=$1', [stage]);
    await auditLog(req, 'calculation_stage_deleted', stage, { deleted: r.rowCount || 0 });
    res.json({ success: true, stage, deleted: r.rowCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad usuwania etapu kalkulacji' });
  }
});

app.post('/api/material-usages', auth, requireTab('reports'), async (req, res) => {
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

app.put('/api/material-usages/:id', auth, requireTab('calculations'), managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  const product = Number(req.body.product);
  const typeLabel = String(req.body.typeLabel || '').trim();
  const data = req.body.data && typeof req.body.data === 'object' ? req.body.data : {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Nieprawidlowe ID kalkulacji' });
  if (!Number.isInteger(product) || product < 1) return res.status(400).json({ error: 'Nieprawidlowy numer lazienki' });
  try {
    await ensureMaterialUsagesTable();
    const r = await pool.query(
      `UPDATE material_usages
       SET product=$2, type_label=$3, data=$4::jsonb
       WHERE id=$1
       RETURNING id, project, product, stage, type_key AS "typeKey", type_label AS "typeLabel", data,
                 worker_code AS "workerCode", worker_name AS "workerName", report_date::text AS "reportDate",
                 approved_by AS "approvedBy", approved_name AS "approvedName", approved_at AS "approvedAt",
                 created_at AS "createdAt"`,
      [id, product, typeLabel || null, JSON.stringify(data)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nie znaleziono kalkulacji' });
    await auditLog(req, 'material_usage_updated', String(id), { product, typeLabel, data });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad edycji kalkulacji' });
  }
});

app.put('/api/material-usages/:id/approve', auth, requireTab('calculations'), managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Nieprawidlowe ID kalkulacji' });
  try {
    await ensureMaterialUsagesTable();
    const r = await pool.query(
      `UPDATE material_usages
       SET approved_by=$2, approved_name=$3, approved_at=NOW()
       WHERE id=$1
       RETURNING id, project, product, stage, type_key AS "typeKey", type_label AS "typeLabel", data,
                 worker_code AS "workerCode", worker_name AS "workerName", report_date::text AS "reportDate",
                 approved_by AS "approvedBy", approved_name AS "approvedName", approved_at AS "approvedAt",
                 created_at AS "createdAt"`,
      [id, req.user.code, req.user.name || req.user.code]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nie znaleziono kalkulacji' });
    await auditLog(req, 'material_usage_approved', String(id), r.rows[0]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zatwierdzania kalkulacji' });
  }
});

app.delete('/api/material-usages/:id', auth, requireTab('calculations'), managerOnly, async (req, res) => {
  try {
    await ensureMaterialUsagesTable();
    const r = await pool.query('DELETE FROM material_usages WHERE id=$1 RETURNING id, project, product, stage, type_key', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nie znaleziono kalkulacji' });
    await auditLog(req, 'material_usage_deleted', String(req.params.id), r.rows[0]);
    res.json({ success: true, deleted: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad usuwania kalkulacji' });
  }
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/api/quality', auth, requireTab('quality'), async (req, res) => {
  try {
    await ensureQualityTables();
    const items = await pool.query(
      `SELECT project, item_name AS "itemName", created_by AS "createdBy", created_at AS "createdAt"
       FROM quality_items ORDER BY project, item_name`
    );
    const records = await pool.query(
      `SELECT project, product, goat, goat_done AS "goatDone", missing_items AS "missingItems",
        resolved_items AS "resolvedItems", updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM quality_records ORDER BY project, product`
    );
    res.json({ items: items.rows, records: records.rows });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu kontroli jakosci' });
  }
});

app.put('/api/quality-record', auth, requireTab('quality'), managerOnly, async (req, res) => {
  try {
    await ensureQualityTables();
    const project = String(req.body?.project || '').trim();
    const product = Number(req.body?.product);
    if (!project || !Number.isInteger(product)) return res.status(400).json({ error: 'Brak projektu lub numeru lazienki' });
    const current = await pool.query('SELECT * FROM quality_records WHERE project=$1 AND product=$2', [project, product]);
    if (!current.rows.length) return res.status(404).json({ error: 'Nie znaleziono wpisu kontroli jakosci' });
    const hasMissingItemsPatch = Object.prototype.hasOwnProperty.call(req.body || {}, 'missingItems');
    const currentMissing = uniqueTextList(current.rows[0]?.missing_items);
    const missingItems = hasMissingItemsPatch ? uniqueTextList(req.body?.missingItems) : currentMissing;
    for (const item of missingItems) {
      await pool.query(
        `INSERT INTO quality_items (project, item_name, created_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (project, item_name) DO NOTHING`,
        [project, item, req.user.code]
      );
    }
    const resolvedItems = uniqueTextList(req.body?.resolvedItems).filter(item => missingItems.includes(item));
    const goatDone = !!req.body?.goatDone;
    const r = await pool.query(
      `UPDATE quality_records
       SET goat_done=$3, resolved_items=$4::jsonb, missing_items=$5::jsonb, updated_by=$6, updated_at=NOW()
       WHERE project=$1 AND product=$2
       RETURNING project, product, goat, goat_done AS "goatDone", missing_items AS "missingItems",
        resolved_items AS "resolvedItems", updated_by AS "updatedBy", updated_at AS "updatedAt"`,
      [project, product, goatDone, JSON.stringify(resolvedItems), JSON.stringify(missingItems), req.user.code]
    );
    await syncQualityItemsForProject(pool, project);
    await auditLog(req, 'quality_record_updated', project + '#' + product, { goatDone, resolvedItems, missingItems });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu kontroli jakosci' });
  }
});

app.put('/api/quality-items', auth, requireTab('quality'), managerOnly, async (req, res) => {
  const project = String(req.body?.project || '').trim();
  const oldName = String(req.body?.oldName || '').trim();
  const newName = String(req.body?.newName || '').trim();
  if (!project || !oldName || !newName) return res.status(400).json({ error: 'Brak projektu lub nazwy braku' });
  if (oldName === newName) return res.json({ success: true, project, oldName, newName });
  const client = await pool.connect();
  try {
    await ensureQualityTables();
    await client.query('BEGIN');
    const exists = await client.query('SELECT item_name FROM quality_items WHERE project=$1 AND item_name=$2', [project, oldName]);
    if (!exists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nie znaleziono braku do zmiany' });
    }
    await client.query(
      `INSERT INTO quality_items (project, item_name, created_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (project, item_name) DO NOTHING`,
      [project, newName, req.user.code]
    );
    await client.query('DELETE FROM quality_items WHERE project=$1 AND item_name=$2', [project, oldName]);
    const records = await client.query('SELECT project, product, missing_items, resolved_items FROM quality_records WHERE project=$1', [project]);
    for (const row of records.rows) {
      const missing = uniqueTextList(row.missing_items).map(item => item === oldName ? newName : item);
      const resolved = uniqueTextList(row.resolved_items).map(item => item === oldName ? newName : item);
      await client.query(
        `UPDATE quality_records SET missing_items=$3::jsonb, resolved_items=$4::jsonb, updated_by=$5, updated_at=NOW()
         WHERE project=$1 AND product=$2`,
        [row.project, row.product, JSON.stringify([...new Set(missing)]), JSON.stringify([...new Set(resolved)]), req.user.code]
      );
    }
    await client.query('COMMIT');
    await auditLog(req, 'quality_item_renamed', project, { oldName, newName });
    res.json({ success: true, project, oldName, newName });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad zmiany braku' });
  } finally {
    client.release();
  }
});

app.delete('/api/quality-items', auth, requireTab('quality'), managerOnly, async (req, res) => {
  const project = String(req.query?.project || '').trim();
  const itemName = String(req.query?.itemName || '').trim();
  if (!project || !itemName) return res.status(400).json({ error: 'Brak projektu lub nazwy braku' });
  const client = await pool.connect();
  try {
    await ensureQualityTables();
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM quality_items WHERE project=$1 AND item_name=$2', [project, itemName]);
    const records = await client.query('SELECT project, product, missing_items, resolved_items FROM quality_records WHERE project=$1', [project]);
    for (const row of records.rows) {
      const missing = uniqueTextList(row.missing_items).filter(item => item !== itemName);
      const resolved = uniqueTextList(row.resolved_items).filter(item => item !== itemName);
      await client.query(
        `UPDATE quality_records SET missing_items=$3::jsonb, resolved_items=$4::jsonb, updated_by=$5, updated_at=NOW()
         WHERE project=$1 AND product=$2`,
        [row.project, row.product, JSON.stringify(missing), JSON.stringify(resolved), req.user.code]
      );
    }
    await client.query('COMMIT');
    await auditLog(req, 'quality_item_deleted', project, { itemName, deleted: del.rowCount || 0 });
    res.json({ success: true, project, itemName, deleted: del.rowCount || 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad usuwania braku' });
  } finally {
    client.release();
  }
});

app.get('/api/reports', auth, requireTab('reports'), async (req, res) => {
  try {
    await ensureReportsCreatedByColumn();
    const isManager = true;
    const q = `
      SELECT r.id, r.worker_code, u.name as worker_name, r.created_by, cu.name as created_by_name, r.report_date::text as date, r.created_at,
        json_agg(json_build_object('id',rl.id,'project',rl.project,'product',rl.product,
          'stage',rl.stage,'contractor',rl.contractor_code,'note',rl.note,'hall',rl.hall) ORDER BY rl.id) as lines
      FROM reports r JOIN users u ON r.worker_code=u.code JOIN report_lines rl ON rl.report_id=r.id
      LEFT JOIN users cu ON r.created_by=cu.code
      ${isManager ? '' : 'WHERE r.worker_code=$1'}
      GROUP BY r.id, u.name, cu.name ORDER BY r.report_date DESC, r.created_at DESC`;
    const r = await pool.query(q, isManager ? [] : [req.user.code]);
    // Normalize for frontend
    const rows = r.rows.map(row => ({
      ...row,
      workerLogin: row.worker_code,
      workerName: row.worker_name,
      createdBy: row.created_by || row.worker_code,
      createdByName: row.created_by_name || row.worker_name,
      createdAt: row.created_at
    }));
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/reports', auth, requireTab('reports'), async (req, res) => {
  const { date, lines } = req.body;
  if (!date || !lines?.length) return res.status(400).json({ error: 'Brak danych' });
  const client = await pool.connect();
  try {
    await ensureReportsCreatedByColumn();
    await client.query('BEGIN');
    const forbidden = await forbiddenStagesForWorker(client, req.user.code, lines);
    if (forbidden.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Brak uprawnien do raportu na etapie: ${forbidden.map(stage => stage).join(', ')}` });
    }
    const disabled = await disabledReportControlsForLines(client, lines);
    if (disabled.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Raportowanie wylaczone dla: ${disabled.map(line => `${line.project}/laz.${line.product}/${line.stage}`).join(', ')}` });
    }
    const r = await client.query('INSERT INTO reports (worker_code, report_date, created_by) VALUES ($1,$2,$3) RETURNING id', [req.user.code, date, req.user.code]);
    const reportId = r.rows[0].id;
    const productionHallMap = await productionHallMapFromLayouts(client);

    const skipped = [];
    const saved = [];

    for (const line of lines) {
      // Check if this project+product+stage already exists in DB
      if (!allowDuplicateReportLine(line)) {
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
      }
      const productionHall = productionHallForLine(line, productionHallMap);
      await client.query(
        'INSERT INTO report_lines (report_id,project,product,stage,contractor_code,note,hall) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [reportId, line.project, line.product, line.stage, line.contractor || null, line.note || '', productionHall]
      );
      await saveQualityFromLine(client, line, req.user.code);
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

app.delete('/api/report-lines/:id', auth, requireTab('reports'), async (req, res) => {
  try {
    // Worker can only delete their own lines, manager can delete any
    const actorCode = String(req.user.code || '').toUpperCase();
    const isManager = req.user.role === 'manager' || req.user.role === 'supervisor' || req.user.role === 'admin' || actorCode === 'ADMIN' || actorCode === 'RBR056';
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
    await auditLog(req, 'report_line_deleted', String(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.delete('/api/reports/:id', auth, requireTab('reports'), async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureMaterialUsagesTable();
    await client.query('BEGIN');
    const report = await client.query('SELECT id, worker_code, report_date::text AS report_date FROM reports WHERE id=$1', [req.params.id]);
    if (!report.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nie znaleziono raportu' });
    }
    const actorCode = String(req.user.code || '').toUpperCase();
    const role = String(req.user.role || '').toLowerCase();
    const isManager = role === 'manager' || role === 'supervisor' || role === 'admin' || actorCode === 'ADMIN' || actorCode === 'RBR056';
    const isOwnReport = String(report.rows[0].worker_code || '').toUpperCase() === actorCode;
    const isTodayReport = String(report.rows[0].report_date || '').slice(0, 10) === todayWarsaw();
    if (!isManager && (!isOwnReport || !isTodayReport)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Pracownik moze usunac tylko swoj raport z dzisiejszego dnia' });
    }
    const lines = await client.query('SELECT project, product, stage FROM report_lines WHERE report_id=$1', [req.params.id]);
    let deletedCalculations = 0;
    let deletedQuality = 0;
    for (const line of lines.rows) {
      const del = await client.query(
        `DELETE FROM material_usages
         WHERE project=$1 AND product=$2 AND stage=$3 AND worker_code=$4 AND report_date=$5`,
        [line.project, line.product, line.stage, report.rows[0].worker_code, report.rows[0].report_date]
      );
      deletedCalculations += del.rowCount || 0;
      if (String(line.stage) === '18') {
        const qdel = await client.query('DELETE FROM quality_records WHERE project=$1 AND product=$2', [line.project, line.product]);
        deletedQuality += qdel.rowCount || 0;
      }
    }
    await client.query('DELETE FROM reports WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await auditLog(req, 'report_deleted', String(req.params.id), { deletedCalculations, deletedQuality });
    res.json({ success: true, deletedCalculations, deletedQuality });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad usuwania raportu' });
  } finally {
    client.release();
  }
});

// Manager adds report on behalf of a worker
app.post('/api/reports/as-worker', auth, requireTab('reports'), managerOnly, async (req, res) => {
  const { workerCode, date, lines } = req.body;
  if (!workerCode || !date || !lines?.length) return res.status(400).json({ error: 'Brak danych' });
  if (req.user.role === 'kontroler' && String(workerCode || '').toUpperCase() !== String(req.user.code || '').toUpperCase()) {
    return res.status(403).json({ error: 'Kontroler moze dodac raport tylko za siebie' });
  }
  const client = await pool.connect();
  try {
    await ensureReportsCreatedByColumn();
    await client.query('BEGIN');
    const forbidden = await forbiddenStagesForWorker(client, workerCode, lines);
    if (forbidden.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Brak uprawnien do raportu dla tego pracownika na etapie: ${forbidden.map(stage => stage).join(', ')}` });
    }
    const disabled = await disabledReportControlsForLines(client, lines);
    if (disabled.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Raportowanie wylaczone dla: ${disabled.map(line => `${line.project}/laz.${line.product}/${line.stage}`).join(', ')}` });
    }
    const r = await client.query('INSERT INTO reports (worker_code, report_date, created_by) VALUES ($1,$2,$3) RETURNING id', [workerCode, date, req.user.code]);
    const reportId = r.rows[0].id;
    const productionHallMap = await productionHallMapFromLayouts(client);
    const skipped = [], saved = [];
    for (const line of lines) {
      if (!allowDuplicateReportLine(line)) {
        const exists = await client.query(
          `SELECT rl.id FROM report_lines rl JOIN reports r ON rl.report_id = r.id
           WHERE rl.project=$1 AND rl.product=$2 AND rl.stage=$3`,
          [line.project, line.product, line.stage]
        );
        if (exists.rows.length > 0) { skipped.push(line); continue; }
      }
      const productionHall = productionHallForLine(line, productionHallMap);
      await client.query(
        'INSERT INTO report_lines (report_id,project,product,stage,contractor_code,note,hall) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [reportId, line.project, line.product, line.stage, line.contractor || workerCode, line.note || '', productionHall]
      );
      await saveQualityFromLine(client, line, workerCode);
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
app.get('/api/maps-layouts', auth, requireTab('maps'), async (req, res) => {
  try {
    await ensureMapLayoutsTable();
    const r = await pool.query("SELECT layouts, photos, map_dates, map_widths, map_starts FROM map_layouts WHERE id='main'");
    const layouts = normalizeMapLayouts(r.rows[0]?.layouts || {});
    res.json({
      layouts,
      photos: normalizeMapPhotos(r.rows[0]?.photos || {}),
      mapDates: normalizeMapDates(r.rows[0]?.map_dates || {}),
      mapWidths: normalizeMapWidths(r.rows[0]?.map_widths || {}, layouts),
      mapStarts: normalizeMapStarts(r.rows[0]?.map_starts || {}, layouts)
    });
  } catch (err) {
    console.error('Maps layouts GET error:', err);
    res.status(500).json({ error: err.message || 'Błąd odczytu map' });
  }
});

app.put('/api/maps-layouts', auth, requireTab('maps'), canManageMaps, async (req, res) => {
  try {
    await ensureMapLayoutsTable();
    const layouts = normalizeMapLayouts(req.body?.layouts || {});
    const mapDates = normalizeMapDates(req.body?.mapDates || {});
    const mapWidths = normalizeMapWidths(req.body?.mapWidths || {}, layouts);
    const mapStarts = normalizeMapStarts(req.body?.mapStarts || {}, layouts);
    await pool.query(
      `INSERT INTO map_layouts (id, layouts, map_dates, map_widths, map_starts, updated_by, updated_at)
       VALUES ('main', $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET layouts=EXCLUDED.layouts, map_dates=EXCLUDED.map_dates, map_widths=EXCLUDED.map_widths, map_starts=EXCLUDED.map_starts, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [JSON.stringify(layouts), JSON.stringify(mapDates), JSON.stringify(mapWidths), JSON.stringify(mapStarts), req.user.code]
    );
    await auditLog(req, 'maps_layout_changed', 'main');
    res.json({ success: true, layouts, mapDates, mapWidths, mapStarts });
  } catch (err) {
    console.error('Maps layouts PUT error:', err);
    res.status(500).json({ error: err.message || 'Błąd zapisu map' });
  }
});

app.put('/api/maps-photos', auth, requireTab('maps'), canManageMaps, async (req, res) => {
  try {
    await ensureMapLayoutsTable();
    const photos = normalizeMapPhotos(req.body?.photos || {});
    await pool.query(
      `INSERT INTO map_layouts (id, layouts, photos, updated_by, updated_at)
       VALUES ('main', '{}'::jsonb, $1::jsonb, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET photos=EXCLUDED.photos, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [JSON.stringify(photos), req.user.code]
    );
    await auditLog(req, 'maps_photos_changed', 'main');
    res.json({ success: true, photos });
  } catch (err) {
    console.error('Maps photos PUT error:', err);
    res.status(500).json({ error: err.message || 'Błąd zapisu zdjęcia mapy' });
  }
});

app.get('/api/report-controls', auth, requireTab('reports'), async (req, res) => {
  try {
    await ensureReportControlsTable();
    const r = await pool.query(
      `SELECT project, stage, disabled, question, question_type AS "questionType",
        question_required AS "questionRequired", question_options AS "questionOptions",
        updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM report_controls
       ORDER BY project, stage`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu ustawien raportowania' });
  }
});

app.put('/api/report-controls', auth, requireTab('projects'), managerOnly, async (req, res) => {
  const item = normalizeReportControlInput(req.body || {});
  if (!item.stage) return res.status(400).json({ error: 'Wybierz etap' });
  try {
    await ensureReportControlsTable();
    if (!item.disabled && !item.question) {
      await pool.query('DELETE FROM report_controls WHERE project=$1 AND stage=$2', [item.project, item.stage]);
      await auditLog(req, 'report_control_deleted', item.project + '#' + item.stage);
      return res.json({ success: true, deleted: true });
    }
    const r = await pool.query(
      `INSERT INTO report_controls (project, stage, disabled, question, question_type, question_required, question_options, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW())
       ON CONFLICT (project, stage) DO UPDATE SET disabled=EXCLUDED.disabled, question=EXCLUDED.question,
         question_type=EXCLUDED.question_type, question_required=EXCLUDED.question_required,
         question_options=EXCLUDED.question_options, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING project, stage, disabled, question, question_type AS "questionType",
        question_required AS "questionRequired", question_options AS "questionOptions",
        updated_by AS "updatedBy", updated_at AS "updatedAt"`,
      [item.project, item.stage, item.disabled, item.question, item.questionType, item.questionRequired, JSON.stringify(item.questionOptions), req.user.code]
    );
    await auditLog(req, 'report_control_changed', item.project + '#' + item.stage, item);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu ustawien raportowania' });
  }
});

app.delete('/api/report-controls', auth, requireTab('projects'), managerOnly, async (req, res) => {
  const item = normalizeReportControlInput(req.query || {});
  if (!item.stage) return res.status(400).json({ error: 'Wybierz etap' });
  try {
    await ensureReportControlsTable();
    const r = await pool.query('DELETE FROM report_controls WHERE project=$1 AND stage=$2', [item.project, item.stage]);
    await auditLog(req, 'report_control_deleted', item.project + '#' + item.stage);
    res.json({ success: true, deleted: r.rowCount > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad usuwania ustawien raportowania' });
  }
});

app.get('/api/transport-dates', auth, requireAnyTab(['transport', 'maps', 'warehouse']), async (req, res) => {
  try {
    await ensureTransportDatesTable();
    await ensureTransportExtrasTable();
    const r = await pool.query(
      `SELECT * FROM (
       SELECT project, product, load_date::text AS "loadDate", lkw_number AS "lkwNumber",
              order_name AS "orderName", trailer, direction, size_label AS "sizeLabel",
              unload_date::text AS "unloadDate", carrier, note, delay_note AS "delayNote",
              updated_by AS "updatedBy", updated_at AS "updatedAt", FALSE AS extra, NULL::integer AS "extraId"
       FROM transport_dates
       UNION ALL
       SELECT project, product, load_date::text AS "loadDate", lkw_number AS "lkwNumber",
              order_name AS "orderName", trailer, direction, size_label AS "sizeLabel",
              unload_date::text AS "unloadDate", carrier, note, delay_note AS "delayNote",
              updated_by AS "updatedBy", updated_at AS "updatedAt", TRUE AS extra, id AS "extraId"
       FROM transport_extras
      ) transport_all
       ORDER BY "loadDate", project, COALESCE("lkwNumber", 999999), product, "extraId"`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd odczytu transportu' });
  }
});

app.get('/api/transport-replacements', auth, requireTab('transport'), async (req, res) => {
  try {
    await ensureTransportReplacementsTable();
    const r = await pool.query(
      `SELECT id, mode, project, from_product AS "fromProduct", to_product AS "toProduct",
              load_date::text AS "loadDate", lkw_number AS "lkwNumber", details,
              created_by AS "createdBy", created_at AS "createdAt"
       FROM transport_replacements
       ORDER BY created_at DESC, id DESC`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad odczytu podmian transportu' });
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
      `SELECT project, product, check_type AS "checkType", checked, status, comment,
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
  const comment = String(req.body.comment || '').trim().slice(0, 600) || null;
  if (!project || !Number.isInteger(product) || product < 1) return res.status(400).json({ error: 'Brak projektu lub numeru lazienki' });
  try {
    await ensureBathroomChecksTable();
    await pool.query(
      `INSERT INTO bathroom_checks (project, product, check_type, checked, status, comment, checked_by, checked_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4 THEN NOW() ELSE NULL END,NOW())
       ON CONFLICT (project, product, check_type)
       DO UPDATE SET checked=EXCLUDED.checked, status=EXCLUDED.status, comment=EXCLUDED.comment, checked_by=EXCLUDED.checked_by,
         checked_at=EXCLUDED.checked_at, updated_at=NOW()`,
      [project, product, checkType, checked, status, comment, checked ? req.user.code : null]
    );
    res.json({ success: true, project, product, checkType, checked, status, comment });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad zapisu kontroli' });
  }
});

app.put('/api/transport-dates', auth, requireTab('transport'), managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const product = Number(req.body.product);
  const loadDate = String(req.body.loadDate || '').trim();
  const unloadDate = String(req.body.unloadDate || '').trim();
  const cleanText = (value, max = 240) => String(value || '').trim().slice(0, max) || null;
  const orderName = cleanText(req.body.orderName);
  const trailer = cleanText(req.body.trailer);
  const direction = cleanText(req.body.direction);
  const sizeLabel = cleanText(req.body.sizeLabel);
  const carrier = cleanText(req.body.carrier);
  const note = cleanText(req.body.note, 1000);
  const delayNote = cleanText(req.body.delayNote, 500);
  let lkwNumber = req.body.lkwNumber === '' || req.body.lkwNumber == null ? null : Number(req.body.lkwNumber);
  if (!project || !Number.isInteger(product) || product < 1) return res.status(400).json({ error: 'Brak projektu lub numeru łazienki' });
  try {
    await ensureTransportDatesTable();
    if (!loadDate) {
      await pool.query('DELETE FROM transport_dates WHERE project=$1 AND product=$2', [project, product]);
      await auditLog(req, 'transport_deleted', `${project}#${product}`, { project, product });
      return res.json({ success: true, deleted: true });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(loadDate)) return res.status(400).json({ error: 'Nieprawidłowa data załadunku' });
    if (unloadDate && !/^\d{4}-\d{2}-\d{2}$/.test(unloadDate)) return res.status(400).json({ error: 'Nieprawidlowa data rozladunku' });
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
      `INSERT INTO transport_dates (
         project, product, load_date, lkw_number, order_name, trailer, direction, size_label,
         unload_date, carrier, note, delay_note, updated_by, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (project, product) DO UPDATE SET
         load_date=EXCLUDED.load_date, lkw_number=EXCLUDED.lkw_number, order_name=EXCLUDED.order_name,
         trailer=EXCLUDED.trailer, direction=EXCLUDED.direction, size_label=EXCLUDED.size_label,
         unload_date=EXCLUDED.unload_date, carrier=EXCLUDED.carrier, note=EXCLUDED.note,
         delay_note=EXCLUDED.delay_note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, product, loadDate, lkwNumber, orderName, trailer, direction, sizeLabel, unloadDate || null, carrier, note, delayNote, req.user.code]
    );
    await auditLog(req, 'transport_saved', `${project}#${product}`, { project, product, loadDate, lkwNumber });
    res.json({ success: true, project, product, loadDate, lkwNumber, orderName, trailer, direction, sizeLabel, unloadDate, carrier, note, delayNote });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Błąd zapisu transportu' });
  }
});

app.post('/api/transport-extra', auth, requireTab('transport'), managerOnly, async (req, res) => {
  const project = String(req.body.project || '').trim();
  const product = Number(req.body.product);
  const loadDate = String(req.body.loadDate || '').trim();
  const unloadDate = String(req.body.unloadDate || '').trim();
  const cleanText = (value, max = 240) => String(value || '').trim().slice(0, max) || null;
  const lkwNumber = req.body.lkwNumber === '' || req.body.lkwNumber == null ? null : Number(req.body.lkwNumber);
  if (!project || !Number.isInteger(product) || product < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(loadDate)) {
    return res.status(400).json({ error: 'Brak projektu, lazienki lub daty zaladunku' });
  }
  if (lkwNumber !== null && (!Number.isInteger(lkwNumber) || lkwNumber < 1)) return res.status(400).json({ error: 'Nieprawidlowy numer LKW' });
  if (unloadDate && !/^\d{4}-\d{2}-\d{2}$/.test(unloadDate)) return res.status(400).json({ error: 'Nieprawidlowa data rozladunku' });
  try {
    await ensureTransportExtrasTable();
    const r = await pool.query(
      `INSERT INTO transport_extras (
         project, product, load_date, lkw_number, order_name, trailer, direction, size_label,
         unload_date, carrier, note, delay_note, updated_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        project, product, loadDate, lkwNumber, cleanText(req.body.orderName), cleanText(req.body.trailer),
        cleanText(req.body.direction), cleanText(req.body.sizeLabel), unloadDate || null,
        cleanText(req.body.carrier), cleanText(req.body.note, 1000), cleanText(req.body.delayNote, 500), req.user.code
      ]
    );
    await auditLog(req, 'transport_extra_added', `${project}#${product}`, { project, product, loadDate, lkwNumber });
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad dodawania lazienki do transportu' });
  }
});

app.delete('/api/transport-extra/:id', auth, requireTab('transport'), managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Nieprawidlowy wpis transportu' });
  try {
    await ensureTransportExtrasTable();
    const r = await pool.query('DELETE FROM transport_extras WHERE id=$1 RETURNING project, product', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Wpis transportu nie istnieje' });
    await auditLog(req, 'transport_extra_deleted', `${r.rows[0].project}#${r.rows[0].product}`, { id });
    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad usuwania lazienki z transportu' });
  }
});

app.post('/api/transport-replacements', auth, requireTab('transport'), managerOnly, async (req, res) => {
  const mode = String(req.body.mode || '').trim().toLowerCase();
  const project = String(req.body.project || '').trim();
  const fromProduct = Number(req.body.fromProduct);
  const toProduct = Number(req.body.toProduct);
  const logOnly = !!req.body.logOnly;
  if (!['zamien', 'podmiana'].includes(mode)) return res.status(400).json({ error: 'Wybierz tryb: zamien albo podmiana' });
  if (!project || !Number.isInteger(fromProduct) || fromProduct < 1 || !Number.isInteger(toProduct) || toProduct < 1) {
    return res.status(400).json({ error: 'Brak projektu lub numeru lazienki' });
  }
  if (fromProduct === toProduct) return res.status(400).json({ error: 'Wybierz inna lazienke' });
  const client = await pool.connect();
  try {
    await ensureTransportReplacementsTable();
    await client.query('BEGIN');
    const source = await client.query('SELECT * FROM transport_dates WHERE project=$1 AND product=$2', [project, fromProduct]);
    const target = await client.query('SELECT * FROM transport_dates WHERE project=$1 AND product=$2', [project, toProduct]);
    if (mode === 'podmiana') {
      const t = target.rows[0];
      if (!t) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Najpierw zapisz termin transportu dla lazienki jadacej w podmianie' });
      }
      const details = {
        logOnly: true,
        simpleReplacement: true,
        orderName: t.order_name || '',
        trailer: t.trailer || '',
        direction: t.direction || '',
        sizeLabel: t.size_label || '',
        unloadDate: t.unload_date || '',
        carrier: t.carrier || '',
        note: t.note || '',
        delayNote: t.delay_note || ''
      };
      const logged = await client.query(
        `INSERT INTO transport_replacements (mode, project, from_product, to_product, load_date, lkw_number, details, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         RETURNING id`,
        [mode, project, fromProduct, toProduct, t.load_date, t.lkw_number, JSON.stringify(details), req.user.code]
      );
      await client.query('COMMIT');
      await auditLog(req, 'transport_replacement', `${project}#${fromProduct}->${toProduct}`, { mode, project, fromProduct, toProduct, logOnly: true });
      return res.json({ success: true, id: logged.rows[0].id, mode, project, fromProduct, toProduct, loadDate: t.load_date, lkwNumber: t.lkw_number });
    }
    if (!source.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ta lazienka nie ma terminu transportu do przeniesienia' });
    }
    const t = source.rows[0];
    const returnTransport = target.rows[0] || null;
    const details = {
      orderName: t.order_name || '',
      trailer: t.trailer || '',
      direction: t.direction || '',
      sizeLabel: t.size_label || '',
      unloadDate: t.unload_date || '',
      carrier: t.carrier || '',
      note: t.note || '',
      delayNote: t.delay_note || '',
      returnTransport: returnTransport ? {
        loadDate: returnTransport.load_date || '',
        lkwNumber: returnTransport.lkw_number || '',
        orderName: returnTransport.order_name || '',
        trailer: returnTransport.trailer || '',
        direction: returnTransport.direction || '',
        sizeLabel: returnTransport.size_label || '',
        unloadDate: returnTransport.unload_date || '',
        carrier: returnTransport.carrier || '',
        note: returnTransport.note || '',
        delayNote: returnTransport.delay_note || ''
      } : null
    };
    await client.query(
      `INSERT INTO transport_dates (
         project, product, load_date, lkw_number, order_name, trailer, direction, size_label,
         unload_date, carrier, note, delay_note, updated_by, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (project, product) DO UPDATE SET
         load_date=EXCLUDED.load_date, lkw_number=EXCLUDED.lkw_number, order_name=EXCLUDED.order_name,
         trailer=EXCLUDED.trailer, direction=EXCLUDED.direction, size_label=EXCLUDED.size_label,
         unload_date=EXCLUDED.unload_date, carrier=EXCLUDED.carrier, note=EXCLUDED.note,
         delay_note=EXCLUDED.delay_note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [project, toProduct, t.load_date, t.lkw_number, t.order_name, t.trailer, t.direction, t.size_label, t.unload_date, t.carrier, t.note, t.delay_note, req.user.code]
    );
    if (mode === 'podmiana' && returnTransport) {
      await client.query(
        `INSERT INTO transport_dates (
           project, product, load_date, lkw_number, order_name, trailer, direction, size_label,
           unload_date, carrier, note, delay_note, updated_by, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (project, product) DO UPDATE SET
           load_date=EXCLUDED.load_date, lkw_number=EXCLUDED.lkw_number, order_name=EXCLUDED.order_name,
           trailer=EXCLUDED.trailer, direction=EXCLUDED.direction, size_label=EXCLUDED.size_label,
           unload_date=EXCLUDED.unload_date, carrier=EXCLUDED.carrier, note=EXCLUDED.note,
           delay_note=EXCLUDED.delay_note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [project, fromProduct, returnTransport.load_date, returnTransport.lkw_number, returnTransport.order_name, returnTransport.trailer, returnTransport.direction, returnTransport.size_label, returnTransport.unload_date, returnTransport.carrier, returnTransport.note, returnTransport.delay_note, req.user.code]
      );
    } else if (mode === 'zamien') {
      await client.query('DELETE FROM transport_dates WHERE project=$1 AND product=$2', [project, fromProduct]);
    }
    const logged = await client.query(
      `INSERT INTO transport_replacements (mode, project, from_product, to_product, load_date, lkw_number, details, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       RETURNING id`,
      [mode, project, fromProduct, toProduct, t.load_date, t.lkw_number, JSON.stringify(details), req.user.code]
    );
    await client.query('COMMIT');
    await auditLog(req, 'transport_replacement', `${project}#${fromProduct}->${toProduct}`, { mode, project, fromProduct, toProduct });
    res.json({ success: true, id: logged.rows[0].id, mode, project, fromProduct, toProduct, loadDate: t.load_date, lkwNumber: t.lkw_number });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message || 'Blad zapisu podmiany transportu' });
  } finally {
    client.release();
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
      json_agg(json_build_object('project',rl.project,'product',rl.product,'stage',rl.stage,'contractor_code',rl.contractor_code,'note',rl.note,'hall',rl.hall) ORDER BY rl.id) as lines
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
            <p style="color:#888;font-size:12px;margin-top:16px">Wiadomość automatyczna — RaportRBR v1.91 © Ready Bathroom</p>
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
async function collectBackupPayload() {
  await ensureUsersBlockColumn();
  await ensureReportsCreatedByColumn();
  await ensureMapLayoutsTable();
  await ensureTransportDatesTable();
  await ensureBathroomCommentsTable();
  await ensureBathroomChecksTable();
  await ensureStagePermissionsTable();
  await ensureUserStagePreferencesTable();
  await ensureRolePermissionsTable();
  await ensureProjectsTables();
  await ensureMaterialUsagesTable();
  await ensureTransportReplacementsTable();
  await ensureTransportExtrasTable();
  await ensureQualityTables();
  await ensureReportControlsTable();
  await ensureFertilizationTable();
  await ensureCalculationStagesTable();
  const [users, reports, lines, recipients, mapLayouts, transportDates, transportExtras, transportReplacements, comments, checks, stagePermissions, userStagePreferences, rolePermissions, reportControls, projects, projectBathrooms, materialUsages, qualityItems, qualityRecords, fertilization, calculationStages] = await Promise.all([
    pool.query('SELECT * FROM users ORDER BY created_at'),
    pool.query('SELECT * FROM reports ORDER BY created_at'),
    pool.query('SELECT * FROM report_lines ORDER BY id'),
    pool.query('SELECT * FROM email_recipients ORDER BY id'),
    pool.query('SELECT * FROM map_layouts ORDER BY id'),
    pool.query('SELECT * FROM transport_dates ORDER BY load_date, project, product'),
    pool.query('SELECT * FROM transport_extras ORDER BY load_date, project, product, id'),
    pool.query('SELECT * FROM transport_replacements ORDER BY created_at, id'),
    pool.query('SELECT * FROM bathroom_comments ORDER BY created_at'),
    pool.query('SELECT * FROM bathroom_checks ORDER BY updated_at'),
    pool.query('SELECT * FROM stage_permissions ORDER BY stage, worker_code'),
    pool.query('SELECT * FROM user_stage_preferences ORDER BY user_code'),
    pool.query('SELECT * FROM role_permissions ORDER BY role'),
    pool.query('SELECT * FROM report_controls ORDER BY project, stage'),
    pool.query('SELECT * FROM projects ORDER BY project'),
    pool.query('SELECT * FROM project_bathrooms ORDER BY project, product'),
    pool.query('SELECT * FROM material_usages ORDER BY created_at'),
    pool.query('SELECT * FROM quality_items ORDER BY project, item_name'),
    pool.query('SELECT * FROM quality_records ORDER BY project, product'),
    pool.query('SELECT * FROM fertilization_settings ORDER BY delivery_date, project'),
    pool.query('SELECT * FROM calculation_stages ORDER BY stage'),
  ]);
  const data = {
    users: users.rows,
    reports: reports.rows,
    report_lines: lines.rows,
    email_recipients: recipients.rows,
    map_layouts: mapLayouts.rows,
    transport_dates: transportDates.rows,
    transport_extras: transportExtras.rows,
    transport_replacements: transportReplacements.rows,
    bathroom_comments: comments.rows,
    bathroom_checks: checks.rows,
    stage_permissions: stagePermissions.rows,
    user_stage_preferences: userStagePreferences.rows,
    role_permissions: rolePermissions.rows,
    report_controls: reportControls.rows,
    projects: projects.rows,
    project_bathrooms: projectBathrooms.rows,
    material_usages: materialUsages.rows,
    quality_items: qualityItems.rows,
    quality_records: qualityRecords.rows,
    fertilization_settings: fertilization.rows,
    calculation_stages: calculationStages.rows,
  };
  const counts = Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : 0]));
  return { version: '1.91', exportedAt: new Date().toISOString(), data, counts };
}

async function saveOnlineBackup(kind = 'auto', createdBy = null) {
  await ensureBackupSnapshotsTable();
  const backup = await collectBackupPayload();
  await pool.query(
    'INSERT INTO backup_snapshots (kind, payload, counts, created_by) VALUES ($1,$2::jsonb,$3::jsonb,$4)',
    [kind, JSON.stringify(backup), JSON.stringify(backup.counts || {}), createdBy]
  );
  await pool.query(`DELETE FROM backup_snapshots WHERE id NOT IN (SELECT id FROM backup_snapshots ORDER BY created_at DESC LIMIT 30)`);
  return backup;
}

cron.schedule('20 2 * * *', async () => {
  try {
    await saveOnlineBackup('auto', 'system');
    console.log('Online DB backup saved.');
  } catch (err) {
    console.error('Online DB backup error:', err.message);
  }
}, { timezone: 'Europe/Warsaw' });

app.get('/api/backup-status', auth, requireTab('database'), managerOnly, async (req, res) => {
  try {
    await ensureBackupSnapshotsTable();
    const [latest, count] = await Promise.all([
      pool.query('SELECT id, kind, counts, created_by AS "createdBy", created_at AS "createdAt" FROM backup_snapshots ORDER BY created_at DESC LIMIT 1'),
      pool.query('SELECT COUNT(*)::int AS count FROM backup_snapshots')
    ]);
    res.json({ schedule: '02:20 codziennie', count: count.rows[0]?.count || 0, latest: latest.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Blad statusu backupu' });
  }
});

app.get('/api/backup', auth, requireTab('database'), managerOnly, async (req, res) => {
  try {
    const freshBackup = await collectBackupPayload();
    await saveOnlineBackup('manual', req.user.code || null).catch(err => console.error('Manual online backup save error:', err.message));
    res.setHeader('Content-Disposition', `attachment; filename="raportrbr_backup_${new Date().toISOString().slice(0,10)}.json"`);
    await auditLog(req, 'backup_exported', 'database', freshBackup.counts);
    return res.json(freshBackup);
    await ensureUsersBlockColumn();
    await ensureReportsCreatedByColumn();
    await ensureMapLayoutsTable();
    await ensureTransportDatesTable();
    await ensureBathroomCommentsTable();
    await ensureBathroomChecksTable();
    await ensureStagePermissionsTable();
    await ensureProjectsTables();
    await ensureMaterialUsagesTable();
    await ensureTransportReplacementsTable();
    await ensureTransportExtrasTable();
    await ensureQualityTables();
    await ensureReportControlsTable();
    const [users, reports, lines, recipients, mapLayouts, transportDates, transportExtras, transportReplacements, comments, checks, stagePermissions, reportControls, projects, projectBathrooms, materialUsages, qualityItems, qualityRecords] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM reports ORDER BY created_at'),
      pool.query('SELECT * FROM report_lines ORDER BY id'),
      pool.query('SELECT * FROM email_recipients ORDER BY id'),
      pool.query('SELECT * FROM map_layouts ORDER BY id'),
      pool.query('SELECT * FROM transport_dates ORDER BY load_date, project, product'),
      pool.query('SELECT * FROM transport_extras ORDER BY load_date, project, product, id'),
      pool.query('SELECT * FROM transport_replacements ORDER BY created_at, id'),
      pool.query('SELECT * FROM bathroom_comments ORDER BY created_at'),
      pool.query('SELECT * FROM bathroom_checks ORDER BY updated_at'),
      pool.query('SELECT * FROM stage_permissions ORDER BY stage, worker_code'),
      pool.query('SELECT * FROM report_controls ORDER BY project, stage'),
      pool.query('SELECT * FROM projects ORDER BY project'),
      pool.query('SELECT * FROM project_bathrooms ORDER BY project, product'),
      pool.query('SELECT * FROM material_usages ORDER BY created_at'),
      pool.query('SELECT * FROM quality_items ORDER BY project, item_name'),
      pool.query('SELECT * FROM quality_records ORDER BY project, product'),
    ]);

    const backup = {
      version: '1.91',
      exportedAt: new Date().toISOString(),
      data: {
        users: users.rows,
        reports: reports.rows,
        report_lines: lines.rows,
        email_recipients: recipients.rows,
        map_layouts: mapLayouts.rows,
        transport_dates: transportDates.rows,
        transport_extras: transportExtras.rows,
        transport_replacements: transportReplacements.rows,
        bathroom_comments: comments.rows,
        bathroom_checks: checks.rows,
        stage_permissions: stagePermissions.rows,
        report_controls: reportControls.rows,
        projects: projects.rows,
        project_bathrooms: projectBathrooms.rows,
        material_usages: materialUsages.rows,
        quality_items: qualityItems.rows,
        quality_records: qualityRecords.rows,
      },
      counts: {
        users: users.rows.length,
        reports: reports.rows.length,
        report_lines: lines.rows.length,
        map_layouts: mapLayouts.rows.length,
        transport_dates: transportDates.rows.length,
        transport_extras: transportExtras.rows.length,
        transport_replacements: transportReplacements.rows.length,
        bathroom_comments: comments.rows.length,
        bathroom_checks: checks.rows.length,
        stage_permissions: stagePermissions.rows.length,
        report_controls: reportControls.rows.length,
        projects: projects.rows.length,
        project_bathrooms: projectBathrooms.rows.length,
        material_usages: materialUsages.rows.length,
        quality_items: qualityItems.rows.length,
        quality_records: qualityRecords.rows.length,
      }
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="raportrbr_backup_${new Date().toISOString().slice(0,10)}.json"`);
    await auditLog(req, 'backup_exported', 'database', backup.counts);
    res.json(backup);
    console.log(`Backup exported: ${lines.rows.length} report lines`);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DATABASE RESTORE ─────────────────────────────────────────────────────────
app.post('/api/restore', auth, requireTab('database'), managerOnly, async (req, res) => {
  const { data } = req.body;
  if (!data?.reports || !data?.report_lines) return res.status(400).json({ error: 'Nieprawidłowy format backupu' });
  
  const client = await pool.connect();
  try {
    await ensureReportsCreatedByColumn();
    await client.query('BEGIN');
    
    // Restore reports (skip existing)
    let added = 0;
    for (const r of data.reports) {
      const exists = await client.query('SELECT id FROM reports WHERE id=$1', [r.id]);
      if (exists.rows.length === 0) {
        await client.query(
          'INSERT INTO reports (id, worker_code, report_date, created_at, created_by) VALUES ($1,$2,$3,$4,$5)',
          [r.id, r.worker_code, r.report_date, r.created_at, r.created_by || r.createdBy || r.worker_code]
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
          'INSERT INTO report_lines (id, report_id, project, product, stage, contractor_code, note, photos, created_at, hall) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [l.id, l.report_id, l.project, l.product, l.stage, l.contractor_code, l.note||'', l.photos||null, l.created_at, l.hall || '']
        );
        linesAdded++;
      }
    }

    let transportRestored = 0;
    if (Array.isArray(data.transport_dates)) {
      await ensureTransportDatesTable();
      for (const t of data.transport_dates) {
        await client.query(
          `INSERT INTO transport_dates (
             project, product, load_date, lkw_number, order_name, trailer, direction, size_label,
             unload_date, carrier, note, delay_note, updated_by, updated_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,NOW()))
           ON CONFLICT (project, product) DO UPDATE SET
             load_date=EXCLUDED.load_date, lkw_number=EXCLUDED.lkw_number, order_name=EXCLUDED.order_name,
             trailer=EXCLUDED.trailer, direction=EXCLUDED.direction, size_label=EXCLUDED.size_label,
             unload_date=EXCLUDED.unload_date, carrier=EXCLUDED.carrier, note=EXCLUDED.note,
             delay_note=EXCLUDED.delay_note, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [
            t.project, t.product, t.load_date || t.loadDate, t.lkw_number || t.lkwNumber || null,
            t.order_name || t.orderName || null, t.trailer || null, t.direction || null, t.size_label || t.sizeLabel || null,
            t.unload_date || t.unloadDate || null, t.carrier || null, t.note || null, t.delay_note || t.delayNote || null,
            t.updated_by || t.updatedBy || req.user.code, t.updated_at || t.updatedAt || null
          ]
        );
        transportRestored++;
      }
    }

    let transportExtrasRestored = 0;
    if (Array.isArray(data.transport_extras)) {
      await ensureTransportExtrasTable();
      for (const t of data.transport_extras) {
        const exists = t.id ? await client.query('SELECT id FROM transport_extras WHERE id=$1', [t.id]) : { rows: [] };
        if (exists.rows.length) continue;
        await client.query(
          `INSERT INTO transport_extras (
             id, project, product, load_date, lkw_number, order_name, trailer, direction, size_label,
             unload_date, carrier, note, delay_note, updated_by, updated_at, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,NOW()),COALESCE($16,NOW()))`,
          [
            t.id || null, t.project, t.product, t.load_date || t.loadDate, t.lkw_number || t.lkwNumber || null,
            t.order_name || t.orderName || null, t.trailer || null, t.direction || null, t.size_label || t.sizeLabel || null,
            t.unload_date || t.unloadDate || null, t.carrier || null, t.note || null, t.delay_note || t.delayNote || null,
            t.updated_by || t.updatedBy || req.user.code, t.updated_at || t.updatedAt || null, t.created_at || t.createdAt || null
          ]
        );
        transportExtrasRestored++;
      }
      await client.query(`SELECT setval(pg_get_serial_sequence('transport_extras','id'), COALESCE((SELECT MAX(id) FROM transport_extras), 1), true)`);
    }

    let transportReplacementsRestored = 0;
    if (Array.isArray(data.transport_replacements)) {
      await ensureTransportReplacementsTable();
      for (const item of data.transport_replacements) {
        const exists = item.id ? await client.query('SELECT id FROM transport_replacements WHERE id=$1', [item.id]) : { rows: [] };
        if (exists.rows.length) continue;
        await client.query(
          `INSERT INTO transport_replacements (id, mode, project, from_product, to_product, load_date, lkw_number, details, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,COALESCE($10,NOW()))`,
          [
            item.id || null,
            item.mode,
            item.project,
            item.from_product || item.fromProduct,
            item.to_product || item.toProduct,
            item.load_date || item.loadDate || null,
            item.lkw_number || item.lkwNumber || null,
            JSON.stringify(item.details || {}),
            item.created_by || item.createdBy || req.user.code,
            item.created_at || item.createdAt || null
          ]
        );
        transportReplacementsRestored++;
      }
      await client.query(`SELECT setval(pg_get_serial_sequence('transport_replacements','id'), COALESCE((SELECT MAX(id) FROM transport_replacements), 1), true)`);
    }

    let projectsRestored = 0;
    if (Array.isArray(data.projects) || Array.isArray(data.project_bathrooms)) {
      await ensureProjectsTables();
      for (const p of (data.projects || [])) {
        await client.query(
          `INSERT INTO projects (project, count, closed, calculation_enabled, imported_from_excel, import_source, updated_by, updated_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,NOW()),COALESCE($9,NOW()))
           ON CONFLICT (project) DO UPDATE SET count=EXCLUDED.count, closed=EXCLUDED.closed, calculation_enabled=EXCLUDED.calculation_enabled,
             imported_from_excel=EXCLUDED.imported_from_excel, import_source=EXCLUDED.import_source,
             updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [p.project, p.count || 0, !!p.closed, !!(p.calculation_enabled || p.calculationEnabled), !!(p.imported_from_excel || p.importedFromExcel), p.import_source || p.importSource || null, p.updated_by || p.updatedBy || req.user.code, p.updated_at || p.updatedAt || null, p.created_at || p.createdAt || null]
        );
        projectsRestored++;
      }
      for (const b of (data.project_bathrooms || [])) {
        await client.query(
          `INSERT INTO project_bathrooms (project, product, external_id, rbr_type, ventilation_variant, visible_high_walls, requested_delivery, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,NOW()))
           ON CONFLICT (project, product) DO UPDATE SET external_id=EXCLUDED.external_id, rbr_type=EXCLUDED.rbr_type,
             ventilation_variant=EXCLUDED.ventilation_variant, visible_high_walls=EXCLUDED.visible_high_walls,
             requested_delivery=EXCLUDED.requested_delivery, updated_at=EXCLUDED.updated_at`,
          [b.project, b.product, b.external_id || b.externalId || null, b.rbr_type || b.rbrType || null, b.ventilation_variant || b.ventilationVariant || null, b.visible_high_walls || b.visibleHighWalls || null, b.requested_delivery || b.requestedDelivery || null, b.updated_at || b.updatedAt || null]
        );
      }
    }

    let materialRestored = 0;
    if (Array.isArray(data.material_usages)) {
      await ensureMaterialUsagesTable();
      for (const m of data.material_usages) {
        await client.query(
          `INSERT INTO material_usages (id, project, product, stage, type_key, type_label, data, worker_code, worker_name, report_date, created_at, approved_by, approved_name, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,COALESCE($11,NOW()),$12,$13,$14)
           ON CONFLICT (project, stage, type_key) DO NOTHING`,
          [m.id, m.project, m.product, m.stage, m.type_key || m.typeKey, m.type_label || m.typeLabel || null, JSON.stringify(m.data || {}), m.worker_code || m.workerCode || null, m.worker_name || m.workerName || null, m.report_date || m.reportDate || null, m.created_at || m.createdAt || null, m.approved_by || m.approvedBy || null, m.approved_name || m.approvedName || null, m.approved_at || m.approvedAt || null]
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
          `INSERT INTO map_layouts (id, layouts, photos, map_dates, map_widths, map_starts, updated_by, updated_at)
           VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7,COALESCE($8,NOW()))
           ON CONFLICT (id) DO UPDATE SET layouts=EXCLUDED.layouts, photos=EXCLUDED.photos, map_dates=EXCLUDED.map_dates, map_widths=EXCLUDED.map_widths, map_starts=EXCLUDED.map_starts, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          (() => {
            const layouts = normalizeMapLayouts(m.layouts || {});
            return [m.id || 'main', JSON.stringify(layouts), JSON.stringify(normalizeMapPhotos(m.photos || {})), JSON.stringify(normalizeMapDates(m.map_dates || m.mapDates || {})), JSON.stringify(normalizeMapWidths(m.map_widths || m.mapWidths || {}, layouts)), JSON.stringify(normalizeMapStarts(m.map_starts || m.mapStarts || {}, layouts)), m.updated_by || req.user.code, m.updated_at || null];
          })()
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
          `INSERT INTO bathroom_checks (project, product, check_type, checked, status, comment, checked_by, checked_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,NOW()))
           ON CONFLICT (project, product, check_type)
           DO UPDATE SET checked=EXCLUDED.checked, status=EXCLUDED.status, comment=EXCLUDED.comment, checked_by=EXCLUDED.checked_by,
             checked_at=EXCLUDED.checked_at, updated_at=EXCLUDED.updated_at`,
          [
            c.project,
            c.product,
            c.check_type || c.checkType || 'tiling',
            !!c.checked,
            c.status || (c.checked ? 'checked' : 'pending'),
            c.comment || null,
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

    let userStagePreferencesRestored = 0;
    if (Array.isArray(data.user_stage_preferences)) {
      await ensureUserStagePreferencesTable();
      for (const p of data.user_stage_preferences) {
        const userCode = String(p.user_code || p.userCode || '').trim().toUpperCase();
        if (!userCode) continue;
        const visibleStages = Array.isArray(p.visible_stages || p.visibleStages)
          ? (p.visible_stages || p.visibleStages).map(normalizeStageId).filter(Boolean)
          : [];
        await client.query(
          `INSERT INTO user_stage_preferences (user_code, visible_stages, updated_at)
           VALUES ($1,$2::jsonb,COALESCE($3,NOW()))
           ON CONFLICT (user_code) DO UPDATE SET visible_stages=EXCLUDED.visible_stages, updated_at=EXCLUDED.updated_at`,
          [userCode, JSON.stringify([...new Set(visibleStages)]), p.updated_at || p.updatedAt || null]
        );
        userStagePreferencesRestored++;
      }
    }

    let rolePermissionsRestored = 0;
    if (Array.isArray(data.role_permissions)) {
      await ensureRolePermissionsTable();
      for (const p of data.role_permissions) {
        const role = normalizeUserRole(p.role);
        const tabs = Array.isArray(p.tabs) ? p.tabs.map(tab => String(tab || '').trim()).filter(Boolean) : [];
        await client.query(
          `INSERT INTO role_permissions (role, tabs, updated_by, updated_at)
           VALUES ($1,$2::jsonb,$3,COALESCE($4,NOW()))
           ON CONFLICT (role) DO UPDATE SET tabs=EXCLUDED.tabs, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [role, JSON.stringify(tabs), p.updated_by || p.updatedBy || req.user.code, p.updated_at || p.updatedAt || null]
        );
        rolePermissionsRestored++;
      }
    }

    let reportControlsRestored = 0;
    if (Array.isArray(data.report_controls)) {
      await ensureReportControlsTable();
      for (const c of data.report_controls) {
        const item = normalizeReportControlInput(c);
        if (!item.stage) continue;
        await client.query(
          `INSERT INTO report_controls (project, stage, disabled, question, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW()))
           ON CONFLICT (project, stage) DO UPDATE SET disabled=EXCLUDED.disabled, question=EXCLUDED.question,
             updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [item.project, item.stage, item.disabled, item.question, c.updated_by || c.updatedBy || req.user.code, c.updated_at || c.updatedAt || null]
        );
        reportControlsRestored++;
      }
    }

    let fertilizationRestored = 0;
    if (Array.isArray(data.fertilization_settings)) {
      await ensureFertilizationTable();
      for (const f of data.fertilization_settings) {
        const project = String(f.project || '').trim();
        const rawDeliveryDate = String(f.delivery_date || f.deliveryDate || '').trim();
        const deliveryDate = rawDeliveryDate === 'kolejnosc' ? 'kolejnosc' : rawDeliveryDate.slice(0, 10);
        if (!project || !(/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || deliveryDate === 'kolejnosc')) continue;
        await client.query(
          `INSERT INTO fertilization_settings (project, delivery_date, hall, car_capacity, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()))
           ON CONFLICT (project, delivery_date) DO UPDATE SET hall=EXCLUDED.hall, car_capacity=EXCLUDED.car_capacity,
             note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [project, deliveryDate, f.hall || '', Number(f.car_capacity || f.carCapacity || 0) || 0, f.note || '', f.updated_by || f.updatedBy || req.user.code, f.updated_at || f.updatedAt || null]
        );
        fertilizationRestored++;
      }
    }

    let qualityItemsRestored = 0;
    let qualityRecordsRestored = 0;
    if (Array.isArray(data.quality_items) || Array.isArray(data.quality_records)) {
      await ensureQualityTables();
      for (const item of (data.quality_items || [])) {
        const project = String(item.project || '').trim();
        const itemName = String(item.item_name || item.itemName || '').trim();
        if (!project || !itemName) continue;
        await client.query(
          `INSERT INTO quality_items (project, item_name, created_by, created_at)
           VALUES ($1,$2,$3,COALESCE($4,NOW()))
           ON CONFLICT (project, item_name) DO UPDATE SET created_by=COALESCE(quality_items.created_by, EXCLUDED.created_by)`,
          [project, itemName, item.created_by || item.createdBy || req.user.code, item.created_at || item.createdAt || null]
        );
        qualityItemsRestored++;
      }
      for (const record of (data.quality_records || [])) {
        const project = String(record.project || '').trim();
        const product = Number(record.product);
        if (!project || !Number.isInteger(product)) continue;
        await client.query(
          `INSERT INTO quality_records (project, product, goat, goat_done, missing_items, resolved_items, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,COALESCE($8,NOW()))
           ON CONFLICT (project, product) DO UPDATE SET goat=EXCLUDED.goat, goat_done=EXCLUDED.goat_done,
             missing_items=EXCLUDED.missing_items, resolved_items=EXCLUDED.resolved_items,
             updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [
            project,
            product,
            !!record.goat,
            !!(record.goat_done || record.goatDone),
            JSON.stringify(uniqueTextList(record.missing_items || record.missingItems)),
            JSON.stringify(uniqueTextList(record.resolved_items || record.resolvedItems)),
            record.updated_by || record.updatedBy || req.user.code,
            record.updated_at || record.updatedAt || null
          ]
        );
        qualityRecordsRestored++;
      }
    }

    let calculationStagesRestored = 0;
    if (Array.isArray(data.calculation_stages)) {
      await ensureCalculationStagesTable();
      for (const item of data.calculation_stages) {
        const stage = String(item.stage || '').trim();
        const fields = Array.isArray(item.fields) ? item.fields : [];
        if (!stage) continue;
        await client.query(
          `INSERT INTO calculation_stages (stage, fields, updated_by, updated_at)
           VALUES ($1,$2::jsonb,$3,COALESCE($4,NOW()))
           ON CONFLICT (stage) DO UPDATE SET fields=EXCLUDED.fields, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
          [stage, JSON.stringify(fields), item.updated_by || item.updatedBy || req.user.code, item.updated_at || item.updatedAt || null]
        );
        calculationStagesRestored++;
      }
    }
    
    await client.query('COMMIT');
    await auditLog(req, 'backup_restored', 'database', { reports: added, lines: linesAdded, transport: transportRestored, transportExtras: transportExtrasRestored, transportReplacements: transportReplacementsRestored, projects: projectsRestored, maps: mapsRestored, comments: commentsRestored, checks: checksRestored, stagePermissions: stagePermissionsRestored, rolePermissions: rolePermissionsRestored, reportControls: reportControlsRestored, fertilization: fertilizationRestored, materials: materialRestored, calculationStages: calculationStagesRestored, qualityItems: qualityItemsRestored, qualityRecords: qualityRecordsRestored });
    res.json({ success: true, message: `Przywrocono ${added} raportow, ${linesAdded} wpisow, ${transportRestored} dat transportu, ${transportExtrasRestored} dodatkowych wpisow transportu, ${transportReplacementsRestored} podmian transportu, ${projectsRestored} projektow, ${mapsRestored} map, ${commentsRestored} komentarzy, ${checksRestored} kontroli, ${stagePermissionsRestored} przypisan etapow, ${rolePermissionsRestored} uprawnien rol, ${reportControlsRestored} ustawien raportowania, ${fertilizationRestored} ustawien nawozenia, ${materialRestored} kalkulacji, ${calculationStagesRestored} etapow kalkulacji, ${qualityRecordsRestored} wpisow jakosci` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
// index.html is in the same directory as server.js
const publicPath = path.join(__dirname);
app.use(express.static(publicPath));

app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as reports FROM reports');
    const r2 = await pool.query('SELECT COUNT(*) as lines FROM report_lines');
    res.json({
      status: 'ok',
      version: '1.91',
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

app.use((err, req, res, next) => {
  if (!err) return next();
  console.error('Request error:', err.message);
  res.status(err.message && err.message.includes('CORS') ? 403 : 500).json({ error: err.message || 'Blad serwera' });
});

async function ensureInitialAdminAccount() {
  try {
    await ensureUsersBlockColumn();
    await ensureReportsCreatedByColumn();
    await ensureAppSettingsTable();
    const existing = await pool.query("SELECT code FROM users WHERE code='ADMIN'");
    const hardened = await pool.query("SELECT key FROM app_settings WHERE key='admin_initial_hardening_done'");
    if (existing.rows.length) {
      if (!hardened.rows.length) {
        await pool.query("UPDATE users SET must_change_password=TRUE WHERE code='ADMIN'");
        await pool.query("INSERT INTO app_settings (key, value) VALUES ('admin_initial_hardening_done', $1::jsonb) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ at: new Date().toISOString(), mode: 'existing_admin_force_change' })]);
        console.log('Existing ADMIN account marked for password change once.');
      }
      return;
    }
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'admin123!@#';
    const hash = await bcrypt.hash(initialPassword, 10);
    await pool.query(
      `INSERT INTO users (code, name, password_hash, must_change_password, role)
       VALUES ('ADMIN','Administrator',$1,TRUE,'admin')`,
      [hash]
    );
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('admin_initial_hardening_done', $1::jsonb) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ at: new Date().toISOString(), mode: 'created_admin' })]);
    console.log('Initial ADMIN account created. Password must be changed after first login.');
  } catch (err) {
    console.error('Initial admin setup error:', err.message);
  }
}

ensureInitialAdminAccount().finally(() => {
  app.listen(PORT, () => console.log(`RaportRBR v1.91 running on port ${PORT}`));
});

