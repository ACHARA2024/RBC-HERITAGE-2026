'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  RBC HERITAGE 2026 SWEEPSTAKE
//  Harbour Town Golf Links, Hilton Head Island SC  |  April 16–19 2026
// ─────────────────────────────────────────────────────────────────────────────

const express        = require('express');
const session        = require('express-session');
const bcrypt         = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const axios          = require('axios');
const cheerio        = require('cheerio');
const cron           = require('node-cron');
const path           = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;
const SALT = 10;
const ENTRY_FEE      = 20;
const ENTRY_DEADLINE = new Date('2026-04-15T23:59:00+01:00'); // Irish time — day before tee-off

// ═══════════════════════════════════════════════════════════════════════════════
//  DATABASE  (node:sqlite built-in)
// ═══════════════════════════════════════════════════════════════════════════════

class Database {
  constructor(filePath) {
    this._db = new DatabaseSync(filePath);
    this._db.exec('PRAGMA journal_mode = WAL');
    this._db.exec('PRAGMA foreign_keys = ON');
  }
  exec(sql)    { this._db.exec(sql); return this; }
  pragma(stmt) { this._db.exec(`PRAGMA ${stmt}`); return this; }
  prepare(sql) {
    const inner = this._db.prepare(sql);
    const norm  = (...args) => args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    const fixRow = r => {
      if (!r) return r;
      const out = {};
      for (const k of Object.keys(r)) { const v = r[k]; out[k] = typeof v === 'bigint' ? Number(v) : v; }
      return out;
    };
    return {
      run: (...args) => {
        const res = inner.run(...norm(...args));
        return {
          lastInsertRowid: typeof res.lastInsertRowid === 'bigint' ? Number(res.lastInsertRowid) : res.lastInsertRowid,
          changes: typeof res.changes === 'bigint' ? Number(res.changes) : res.changes,
        };
      },
      get:  (...args) => fixRow(inner.get(...norm(...args))),
      all:  (...args) => (inner.all(...norm(...args))).map(fixRow),
    };
  }
  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try { const r = fn(...args); this._db.exec('COMMIT'); return r; }
      catch(e) { this._db.exec('ROLLBACK'); throw e; }
    };
  }
}

const db = new Database(path.join(__dirname, 'sweepstake.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name     TEXT    NOT NULL,
    phone         TEXT    UNIQUE NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS golfers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    odds_display     TEXT    NOT NULL,
    odds_numerator   REAL    NOT NULL,
    odds_denominator REAL    NOT NULL,
    odds_value       REAL    NOT NULL,
    is_active        INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER UNIQUE NOT NULL REFERENCES users(id),
    golfer1_id      INTEGER NOT NULL REFERENCES golfers(id),
    golfer2_id      INTEGER NOT NULL REFERENCES golfers(id),
    golfer3_id      INTEGER NOT NULL REFERENCES golfers(id),
    combined_odds   REAL    NOT NULL,
    predicted_score INTEGER NOT NULL,
    is_paid         INTEGER DEFAULT 0,
    submitted_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes           TEXT    DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS scores (
    golfer_id       INTEGER PRIMARY KEY REFERENCES golfers(id),
    round1          INTEGER,
    round2          INTEGER,
    round3          INTEGER,
    round4          INTEGER,
    status          TEXT    DEFAULT 'active',
    manual_override INTEGER DEFAULT 0,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const _init = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const _adminHash = bcrypt.hashSync('0874021075', SALT);
[
  ['odds_locked',      '0'],
  ['entries_open',     '1'],
  ['tournament_par',   '71'],
  ['winning_score',    ''],
  ['admin_password',   _adminHash],
  ['scraper_active',   '0'],
  ['scraper_last_run', ''],
].forEach(([k, v]) => _init.run(k, v));

// ═══════════════════════════════════════════════════════════════════════════════
//  SEED FIELD — Paddy Power RBC Heritage 2026 outright odds snapshot
//  Odds captured 13 April 2026. These become the official locked odds.
// ═══════════════════════════════════════════════════════════════════════════════

function seedField() {
  const existing = db.prepare('SELECT COUNT(*) c FROM golfers').get().c;
  if (existing > 0) return; // already seeded

  const field = [
    // ── Paddy Power published odds ──────────────────────────────────────────
    { name: 'Scottie Scheffler',      odds: '10/3'  },
    { name: 'Xander Schauffele',      odds: '11/1'  },
    { name: 'Matt Fitzpatrick',       odds: '11/1'  },
    { name: 'Russell Henley',         odds: '12/1'  },
    { name: 'Patrick Cantlay',        odds: '12/1'  },
    { name: 'Cameron Young',          odds: '12/1'  },
    { name: 'Collin Morikawa',        odds: '16/1'  },
    { name: 'Tommy Fleetwood',        odds: '16/1'  },
    { name: 'Ludvig Åberg',           odds: '16/1'  },
    // ── Extended field (market-equivalent fractional odds) ──────────────────
    { name: 'Sam Burns',              odds: '25/1'  },
    { name: 'Robert MacIntyre',       odds: '28/1'  },
    { name: 'Jake Knapp',             odds: '30/1'  },
    { name: 'Maverick McNealy',       odds: '35/1'  },
    { name: 'Justin Thomas',          odds: '36/1'  },
    { name: 'Jordan Spieth',          odds: '36/1'  },
    { name: 'Si Woo Kim',             odds: '36/1'  },
    { name: 'Viktor Hovland',         odds: '40/1'  },
    { name: 'Shane Lowry',            odds: '40/1'  },
    { name: 'Jason Day',              odds: '40/1'  },
    { name: 'Ben Griffin',            odds: '40/1'  },
    { name: 'Sahith Theegala',        odds: '45/1'  },
    { name: 'Akshay Bhatia',          odds: '45/1'  },
    { name: 'Andrew Novak',           odds: '50/1'  },
    { name: 'Sepp Straka',            odds: '50/1'  },
    { name: 'Chris Kirk',             odds: '55/1'  },
    { name: 'Keegan Bradley',         odds: '55/1'  },
    { name: 'Adam Scott',             odds: '60/1'  },
    { name: 'Tom Kim',                odds: '60/1'  },
    { name: 'Keith Mitchell',         odds: '60/1'  },
    { name: 'Taylor Moore',           odds: '60/1'  },
    { name: 'Davis Thompson',         odds: '66/1'  },
    { name: 'Michael Thorbjornsen',   odds: '66/1'  },
    { name: 'Nick Dunlap',            odds: '66/1'  },
    { name: 'Max Greyserman',         odds: '66/1'  },
    { name: 'Harris English',         odds: '66/1'  },
    { name: 'Beau Hossler',           odds: '66/1'  },
    { name: 'Sungjae Im',             odds: '66/1'  },
    { name: 'Christiaan Bezuidenhout',odds: '80/1'  },
    { name: 'Alex Smalley',           odds: '80/1'  },
    { name: 'Aaron Rai',              odds: '80/1'  },
    { name: 'Emiliano Grillo',        odds: '80/1'  },
    { name: 'Brendon Todd',           odds: '80/1'  },
    { name: 'J.T. Poston',            odds: '80/1'  },
    { name: 'Adam Hadwin',            odds: '80/1'  },
    { name: 'Rickie Fowler',          odds: '80/1'  },
    { name: 'Tom Hoge',               odds: '80/1'  },
    { name: 'Daniel Berger',          odds: '90/1'  },
    { name: 'Brian Harman',           odds: '100/1' },
    { name: 'Cam Davis',              odds: '100/1' },
    { name: 'Webb Simpson',           odds: '100/1' },
    { name: 'Stewart Cink',           odds: '100/1' },
    { name: 'Luke Donald',            odds: '100/1' },
    { name: 'Zach Johnson',           odds: '100/1' },
    { name: 'Chesson Hadley',         odds: '125/1' },
    { name: 'Kevin Streelman',        odds: '125/1' },
    { name: 'Matt Wallace',           odds: '125/1' },
    { name: 'James Hahn',             odds: '125/1' },
    { name: 'Harry Hall',             odds: '125/1' },
    { name: 'Joel Dahmen',            odds: '150/1' },
    { name: 'Henrik Norlander',       odds: '150/1' },
    { name: 'Sam Ryder',              odds: '150/1' },
    { name: 'Tyler Duncan',           odds: '150/1' },
    { name: 'Austin Cook',            odds: '200/1' },
    { name: 'Tag Ridings',            odds: '200/1' },
    { name: 'Denny McCarthy',         odds: '200/1' },
    { name: 'Ryan Moore',             odds: '200/1' },
  ];

  const insert = db.prepare('INSERT INTO golfers (name, odds_display, odds_numerator, odds_denominator, odds_value) VALUES (?,?,?,?,?)');
  const insertAll = db.transaction(rows => {
    for (const r of rows) {
      const p = parseOdds(r.odds);
      if (p) insert.run(r.name, p.display, p.numerator, p.denominator, p.value);
    }
  });
  insertAll(field);
  console.log(`[Seed] Loaded ${field.length} golfers into field.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseOdds(str) {
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const num = parseFloat(m[1]), den = parseFloat(m[2]);
  return { display: str.trim(), numerator: num, denominator: den, value: num / den };
}

const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
const requireLogin = (q, r, n) => { if (!q.session.userId) return r.redirect('/login'); n(); };
const requireAdmin = (q, r, n) => { if (!q.session.isAdmin) return r.redirect('/admin'); n(); };

function getPar() { return parseInt(getSetting('tournament_par') || '71'); }

function calcGolferScore(sc, par) {
  if (!sc) return 0;
  const pen = par + 5;
  const r = [sc.round1, sc.round2, sc.round3, sc.round4];
  if (sc.status === 'missed_cut')    return (r[0] ?? 0) + (r[1] ?? 0) + pen + pen;
  if (sc.status === 'withdrawn' || sc.status === 'disqualified')
    return r.reduce((s, v) => s + (v != null ? v : pen), 0);
  return r.reduce((s, v) => s + (v != null ? v : 0), 0);
}

function statusBadge(st) {
  const m = {
    missed_cut:   `<span class="badge mc">MC</span>`,
    withdrawn:    `<span class="badge wd">WD</span>`,
    disqualified: `<span class="badge dq">DQ</span>`,
    active:       `<span class="badge act">ACT</span>`,
    made_cut:     `<span class="badge cut">CUT</span>`,
  };
  return m[st] || '';
}

function isEntriesOpen() {
  return getSetting('entries_open') === '1' && new Date() <= ENTRY_DEADLINE;
}

function calcLeaderboard() {
  const par = getPar();
  const ws  = getSetting('winning_score');
  const entries = db.prepare(`
    SELECT e.*, u.full_name,
      g1.name g1n, g1.odds_display g1o, g1.id g1id,
      g2.name g2n, g2.odds_display g2o, g2.id g2id,
      g3.name g3n, g3.odds_display g3o, g3.id g3id
    FROM entries e
    JOIN users   u  ON u.id  = e.user_id
    JOIN golfers g1 ON g1.id = e.golfer1_id
    JOIN golfers g2 ON g2.id = e.golfer2_id
    JOIN golfers g3 ON g3.id = e.golfer3_id
    WHERE e.is_paid = 1
  `).all();

  const getS   = db.prepare('SELECT * FROM scores WHERE golfer_id=?');
  const pool   = entries.length * ENTRY_FEE;
  const prizeSlots = [pool * 0.60, pool * 0.30, pool * 0.10];

  const rows = entries.map(e => {
    const s1 = getS.get(e.golfer1_id), s2 = getS.get(e.golfer2_id), s3 = getS.get(e.golfer3_id);
    const sc1 = calcGolferScore(s1, par), sc2 = calcGolferScore(s2, par), sc3 = calcGolferScore(s3, par);
    const total = sc1 + sc2 + sc3;
    const tb = ws ? Math.abs(parseInt(e.predicted_score) - parseInt(ws)) : 9999;
    return { ...e, s1, s2, s3, sc1, sc2, sc3, total, tb, rank: 0, prize: 0 };
  });

  rows.sort((a, b) => a.total !== b.total ? a.total - b.total : a.tb - b.tb);

  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j].total === rows[i].total && rows[j].tb === rows[i].tb) j++;
    const count = j - i;
    let combined = 0;
    for (let r = i; r < j && r < 3; r++) combined += prizeSlots[r] || 0;
    const split = count > 1 ? Math.round(combined / count * 100) / 100 : combined;
    for (let k = i; k < j; k++) { rows[k].rank = i + 1; rows[k].prize = i < 3 ? split : 0; }
    i = j;
  }
  return { rows, pool, prizes: prizeSlots };
}

const formatPrize = n => n > 0 ? `€${n.toFixed(2)}` : '—';
const fmtDate = d => d ? new Date(d).toLocaleString('en-IE', { timeZone: 'Europe/Dublin' }) : '—';
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ═══════════════════════════════════════════════════════════════════════════════
//  HTML TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

function layout(title, body, opts = {}) {
  const { user, activeNav = '', isAdmin = false } = opts;
  const navLinks = isAdmin ? '' : `
    <a href="/leaderboard" class="${activeNav==='leaderboard'?'active':''}">Leaderboard</a>
    <a href="/rules"       class="${activeNav==='rules'?'active':''}">Rules</a>
    ${user
      ? `<a href="/my-entry" class="${activeNav==='my-entry'?'active':''}">My Entry</a>
         <a href="/logout" class="btn-nav-outline">Logout</a>`
      : `<a href="/login"    class="${activeNav==='login'?'active':''}">Login</a>
         <a href="/register" class="btn-nav-gold">Register</a>`
    }`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${esc(title)} | RBC Heritage 2026 Sweep</title>
  <style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--green-dark:#0d1f16;--green-mid:#1a4a2e;--green-light:#256638;--green-card:#1a3826;--green-border:#2a5c3a;--gold:#c8a94a;--gold-light:#e8c87a;--gold-dark:#a08030;--text:#e8ede9;--text-muted:#8aaa92;--white:#ffffff;--danger:#e05252;--success:#4caf76;--warning:#e8b44a;--radius:10px;--radius-sm:6px;--shadow:0 4px 20px rgba(0,0,0,0.4);--shadow-sm:0 2px 8px rgba(0,0,0,0.3)}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--green-dark);color:var(--text);min-height:100vh;line-height:1.6;font-size:15px}
a{color:var(--gold);text-decoration:none}a:hover{color:var(--gold-light);text-decoration:underline}
.navbar{background:var(--green-mid);border-bottom:2px solid var(--gold);position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,0.5)}
.nav-inner{max-width:1200px;margin:0 auto;padding:0 1rem;display:flex;align-items:center;justify-content:space-between;height:60px}
.nav-brand{display:flex;align-items:center;gap:0.5rem;font-weight:700;font-size:1.1rem;color:var(--gold);text-decoration:none}
.brand-icon{font-size:1.4rem}.brand-year{color:var(--gold-light)}
.nav-links{display:flex;align-items:center;gap:0.25rem}
.nav-links a{color:var(--text);padding:0.4rem 0.75rem;border-radius:var(--radius-sm);font-size:0.9rem;transition:background 0.2s,color 0.2s;text-decoration:none}
.nav-links a:hover,.nav-links a.active{background:var(--green-light);color:var(--white)}
.btn-nav-gold{background:var(--gold)!important;color:var(--green-dark)!important;font-weight:700;padding:0.4rem 1rem!important}
.btn-nav-gold:hover{background:var(--gold-light)!important}
.btn-nav-outline{border:1px solid var(--gold)!important;color:var(--gold)!important}
.btn-nav-outline:hover{background:var(--gold)!important;color:var(--green-dark)!important}
.nav-toggle{display:none;background:none;border:none;color:var(--gold);font-size:1.5rem;cursor:pointer;padding:0.25rem}
@media(max-width:768px){.nav-toggle{display:block}.nav-links{display:none;position:absolute;top:60px;left:0;right:0;background:var(--green-mid);flex-direction:column;padding:1rem;gap:0.5rem;border-bottom:2px solid var(--gold);box-shadow:var(--shadow)}.nav-links.open{display:flex}.nav-links a{width:100%;text-align:center;padding:0.6rem}}
.hero,.hero-sm{position:relative;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;text-align:center}
.hero{min-height:100vh}.hero-sm{min-height:220px}
.hero-celebrate{background-image:url("/john-daly.jpg");background-color:var(--green-mid);background-position:center 15%}
.hero-jump{background-image:url("/shaggy.jpg");background-color:var(--green-mid)}
.hero-quail{background-image:url("/john-daly.jpg");background-color:var(--green-mid);background-position:center 20%}
.hero-overlay{position:relative;z-index:2;padding:2rem 1.5rem}
.hero::before,.hero-sm::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(13,31,22,0.35) 0%,rgba(26,74,46,0.25) 100%);z-index:1}
.hero-overlay h1{font-size:clamp(1.8rem,5vw,3.2rem);color:var(--gold);text-shadow:0 2px 8px rgba(0,0,0,0.6);font-weight:800;margin-bottom:0.5rem}
.hero-overlay p{font-size:1rem;color:rgba(255,255,255,0.9);margin-bottom:0.25rem}
.hero-sub{color:var(--gold-light)!important;font-size:0.95rem!important;margin-top:0.5rem!important}
.photo-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;background:var(--green-dark);border-bottom:3px solid var(--gold)}
.photo-panel{overflow:hidden;height:260px;position:relative;cursor:zoom-in}
.photo-panel img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block;transition:transform 0.4s ease}
.photo-panel img:hover{transform:scale(1.06)}
.photo-caption{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.75));color:var(--gold-light);font-size:0.75rem;font-weight:600;padding:0.5rem 0.6rem 0.4rem;letter-spacing:0.04em;text-transform:uppercase}
.photo-gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;background:var(--green-dark)}
.gallery-panel{overflow:hidden;height:200px;position:relative;cursor:zoom-in}
.gallery-panel img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;transition:transform 0.4s ease}
.gallery-panel img:hover{transform:scale(1.06)}
@media(max-width:600px){.photo-panel{height:150px}.gallery-panel{height:120px}}
.container{max-width:1100px;margin:0 auto;padding:2rem 1rem}
.rules-container{max-width:960px}
.cards-row{display:grid;gap:1rem;margin-bottom:1.5rem}
.card{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius);padding:1.5rem;box-shadow:var(--shadow-sm);margin-bottom:1.5rem}
.card h2{color:var(--gold);font-size:1.2rem;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid var(--green-border)}
.card-sub{color:var(--text-muted);font-size:0.9rem;margin-bottom:1.25rem}
.center-card{text-align:center}.setup-icon{font-size:3rem;margin-bottom:1rem}
.btn{display:inline-block;padding:0.65rem 1.5rem;border-radius:var(--radius-sm);font-size:0.95rem;font-weight:600;cursor:pointer;border:none;transition:all 0.2s;text-decoration:none;line-height:1}
.btn-gold{background:var(--gold);color:var(--green-dark)}.btn-gold:hover{background:var(--gold-light);color:var(--green-dark);text-decoration:none}
.btn-outline{background:transparent;color:var(--gold);border:1.5px solid var(--gold)}.btn-outline:hover{background:var(--gold);color:var(--green-dark);text-decoration:none}
.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover{background:#c04040}
.btn-full{width:100%;text-align:center;padding:0.8rem;font-size:1rem}
.btn-xs{padding:0.3rem 0.6rem;font-size:0.8rem;border-radius:4px}
.form-group{margin-bottom:1.1rem}
.form-group label{display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.35rem;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
.form-group input,.form-group select,.form-group textarea{width:100%;background:var(--green-dark);border:1.5px solid var(--green-border);color:var(--text);border-radius:var(--radius-sm);padding:0.65rem 0.85rem;font-size:0.95rem;transition:border-color 0.2s;outline:none}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--gold)}
.form-group small{color:var(--text-muted);font-size:0.8rem;margin-top:0.25rem;display:block}
.form-row{display:grid;gap:1rem}
@media(min-width:640px){.form-row{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}}
.input-sm{background:var(--green-dark);border:1px solid var(--green-border);color:var(--text);border-radius:4px;padding:0.3rem 0.5rem;font-size:0.85rem;width:140px}
.score-input{width:64px;background:var(--green-dark);border:1px solid var(--green-border);color:var(--text);border-radius:4px;padding:0.3rem;text-align:center;font-size:0.85rem}
.status-select{background:var(--green-dark);border:1px solid var(--green-border);color:var(--text);border-radius:4px;padding:0.3rem 0.5rem;font-size:0.85rem}
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;background:radial-gradient(ellipse at top,#1a4a2e 0%,#0d1f16 70%)}
.auth-card{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius);padding:2.5rem 2rem;width:100%;max-width:440px;box-shadow:var(--shadow)}
.auth-logo{font-size:3rem;text-align:center;margin-bottom:0.75rem}
.auth-card h1{text-align:center;color:var(--gold);font-size:1.6rem;margin-bottom:0.25rem}
.auth-sub{text-align:center;color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem}
.auth-form{margin-top:1rem}
.auth-alt{text-align:center;margin-top:1rem;font-size:0.85rem;color:var(--text-muted)}
.auth-alt.small{font-size:0.78rem;margin-top:0.5rem}
.payment-notice{background:rgba(200,169,74,0.12);border:1.5px solid var(--gold);border-radius:var(--radius-sm);padding:0.85rem 1rem;margin-bottom:1.2rem;font-size:0.88rem;color:var(--text);line-height:1.5}
.flash{padding:0.85rem 1rem;border-radius:var(--radius-sm);margin-bottom:1rem;font-size:0.9rem;font-weight:500}
.flash-error{background:rgba(224,82,82,0.2);border-left:4px solid var(--danger);color:#f0a0a0}
.flash-success{background:rgba(76,175,118,0.2);border-left:4px solid var(--success);color:#90d8a8}
.odds-display{padding:0.75rem 1rem;border-radius:var(--radius-sm);font-weight:600;margin-bottom:1rem;font-size:0.95rem}
.odds-valid{background:rgba(76,175,118,0.2);border:1px solid var(--success);color:#90d8a8}
.odds-invalid{background:rgba(224,82,82,0.2);border:1px solid var(--danger);color:#f0a0a0}
.odds-pill{background:rgba(200,169,74,0.18);color:var(--gold);font-size:0.75rem;padding:0.15rem 0.45rem;border-radius:20px;font-weight:600;white-space:nowrap}
.entry-card{max-width:800px;margin:0 auto 1.5rem}.entry-form{margin-top:1.5rem}
.info-banner{background:rgba(200,169,74,0.12);border:1px solid rgba(200,169,74,0.3);border-radius:var(--radius-sm);padding:0.75rem 1rem;margin-bottom:1.25rem;font-size:0.9rem;color:var(--gold-light)}
.entry-rules-note{background:rgba(26,74,46,0.6);border:1px solid var(--green-border);border-radius:var(--radius-sm);padding:0.85rem 1rem;font-size:0.85rem;color:var(--text-muted);margin-bottom:1.25rem}
.entry-status-card{margin-bottom:1.5rem}
.status-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem}
.status-label{font-size:0.75rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.05em}
.status-value{font-size:1rem;font-weight:600;margin-top:0.2rem}
.rank-display{font-size:1.8rem;color:var(--gold);font-weight:800}
.text-gold{color:var(--gold)!important}.text-success{color:var(--success)!important}
.text-warning{color:var(--warning)!important}.text-muted{color:var(--text-muted)!important}.text-danger{color:var(--danger)!important}
.picks-meta{display:flex;gap:1.5rem;margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--green-border);font-size:0.85rem;color:var(--text-muted);flex-wrap:wrap}
.info-note{background:rgba(232,180,74,0.1);border:1px solid rgba(232,180,74,0.25);border-radius:var(--radius-sm);padding:0.65rem 0.85rem;font-size:0.83rem;color:var(--warning);margin-top:1rem}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--radius-sm)}
.data-table{width:100%;border-collapse:collapse;font-size:0.88rem;min-width:500px}
.data-table th{background:var(--green-mid);color:var(--gold);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;padding:0.65rem 0.75rem;text-align:left;white-space:nowrap;border-bottom:2px solid var(--gold)}
.data-table td{padding:0.6rem 0.75rem;border-bottom:1px solid var(--green-border);vertical-align:middle;color:var(--text)}
.data-table tbody tr:hover{background:rgba(255,255,255,0.04)}
.data-table .center{text-align:center}
.total-row td{background:rgba(200,169,74,0.08);font-weight:600}
.score-total{color:var(--gold);font-weight:700;font-size:1rem}
.score-inline{font-weight:600;margin-right:0.25rem}
.podium-row{background:rgba(200,169,74,0.06)}
.lb-header{margin-bottom:1.5rem}
.lb-stats{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;align-items:center}
.lb-stat{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius-sm);padding:0.75rem 1.25rem;text-align:center;min-width:90px}
.lb-stat-val{display:block;font-size:1.4rem;font-weight:800;color:var(--gold)}
.lb-stat-label{display:block;font-size:0.72rem;color:var(--text-muted);text-transform:uppercase}
.prize-box{background:var(--green-mid);border:1px solid var(--gold);border-radius:var(--radius-sm);padding:0.5rem 1rem;text-align:center;min-width:80px}
.prize-box-label{font-size:0.78rem;color:var(--text-muted)}.prize-box-val{font-size:1.1rem;color:var(--gold);font-weight:700}
.lb-meta{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted)}
.live-badge{display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;font-weight:600;padding:0.2rem 0.6rem;border-radius:20px;background:rgba(76,175,118,0.15);color:var(--success);border:1px solid rgba(76,175,118,0.3)}
.live-dot{width:8px;height:8px;background:var(--success);border-radius:50%;animation:pulse 1.5s infinite;display:inline-block}
.offline-dot{width:8px;height:8px;background:var(--text-muted);border-radius:50%;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)}}
.rank-cell{font-size:1.1rem;font-weight:800;white-space:nowrap}.name-cell{font-weight:600}
.badge-legend{margin-top:1.25rem;font-size:0.82rem;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.badge{display:inline-block;font-size:0.68rem;font-weight:700;padding:0.18rem 0.45rem;border-radius:4px;letter-spacing:0.04em;text-transform:uppercase}
.badge.mc{background:#7c3c3c;color:#ffb0b0}.badge.wd{background:#5c5000;color:#ffe066}
.badge.dq{background:#6b1a1a;color:#ff8888}.badge.act{background:rgba(76,175,118,0.25);color:var(--success)}
.badge.cut{background:rgba(200,169,74,0.25);color:var(--gold)}
.rules-grid{display:grid;grid-template-columns:1fr;gap:1.25rem}
@media(min-width:640px){.rules-grid{grid-template-columns:1fr 1fr}}
@media(min-width:900px){.rules-grid{grid-template-columns:1fr 1fr 1fr}}
.rules-list{list-style:none;padding:0}
.rules-list li{padding:0.45rem 0;border-bottom:1px solid var(--green-border);font-size:0.9rem;color:var(--text);padding-left:1rem;position:relative}
.rules-list li:last-child{border-bottom:none}
.prize-card{grid-column:1/-1}
@media(min-width:900px){.prize-card{grid-column:auto}}
.prize-table{margin:1rem 0}
.prize-row{display:flex;justify-content:space-between;align-items:center;padding:0.85rem 1.25rem;border-radius:var(--radius-sm);margin-bottom:0.5rem}
.prize-1st{background:linear-gradient(90deg,rgba(200,169,74,0.25),rgba(200,169,74,0.08));border:1px solid rgba(200,169,74,0.4)}
.prize-2nd{background:linear-gradient(90deg,rgba(192,192,192,0.15),rgba(192,192,192,0.05));border:1px solid rgba(192,192,192,0.2)}
.prize-3rd{background:linear-gradient(90deg,rgba(175,105,42,0.15),rgba(175,105,42,0.05));border:1px solid rgba(175,105,42,0.2)}
.prize-pos{font-weight:700;font-size:1rem;color:var(--text)}
.prize-pct{font-size:1.4rem;font-weight:800;color:var(--gold)}
.prize-note{font-size:0.82rem;color:var(--text-muted);margin-top:0.4rem}
.admin-hero{background:linear-gradient(135deg,var(--green-mid),#0d2818);border-bottom:2px solid var(--gold);padding:2rem 1.5rem;text-align:center}
.admin-hero h1{color:var(--gold);font-size:1.8rem;margin-bottom:0.25rem}
.admin-hero p{color:var(--text-muted);font-size:0.9rem}
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-bottom:1.5rem}
@media(min-width:640px){.stats-grid{grid-template-columns:repeat(4,1fr)}}
.stat-card{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius);padding:1.25rem;text-align:center}
.stat-num{font-size:2.2rem;font-weight:800;color:var(--gold);line-height:1}
.stat-label{font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;margin-top:0.4rem;letter-spacing:0.04em}
.stat-paid .stat-num{color:var(--success)}.stat-pool .stat-num{color:var(--gold-light)}
.admin-section{margin-bottom:1.5rem}
.field-status{margin-bottom:1rem;font-size:0.9rem}
.badge-status{display:inline-block;padding:0.35rem 0.75rem;border-radius:var(--radius-sm);font-weight:600;font-size:0.88rem}
.badge-status.locked{background:rgba(200,169,74,0.2);color:var(--gold);border:1px solid var(--gold)}
.badge-status.open{background:rgba(76,175,118,0.15);color:var(--success);border:1px solid var(--success)}
.admin-actions-row{display:flex;flex-wrap:wrap;gap:0.75rem;align-items:flex-start;margin-bottom:1rem}
.import-form{display:flex;flex-direction:column;gap:0.5rem;flex:1;min-width:250px}
.code-input{background:var(--green-dark)!important;border:1.5px solid var(--green-border)!important;color:var(--text)!important;border-radius:var(--radius-sm)!important;padding:0.65rem 0.85rem!important;font-family:monospace!important;font-size:0.82rem!important;width:100%!important;resize:vertical}
.or-divider{color:var(--text-muted);font-size:0.85rem;align-self:center;padding:0.5rem}
.inline-form{display:inline-block}.lock-form{margin-top:0.75rem}
.scraper-status{margin-bottom:1rem;font-size:0.9rem;color:var(--text-muted)}
.settings-form .form-row{align-items:end}
.scores-table{min-width:700px}
.empty-state{text-align:center;color:var(--text-muted);padding:3rem 1rem;font-size:1rem}
.footer{background:var(--green-mid);border-top:2px solid var(--green-border);padding:1.5rem 1rem;margin-top:3rem}
.footer-inner{max-width:1100px;margin:0 auto;text-align:center}
.footer-inner p{color:var(--text-muted);font-size:0.82rem;margin-bottom:0.25rem}
.footer-inner strong{color:var(--gold)}
.center{text-align:center}
  </style>
</head>
<body>
  <nav class="navbar">
    <div class="nav-inner">
      <a href="${isAdmin?'/admin/dashboard':'/'}" class="nav-brand">
        <span class="brand-icon">⛳</span>
        <span class="brand-text">RBC Heritage <span class="brand-year">2026</span></span>
      </a>
      ${isAdmin
        ? `<div class="nav-links">
             <a href="/admin/dashboard">Dashboard</a>
             <a href="/admin/users">Users</a>
             <a href="/admin/entries">Entries</a>
             <a href="/admin/scores">Scores</a>
             <a href="/admin/leaderboard">Leaderboard</a>
             <a href="/admin/logout" class="btn-nav-outline">Exit Admin</a>
           </div>`
        : `<button class="nav-toggle" onclick="this.nextElementSibling.classList.toggle('open')">☰</button>
           <div class="nav-links">${navLinks}</div>`
      }
    </div>
  </nav>
  <main>${body}</main>
  <footer class="footer">
    <div class="footer-inner">
      <p><strong>2026 RBC Heritage Sweepstake</strong></p>
      <p>Harbour Town Golf Links, Hilton Head Island SC &bull; 16–19 April 2026</p>
      <p>Entry fee: €${ENTRY_FEE} &bull; Prizes paid via Revolut within 24 hours &bull; Organiser's decision is final</p>
    </div>
  </footer>
</body>
</html>`;
}

const flash = (type, msg) => msg ? `<div class="flash flash-${type}">${esc(msg)}</div>` : '';

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function loginPage(err = '') {
  return layout('Login', `
  <section class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">⛳</div>
      <h1>RBC Heritage 2026</h1>
      <p class="auth-sub">Sweepstake &bull; Harbour Town Golf Links</p>
      ${flash('error', err)}
      <form method="POST" action="/login" class="auth-form">
        <div class="form-group">
          <label>Phone Number</label>
          <input type="tel" name="phone" required placeholder="e.g. 087 123 4567" autocomplete="tel">
        </div>
        <button type="submit" class="btn btn-gold btn-full">Sign In</button>
      </form>
      <p class="auth-alt">Don't have an account? <a href="/register">Register here</a></p>
      <p class="auth-alt small">Entry deadline: Wednesday 15 April 2026, 11:59pm Irish time</p>
    </div>
  </section>`, { activeNav: 'login' });
}

// ─── REGISTER ─────────────────────────────────────────────────────────────────
function registerPage(err = '', vals = {}) {
  return layout('Register', `
  <section class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">⛳</div>
      <h1>Create Account</h1>
      <p class="auth-sub">2026 RBC Heritage Sweepstake</p>
      ${flash('error', err)}
      <div class="payment-notice">
        <strong>⚠️ Important:</strong> Registering does <strong>not</strong> confirm your place.<br>
        You must send your <strong>€20 stake via Revolut</strong> to the organiser — your entry will only be activated once payment is received before the deadline.
      </div>
      <form method="POST" action="/register" class="auth-form">
        <div class="form-group">
          <label>Full Name</label>
          <input type="text" name="full_name" required value="${esc(vals.full_name||'')}" placeholder="Your full name">
        </div>
        <div class="form-group">
          <label>Phone Number</label>
          <input type="tel" name="phone" required value="${esc(vals.phone||'')}" placeholder="e.g. 087 123 4567" autocomplete="tel">
        </div>
        <button type="submit" class="btn btn-gold btn-full">Register</button>
      </form>
      <p class="auth-alt">Already registered? <a href="/login">Sign in with your phone number</a></p>
    </div>
  </section>`, { activeNav: 'register' });
}

// ─── MY ENTRY ─────────────────────────────────────────────────────────────────
function myEntryPage(user, entry, golfers, err = '', success = '') {
  const par = getPar();
  const oddsLocked = getSetting('odds_locked') === '1';
  const open = isEntriesOpen();
  const golferMap = {};
  golfers.forEach(g => { golferMap[g.id] = g.odds_value; });

  let contentHtml = '';

  if (entry) {
    const s1 = db.prepare('SELECT * FROM scores WHERE golfer_id=?').get(entry.golfer1_id);
    const s2 = db.prepare('SELECT * FROM scores WHERE golfer_id=?').get(entry.golfer2_id);
    const s3 = db.prepare('SELECT * FROM scores WHERE golfer_id=?').get(entry.golfer3_id);
    const sc1 = calcGolferScore(s1, par), sc2 = calcGolferScore(s2, par), sc3 = calcGolferScore(s3, par);
    const total = sc1 + sc2 + sc3;
    const { rows } = calcLeaderboard();
    const myRank = rows.find(r => r.user_id === user.id);
    const g1 = db.prepare('SELECT * FROM golfers WHERE id=?').get(entry.golfer1_id);
    const g2 = db.prepare('SELECT * FROM golfers WHERE id=?').get(entry.golfer2_id);
    const g3 = db.prepare('SELECT * FROM golfers WHERE id=?').get(entry.golfer3_id);

    const golferRow = (g, sc, s) => {
      const rounds = s ? `${s.round1??'-'} / ${s.round2??'-'} / ${s.round3??'-'} / ${s.round4??'-'}` : '- / - / - / -';
      return `<tr>
        <td><strong>${esc(g.name)}</strong><br><span class="odds-pill">${esc(g.odds_display)}</span></td>
        <td class="center">${rounds}</td>
        <td class="center">${s ? statusBadge(s.status) : ''}</td>
        <td class="center score-total">${sc > 0 ? sc : '—'}</td>
      </tr>`;
    };

    contentHtml = `
    <div class="hero-sm hero-celebrate">
      <div class="hero-overlay"><h1>My Entry</h1><p>2026 RBC Heritage — Harbour Town Golf Links</p></div>
    </div>
    <div class="container">
      <div class="cards-row">
        <div class="card entry-status-card">
          <h2>Entry Status</h2>
          <div class="status-row">
            <div class="status-item">
              <div class="status-label">Payment</div>
              <div class="status-value ${entry.is_paid ? 'text-success' : 'text-warning'}">
                ${entry.is_paid ? '✓ Confirmed' : '⏳ Awaiting Confirmation'}
              </div>
            </div>
            <div class="status-item">
              <div class="status-label">Submitted</div>
              <div class="status-value">${fmtDate(entry.submitted_at)}</div>
            </div>
            ${myRank ? `
            <div class="status-item">
              <div class="status-label">Current Rank</div>
              <div class="status-value rank-display">#${myRank.rank}</div>
            </div>
            <div class="status-item">
              <div class="status-label">Prize</div>
              <div class="status-value ${myRank.prize > 0 ? 'text-gold' : ''}">${formatPrize(myRank.prize)}</div>
            </div>` : ''}
          </div>
          ${!entry.is_paid ? `<p class="info-note">⚠️ Your entry only counts once payment of €${ENTRY_FEE} is confirmed by the organiser before the deadline.</p>` : ''}
        </div>
      </div>
      <div class="card">
        <h2>Your Picks</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Golfer (Odds)</th><th class="center">R1 / R2 / R3 / R4</th><th class="center">Status</th><th class="center">Score</th></tr></thead>
            <tbody>
              ${golferRow(g1, sc1, s1)}
              ${golferRow(g2, sc2, s2)}
              ${golferRow(g3, sc3, s3)}
              <tr class="total-row"><td colspan="3"><strong>Combined Score</strong></td><td class="center score-total"><strong>${total > 0 ? total : '—'}</strong></td></tr>
            </tbody>
          </table>
        </div>
        <div class="picks-meta">
          <span>Combined odds: <strong>${entry.combined_odds.toFixed(1)}/1</strong></span>
          <span>Tiebreaker prediction: <strong>${entry.predicted_score}</strong></span>
        </div>
      </div>
    </div>`;

  } else if (!oddsLocked || golfers.length === 0) {
    contentHtml = `
    <div class="hero hero-celebrate">
      <div class="hero-overlay">
        <h1>RBC Heritage 2026</h1>
        <p>Harbour Town Golf Links &bull; Hilton Head Island, SC &bull; 16–19 April 2026</p>
        <p class="hero-sub">Entry Fee: €${ENTRY_FEE} &bull; Deadline: Wednesday 15 April 2026, 11:59pm Irish time</p>
      </div>
    </div>
    <div class="container">
      <div class="card center-card">
        <div class="setup-icon">🏌️</div>
        <h2>Entry Form Coming Soon</h2>
        <p>The organiser hasn't locked the field yet. Check back shortly.</p>
        <p><a href="/rules" class="btn btn-outline">View Rules &amp; Prizes</a></p>
      </div>
    </div>`;
  } else if (!open) {
    contentHtml = `
    <div class="hero hero-celebrate">
      <div class="hero-overlay"><h1>RBC Heritage 2026</h1><p>Harbour Town Golf Links</p></div>
    </div>
    <div class="container">
      <div class="card center-card">
        <div class="setup-icon">🔒</div>
        <h2>Entries Are Closed</h2>
        <p>The entry deadline has passed. No late entries under any circumstances.</p>
        <a href="/leaderboard" class="btn btn-gold">View Leaderboard</a>
      </div>
    </div>`;
  } else {
    const golferOptions = golfers.map(g =>
      `<option value="${g.id}" data-odds="${g.odds_value}">${esc(g.name)} (${esc(g.odds_display)})</option>`
    ).join('');

    contentHtml = `
    <div class="hero hero-celebrate">
      <div class="hero-overlay">
        <h1>RBC Heritage 2026</h1>
        <p>Harbour Town Golf Links &bull; Hilton Head Island, SC &bull; 16–19 April 2026</p>
        <p class="hero-sub">Entry Fee: €${ENTRY_FEE} &bull; Deadline: Wednesday 15 April 2026, 11:59pm Irish time</p>
      </div>
    </div>
    <div class="container">
      ${flash('error', err)}
      ${flash('success', success)}
      <div class="card entry-card">
        <h2>Submit Your Entry</h2>
        <p class="card-sub">Pick 3 golfers. Combined Paddy Power outright odds must total at least <strong>100/1</strong>. Picks lock on submission — no changes.</p>
        <div class="info-banner">
          <strong>Entering as:</strong> ${esc(user.full_name)} &bull; ${esc(user.phone)}
        </div>
        <form method="POST" action="/entry" class="entry-form" onsubmit="return validateEntry()">
          <div class="form-row">
            <div class="form-group">
              <label>Pick 1</label>
              <select name="golfer1" id="g1" required onchange="updateOdds()">
                <option value="">— Select golfer —</option>${golferOptions}
              </select>
            </div>
            <div class="form-group">
              <label>Pick 2</label>
              <select name="golfer2" id="g2" required onchange="updateOdds()">
                <option value="">— Select golfer —</option>${golferOptions}
              </select>
            </div>
            <div class="form-group">
              <label>Pick 3</label>
              <select name="golfer3" id="g3" required onchange="updateOdds()">
                <option value="">— Select golfer —</option>${golferOptions}
              </select>
            </div>
          </div>
          <div id="odds-display" class="odds-display" style="display:none"></div>
          <div class="form-group">
            <label>Predicted Winning 72-Hole Score (tiebreaker)</label>
            <input type="number" name="predicted_score" required min="200" max="320" placeholder="e.g. 265">
            <small>Total stroke count (not relative to par). Harbour Town par 71 — e.g. -15 = 269.</small>
          </div>
          <div class="entry-rules-note">
            <strong>Important:</strong> Pay €${ENTRY_FEE} via <strong>Revolut</strong> and contact the organiser to confirm. Entries not paid before the deadline will not count.
          </div>
          <button type="submit" class="btn btn-gold btn-full">Submit Entry — €${ENTRY_FEE}</button>
        </form>
      </div>
    </div>
    <script>
    var gData = ${JSON.stringify(golferMap)};
    function updateOdds() {
      var g1=document.getElementById('g1').value, g2=document.getElementById('g2').value, g3=document.getElementById('g3').value;
      var el=document.getElementById('odds-display');
      if(!g1||!g2||!g3){el.style.display='none';return;}
      if(g1===g2||g1===g3||g2===g3){el.className='odds-display odds-invalid';el.textContent='✗ Pick 3 different golfers';el.style.display='block';return;}
      var c=(gData[g1]||0)+(gData[g2]||0)+(gData[g3]||0),ok=c>=100;
      el.className='odds-display '+(ok?'odds-valid':'odds-invalid');
      el.textContent=(ok?'✓':'✗')+' Combined odds: '+c.toFixed(1)+'/1'+(ok?' — OK!':' — must be at least 100/1');
      el.style.display='block';
    }
    function validateEntry(){
      var g1=document.getElementById('g1').value,g2=document.getElementById('g2').value,g3=document.getElementById('g3').value;
      if(!g1||!g2||!g3){alert('Please select all 3 golfers.');return false;}
      if(g1===g2||g1===g3||g2===g3){alert('Pick 3 different golfers.');return false;}
      var c=(gData[g1]||0)+(gData[g2]||0)+(gData[g3]||0);
      if(c<100){alert('Combined odds must be at least 100/1. Current: '+c.toFixed(1)+'/1');return false;}
      return true;
    }
    </script>`;
  }
  return layout('My Entry', contentHtml, { user, activeNav: 'my-entry' });
}

// ─── RULES ────────────────────────────────────────────────────────────────────
function rulesPage(user) {
  const par = getPar();
  return layout('Rules & Prizes', `
  <div class="hero hero-jump">
    <div class="hero-overlay">
      <h1>Rules &amp; Prizes</h1>
      <p>2026 RBC Heritage Sweepstake</p>
    </div>
  </div>
  <div class="container rules-container">
    <div class="rules-grid">
      <div class="card">
        <h2>🏆 The Basics</h2>
        <ul class="rules-list">
          <li>Entry fee: <strong>€${ENTRY_FEE} per person</strong></li>
          <li>Pick <strong>3 golfers</strong> from the RBC Heritage field</li>
          <li>Deadline: <strong>Wednesday 15 April 2026, 11:59pm Irish time</strong></li>
          <li>No late entries under any circumstances</li>
          <li>Picks lock immediately on submission — <strong>no changes</strong></li>
          <li>Entry only counts once payment is confirmed before the deadline</li>
          <li>Must register and log in to enter</li>
          <li>One entry per person</li>
        </ul>
      </div>
      <div class="card">
        <h2>🎯 Odds Rule</h2>
        <ul class="rules-list">
          <li>Odds used are <strong>Paddy Power outright winner odds</strong></li>
          <li>Odds are a <strong>one-time snapshot</strong> — official and final</li>
          <li>Combined price of 3 picks must total <strong>at least 100/1</strong></li>
          <li>Example: 40/1 + 33/1 + 30/1 = 103/1 ✓</li>
          <li>Entries below 100/1 combined are <strong>blocked</strong></li>
        </ul>
      </div>
      <div class="card">
        <h2>📊 Scoring</h2>
        <ul class="rules-list">
          <li>Entry score = combined 72-hole stroke total of your 3 golfers</li>
          <li><strong>Lowest combined score wins</strong></li>
          <li>All 4 rounds count</li>
          <li><strong>Missed Cut:</strong> R1+R2 actual, R3+R4 = par+5 each (${par+5} per round)</li>
          <li><strong>Withdrawn/DQ:</strong> completed rounds count, remaining = par+5 (${par+5}) per round</li>
          <li>No replacements in any situation</li>
          <li>Tournament par: <strong>${par}</strong></li>
        </ul>
      </div>
      <div class="card">
        <h2>⚖️ Tiebreaker</h2>
        <ul class="rules-list">
          <li>If tied on strokes: closest <strong>predicted winning score</strong> wins</li>
          <li>If still tied: combine and split the relevant prize places equally</li>
        </ul>
      </div>
      <div class="card prize-card">
        <h2>💰 Prize Structure</h2>
        <p>Pool = confirmed paid entries × €${ENTRY_FEE}</p>
        <div class="prize-table">
          <div class="prize-row prize-1st"><span class="prize-pos">🥇 1st Place</span><span class="prize-pct">60%</span></div>
          <div class="prize-row prize-2nd"><span class="prize-pos">🥈 2nd Place</span><span class="prize-pct">30%</span></div>
          <div class="prize-row prize-3rd"><span class="prize-pos">🥉 3rd Place</span><span class="prize-pct">10%</span></div>
        </div>
        <p class="prize-note">Example: 20 entries = €${20*ENTRY_FEE} pool → 1st €${(20*ENTRY_FEE*0.6).toFixed(0)}, 2nd €${(20*ENTRY_FEE*0.3).toFixed(0)}, 3rd €${(20*ENTRY_FEE*0.1).toFixed(0)}</p>
        <p class="prize-note">Prizes paid via <strong>Revolut</strong> within 24 hours of official result.</p>
        <p class="prize-note">Organiser's decision is final on all disputes.</p>
      </div>
      <div class="card">
        <h2>📅 Tournament Info</h2>
        <ul class="rules-list">
          <li><strong>Event:</strong> 2026 RBC Heritage</li>
          <li><strong>Venue:</strong> Harbour Town Golf Links, Hilton Head Island, SC</li>
          <li><strong>Dates:</strong> 16–19 April 2026</li>
          <li><strong>Par:</strong> ${par}</li>
          <li><strong>Format:</strong> 72-hole stroke play</li>
          <li><strong>Purse:</strong> $20 million</li>
        </ul>
      </div>
    </div>
  </div>`, { user, activeNav: 'rules' });
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
function leaderboardPage(user) {
  const scraperActive = getSetting('scraper_active') === '1';
  const lastRun       = getSetting('scraper_last_run');
  const ws            = getSetting('winning_score');
  const { rows, pool, prizes } = calcLeaderboard();

  const liveHtml = scraperActive
    ? `<span class="live-dot"></span><span>LIVE</span>`
    : `<span class="offline-dot"></span><span>Static</span>`;

  const prizeBoxes = [
    { label: '🥇 1st', val: prizes[0] },
    { label: '🥈 2nd', val: prizes[1] },
    { label: '🥉 3rd', val: prizes[2] },
  ].map(p => `<div class="prize-box"><div class="prize-box-label">${p.label}</div><div class="prize-box-val">${formatPrize(p.val)}</div></div>`).join('');

  const tableHtml = rows.length === 0
    ? `<div class="empty-state">No confirmed paid entries yet. Check back soon!</div>`
    : `<div class="table-wrap">
        <table class="data-table leaderboard-table">
          <thead><tr>
            <th>Rank</th><th>Entrant</th><th>Pick 1</th><th>Pick 2</th><th>Pick 3</th>
            <th class="center">Total</th><th class="center">Prediction</th><th class="center">Prize</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => {
              const ri = r.rank <= 3 ? ['🥇','🥈','🥉'][r.rank-1] : '#'+r.rank;
              return `<tr class="${r.rank<=3?'podium-row':''}">
                <td class="rank-cell">${ri}</td>
                <td class="name-cell">${esc(r.full_name)}</td>
                <td>${esc(r.g1n)} <span class="odds-pill">${esc(r.g1o)}</span><br>${r.s1?`<span class="score-inline">${r.sc1>0?r.sc1:'—'}</span>`:''}${r.s1?statusBadge(r.s1.status):''}</td>
                <td>${esc(r.g2n)} <span class="odds-pill">${esc(r.g2o)}</span><br>${r.s2?`<span class="score-inline">${r.sc2>0?r.sc2:'—'}</span>`:''}${r.s2?statusBadge(r.s2.status):''}</td>
                <td>${esc(r.g3n)} <span class="odds-pill">${esc(r.g3o)}</span><br>${r.s3?`<span class="score-inline">${r.sc3>0?r.sc3:'—'}</span>`:''}${r.s3?statusBadge(r.s3.status):''}</td>
                <td class="center score-total">${r.total>0?r.total:'—'}</td>
                <td class="center">${r.predicted_score}</td>
                <td class="center ${r.prize>0?'text-gold':''}">${formatPrize(r.prize)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

  return layout('Leaderboard', `
  <div class="hero hero-quail">
    <div class="hero-overlay"><h1>Live Leaderboard</h1><p>2026 RBC Heritage &bull; Harbour Town Golf Links</p></div>
  </div>
  <div class="container">
    <div class="lb-header">
      <div class="lb-stats">
        <div class="lb-stat"><span class="lb-stat-val">${rows.length}</span><span class="lb-stat-label">Entries</span></div>
        <div class="lb-stat"><span class="lb-stat-val">€${pool.toFixed(0)}</span><span class="lb-stat-label">Prize Pool</span></div>
        ${prizeBoxes}
      </div>
      <div class="lb-meta">
        <span class="live-badge">${liveHtml}</span>
        <span class="lb-updated">Updated: ${lastRun ? fmtDate(lastRun) : 'Not yet'}</span>
        ${ws ? `<span class="lb-ws">Winning score: <strong>${ws}</strong></span>` : ''}
      </div>
    </div>
    ${tableHtml}
    <div class="badge-legend">
      <strong>Key:</strong>
      <span class="badge act">ACT</span> Active &nbsp;
      <span class="badge cut">CUT</span> Made Cut &nbsp;
      <span class="badge mc">MC</span> Missed Cut (par+5/rd) &nbsp;
      <span class="badge wd">WD</span> Withdrawn &nbsp;
      <span class="badge dq">DQ</span> Disqualified
    </div>
  </div>`, { user, activeNav: 'leaderboard' });
}

// ─── ADMIN PAGES ──────────────────────────────────────────────────────────────
function adminLoginPage(err = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Admin | RBC Heritage 2026</title><style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--green-dark:#0d1f16;--green-mid:#1a4a2e;--green-light:#256638;--green-card:#1a3826;--green-border:#2a5c3a;--gold:#c8a94a;--gold-light:#e8c87a;--gold-dark:#a08030;--text:#e8ede9;--text-muted:#8aaa92;--white:#ffffff;--danger:#e05252;--success:#4caf76;--warning:#e8b44a;--radius:10px;--radius-sm:6px;--shadow:0 4px 20px rgba(0,0,0,0.4);--shadow-sm:0 2px 8px rgba(0,0,0,0.3)}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--green-dark);color:var(--text);min-height:100vh;line-height:1.6;font-size:15px}
a{color:var(--gold);text-decoration:none}a:hover{color:var(--gold-light);text-decoration:underline}
.navbar{background:var(--green-mid);border-bottom:2px solid var(--gold);position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,0.5)}
.nav-inner{max-width:1200px;margin:0 auto;padding:0 1rem;display:flex;align-items:center;justify-content:space-between;height:60px}
.nav-brand{display:flex;align-items:center;gap:0.5rem;font-weight:700;font-size:1.1rem;color:var(--gold);text-decoration:none}
.brand-icon{font-size:1.4rem}.brand-year{color:var(--gold-light)}
.nav-links{display:flex;align-items:center;gap:0.25rem}
.nav-links a{color:var(--text);padding:0.4rem 0.75rem;border-radius:var(--radius-sm);font-size:0.9rem;transition:background 0.2s,color 0.2s;text-decoration:none}
.nav-links a:hover,.nav-links a.active{background:var(--green-light);color:var(--white)}
.btn-nav-gold{background:var(--gold)!important;color:var(--green-dark)!important;font-weight:700;padding:0.4rem 1rem!important}
.btn-nav-gold:hover{background:var(--gold-light)!important}
.btn-nav-outline{border:1px solid var(--gold)!important;color:var(--gold)!important}
.btn-nav-outline:hover{background:var(--gold)!important;color:var(--green-dark)!important}
.nav-toggle{display:none;background:none;border:none;color:var(--gold);font-size:1.5rem;cursor:pointer;padding:0.25rem}
@media(max-width:768px){.nav-toggle{display:block}.nav-links{display:none;position:absolute;top:60px;left:0;right:0;background:var(--green-mid);flex-direction:column;padding:1rem;gap:0.5rem;border-bottom:2px solid var(--gold);box-shadow:var(--shadow)}.nav-links.open{display:flex}.nav-links a{width:100%;text-align:center;padding:0.6rem}}
.hero,.hero-sm{position:relative;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;text-align:center}
.hero{min-height:100vh}.hero-sm{min-height:220px}
.hero-celebrate{background-image:url("/john-daly.jpg");background-color:var(--green-mid);background-position:center 15%}
.hero-jump{background-image:url("/shaggy.jpg");background-color:var(--green-mid)}
.hero-quail{background-image:url("/john-daly.jpg");background-color:var(--green-mid);background-position:center 20%}
.hero-overlay{position:relative;z-index:2;padding:2rem 1.5rem}
.hero::before,.hero-sm::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(13,31,22,0.35) 0%,rgba(26,74,46,0.25) 100%);z-index:1}
.hero-overlay h1{font-size:clamp(1.8rem,5vw,3.2rem);color:var(--gold);text-shadow:0 2px 8px rgba(0,0,0,0.6);font-weight:800;margin-bottom:0.5rem}
.hero-overlay p{font-size:1rem;color:rgba(255,255,255,0.9);margin-bottom:0.25rem}
.hero-sub{color:var(--gold-light)!important;font-size:0.95rem!important;margin-top:0.5rem!important}
.photo-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;background:var(--green-dark);border-bottom:3px solid var(--gold)}
.photo-panel{overflow:hidden;height:260px;position:relative;cursor:zoom-in}
.photo-panel img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block;transition:transform 0.4s ease}
.photo-panel img:hover{transform:scale(1.06)}
.photo-caption{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.75));color:var(--gold-light);font-size:0.75rem;font-weight:600;padding:0.5rem 0.6rem 0.4rem;letter-spacing:0.04em;text-transform:uppercase}
.photo-gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;background:var(--green-dark)}
.gallery-panel{overflow:hidden;height:200px;position:relative;cursor:zoom-in}
.gallery-panel img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;transition:transform 0.4s ease}
.gallery-panel img:hover{transform:scale(1.06)}
@media(max-width:600px){.photo-panel{height:150px}.gallery-panel{height:120px}}
.container{max-width:1100px;margin:0 auto;padding:2rem 1rem}
.rules-container{max-width:960px}
.cards-row{display:grid;gap:1rem;margin-bottom:1.5rem}
.card{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius);padding:1.5rem;box-shadow:var(--shadow-sm);margin-bottom:1.5rem}
.card h2{color:var(--gold);font-size:1.2rem;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid var(--green-border)}
.card-sub{color:var(--text-muted);font-size:0.9rem;margin-bottom:1.25rem}
.center-card{text-align:center}.setup-icon{font-size:3rem;margin-bottom:1rem}
.btn{display:inline-block;padding:0.65rem 1.5rem;border-radius:var(--radius-sm);font-size:0.95rem;font-weight:600;cursor:pointer;border:none;transition:all 0.2s;text-decoration:none;line-height:1}
.btn-gold{background:var(--gold);color:var(--green-dark)}.btn-gold:hover{background:var(--gold-light);color:var(--green-dark);text-decoration:none}
.btn-outline{background:transparent;color:var(--gold);border:1.5px solid var(--gold)}.btn-outline:hover{background:var(--gold);color:var(--green-dark);text-decoration:none}
.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover{background:#c04040}
.btn-full{width:100%;text-align:center;padding:0.8rem;font-size:1rem}
.btn-xs{padding:0.3rem 0.6rem;font-size:0.8rem;border-radius:4px}
.form-group{margin-bottom:1.1rem}
.form-group label{display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.35rem;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
.form-group input,.form-group select,.form-group textarea{width:100%;background:var(--green-dark);border:1.5px solid var(--green-border);color:var(--text);border-radius:var(--radius-sm);padding:0.65rem 0.85rem;font-size:0.95rem;transition:border-color 0.2s;outline:none}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--gold)}
.form-group small{color:var(--text-muted);font-size:0.8rem;margin-top:0.25rem;display:block}
.form-row{display:grid;gap:1rem}
@media(min-width:640px){.form-row{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}}
.input-sm{background:var(--green-dark);border:1px solid var(--green-border);color:var(--text);border-radius:4px;padding:0.3rem 0.5rem;font-size:0.85rem;width:140px}
.score-input{width:64px;background:var(--green-dark);border:1px solid var(--green-border);color:var(--text);border-radius:4px;padding:0.3rem;text-align:center;font-size:0.85rem}
.status-select{background:var(--green-dark);border:1px solid var(--green-border);color:var(--text);border-radius:4px;padding:0.3rem 0.5rem;font-size:0.85rem}
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;background:radial-gradient(ellipse at top,#1a4a2e 0%,#0d1f16 70%)}
.auth-card{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius);padding:2.5rem 2rem;width:100%;max-width:440px;box-shadow:var(--shadow)}
.auth-logo{font-size:3rem;text-align:center;margin-bottom:0.75rem}
.auth-card h1{text-align:center;color:var(--gold);font-size:1.6rem;margin-bottom:0.25rem}
.auth-sub{text-align:center;color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem}
.auth-form{margin-top:1rem}
.auth-alt{text-align:center;margin-top:1rem;font-size:0.85rem;color:var(--text-muted)}
.auth-alt.small{font-size:0.78rem;margin-top:0.5rem}
.payment-notice{background:rgba(200,169,74,0.12);border:1.5px solid var(--gold);border-radius:var(--radius-sm);padding:0.85rem 1rem;margin-bottom:1.2rem;font-size:0.88rem;color:var(--text);line-height:1.5}
.flash{padding:0.85rem 1rem;border-radius:var(--radius-sm);margin-bottom:1rem;font-size:0.9rem;font-weight:500}
.flash-error{background:rgba(224,82,82,0.2);border-left:4px solid var(--danger);color:#f0a0a0}
.flash-success{background:rgba(76,175,118,0.2);border-left:4px solid var(--success);color:#90d8a8}
.odds-display{padding:0.75rem 1rem;border-radius:var(--radius-sm);font-weight:600;margin-bottom:1rem;font-size:0.95rem}
.odds-valid{background:rgba(76,175,118,0.2);border:1px solid var(--success);color:#90d8a8}
.odds-invalid{background:rgba(224,82,82,0.2);border:1px solid var(--danger);color:#f0a0a0}
.odds-pill{background:rgba(200,169,74,0.18);color:var(--gold);font-size:0.75rem;padding:0.15rem 0.45rem;border-radius:20px;font-weight:600;white-space:nowrap}
.entry-card{max-width:800px;margin:0 auto 1.5rem}.entry-form{margin-top:1.5rem}
.info-banner{background:rgba(200,169,74,0.12);border:1px solid rgba(200,169,74,0.3);border-radius:var(--radius-sm);padding:0.75rem 1rem;margin-bottom:1.25rem;font-size:0.9rem;color:var(--gold-light)}
.entry-rules-note{background:rgba(26,74,46,0.6);border:1px solid var(--green-border);border-radius:var(--radius-sm);padding:0.85rem 1rem;font-size:0.85rem;color:var(--text-muted);margin-bottom:1.25rem}
.entry-status-card{margin-bottom:1.5rem}
.status-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem}
.status-label{font-size:0.75rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.05em}
.status-value{font-size:1rem;font-weight:600;margin-top:0.2rem}
.rank-display{font-size:1.8rem;color:var(--gold);font-weight:800}
.text-gold{color:var(--gold)!important}.text-success{color:var(--success)!important}
.text-warning{color:var(--warning)!important}.text-muted{color:var(--text-muted)!important}.text-danger{color:var(--danger)!important}
.picks-meta{display:flex;gap:1.5rem;margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--green-border);font-size:0.85rem;color:var(--text-muted);flex-wrap:wrap}
.info-note{background:rgba(232,180,74,0.1);border:1px solid rgba(232,180,74,0.25);border-radius:var(--radius-sm);padding:0.65rem 0.85rem;font-size:0.83rem;color:var(--warning);margin-top:1rem}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--radius-sm)}
.data-table{width:100%;border-collapse:collapse;font-size:0.88rem;min-width:500px}
.data-table th{background:var(--green-mid);color:var(--gold);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;padding:0.65rem 0.75rem;text-align:left;white-space:nowrap;border-bottom:2px solid var(--gold)}
.data-table td{padding:0.6rem 0.75rem;border-bottom:1px solid var(--green-border);vertical-align:middle;color:var(--text)}
.data-table tbody tr:hover{background:rgba(255,255,255,0.04)}
.data-table .center{text-align:center}
.total-row td{background:rgba(200,169,74,0.08);font-weight:600}
.score-total{color:var(--gold);font-weight:700;font-size:1rem}
.score-inline{font-weight:600;margin-right:0.25rem}
.podium-row{background:rgba(200,169,74,0.06)}
.lb-header{margin-bottom:1.5rem}
.lb-stats{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;align-items:center}
.lb-stat{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius-sm);padding:0.75rem 1.25rem;text-align:center;min-width:90px}
.lb-stat-val{display:block;font-size:1.4rem;font-weight:800;color:var(--gold)}
.lb-stat-label{display:block;font-size:0.72rem;color:var(--text-muted);text-transform:uppercase}
.prize-box{background:var(--green-mid);border:1px solid var(--gold);border-radius:var(--radius-sm);padding:0.5rem 1rem;text-align:center;min-width:80px}
.prize-box-label{font-size:0.78rem;color:var(--text-muted)}.prize-box-val{font-size:1.1rem;color:var(--gold);font-weight:700}
.lb-meta{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted)}
.live-badge{display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;font-weight:600;padding:0.2rem 0.6rem;border-radius:20px;background:rgba(76,175,118,0.15);color:var(--success);border:1px solid rgba(76,175,118,0.3)}
.live-dot{width:8px;height:8px;background:var(--success);border-radius:50%;animation:pulse 1.5s infinite;display:inline-block}
.offline-dot{width:8px;height:8px;background:var(--text-muted);border-radius:50%;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)}}
.rank-cell{font-size:1.1rem;font-weight:800;white-space:nowrap}.name-cell{font-weight:600}
.badge-legend{margin-top:1.25rem;font-size:0.82rem;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.badge{display:inline-block;font-size:0.68rem;font-weight:700;padding:0.18rem 0.45rem;border-radius:4px;letter-spacing:0.04em;text-transform:uppercase}
.badge.mc{background:#7c3c3c;color:#ffb0b0}.badge.wd{background:#5c5000;color:#ffe066}
.badge.dq{background:#6b1a1a;color:#ff8888}.badge.act{background:rgba(76,175,118,0.25);color:var(--success)}
.badge.cut{background:rgba(200,169,74,0.25);color:var(--gold)}
.rules-grid{display:grid;grid-template-columns:1fr;gap:1.25rem}
@media(min-width:640px){.rules-grid{grid-template-columns:1fr 1fr}}
@media(min-width:900px){.rules-grid{grid-template-columns:1fr 1fr 1fr}}
.rules-list{list-style:none;padding:0}
.rules-list li{padding:0.45rem 0;border-bottom:1px solid var(--green-border);font-size:0.9rem;color:var(--text);padding-left:1rem;position:relative}
.rules-list li:last-child{border-bottom:none}
.prize-card{grid-column:1/-1}
@media(min-width:900px){.prize-card{grid-column:auto}}
.prize-table{margin:1rem 0}
.prize-row{display:flex;justify-content:space-between;align-items:center;padding:0.85rem 1.25rem;border-radius:var(--radius-sm);margin-bottom:0.5rem}
.prize-1st{background:linear-gradient(90deg,rgba(200,169,74,0.25),rgba(200,169,74,0.08));border:1px solid rgba(200,169,74,0.4)}
.prize-2nd{background:linear-gradient(90deg,rgba(192,192,192,0.15),rgba(192,192,192,0.05));border:1px solid rgba(192,192,192,0.2)}
.prize-3rd{background:linear-gradient(90deg,rgba(175,105,42,0.15),rgba(175,105,42,0.05));border:1px solid rgba(175,105,42,0.2)}
.prize-pos{font-weight:700;font-size:1rem;color:var(--text)}
.prize-pct{font-size:1.4rem;font-weight:800;color:var(--gold)}
.prize-note{font-size:0.82rem;color:var(--text-muted);margin-top:0.4rem}
.admin-hero{background:linear-gradient(135deg,var(--green-mid),#0d2818);border-bottom:2px solid var(--gold);padding:2rem 1.5rem;text-align:center}
.admin-hero h1{color:var(--gold);font-size:1.8rem;margin-bottom:0.25rem}
.admin-hero p{color:var(--text-muted);font-size:0.9rem}
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-bottom:1.5rem}
@media(min-width:640px){.stats-grid{grid-template-columns:repeat(4,1fr)}}
.stat-card{background:var(--green-card);border:1px solid var(--green-border);border-radius:var(--radius);padding:1.25rem;text-align:center}
.stat-num{font-size:2.2rem;font-weight:800;color:var(--gold);line-height:1}
.stat-label{font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;margin-top:0.4rem;letter-spacing:0.04em}
.stat-paid .stat-num{color:var(--success)}.stat-pool .stat-num{color:var(--gold-light)}
.admin-section{margin-bottom:1.5rem}
.field-status{margin-bottom:1rem;font-size:0.9rem}
.badge-status{display:inline-block;padding:0.35rem 0.75rem;border-radius:var(--radius-sm);font-weight:600;font-size:0.88rem}
.badge-status.locked{background:rgba(200,169,74,0.2);color:var(--gold);border:1px solid var(--gold)}
.badge-status.open{background:rgba(76,175,118,0.15);color:var(--success);border:1px solid var(--success)}
.admin-actions-row{display:flex;flex-wrap:wrap;gap:0.75rem;align-items:flex-start;margin-bottom:1rem}
.import-form{display:flex;flex-direction:column;gap:0.5rem;flex:1;min-width:250px}
.code-input{background:var(--green-dark)!important;border:1.5px solid var(--green-border)!important;color:var(--text)!important;border-radius:var(--radius-sm)!important;padding:0.65rem 0.85rem!important;font-family:monospace!important;font-size:0.82rem!important;width:100%!important;resize:vertical}
.or-divider{color:var(--text-muted);font-size:0.85rem;align-self:center;padding:0.5rem}
.inline-form{display:inline-block}.lock-form{margin-top:0.75rem}
.scraper-status{margin-bottom:1rem;font-size:0.9rem;color:var(--text-muted)}
.settings-form .form-row{align-items:end}
.scores-table{min-width:700px}
.empty-state{text-align:center;color:var(--text-muted);padding:3rem 1rem;font-size:1rem}
.footer{background:var(--green-mid);border-top:2px solid var(--green-border);padding:1.5rem 1rem;margin-top:3rem}
.footer-inner{max-width:1100px;margin:0 auto;text-align:center}
.footer-inner p{color:var(--text-muted);font-size:0.82rem;margin-bottom:0.25rem}
.footer-inner strong{color:var(--gold)}
.center{text-align:center}
  </style></head><body>
  <section class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">🔒</div><h1>Admin Panel</h1><p class="auth-sub">RBC Heritage 2026 Sweepstake</p>
    ${flash('error', err)}
    <form method="POST" action="/admin" class="auth-form">
      <div class="form-group"><label>Admin Password</label><input type="password" name="password" required autofocus></div>
      <button type="submit" class="btn btn-gold btn-full">Enter Admin</button>
    </form>
    <p class="auth-alt"><a href="/">← Back to site</a></p>
  </div></section></body></html>`;
}

function adminDashboardPage(msg = '', err = '') {
  const totalUsers   = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const totalEntries = db.prepare('SELECT COUNT(*) c FROM entries').get().c;
  const paidEntries  = db.prepare('SELECT COUNT(*) c FROM entries WHERE is_paid=1').get().c;
  const pool         = paidEntries * ENTRY_FEE;
  const oddsLocked   = getSetting('odds_locked') === '1';
  const entriesOpen  = getSetting('entries_open') === '1';
  const par          = getSetting('tournament_par');
  const ws           = getSetting('winning_score');
  const scraperOn    = getSetting('scraper_active') === '1';
  const lastRun      = getSetting('scraper_last_run');
  const golferCount  = db.prepare('SELECT COUNT(*) c FROM golfers WHERE is_active=1').get().c;

  return layout('Admin Dashboard', `
  <div class="admin-hero"><h1>⛳ Admin Dashboard</h1><p>2026 RBC Heritage Sweepstake</p></div>
  <div class="container">
    ${flash('success', msg)}${flash('error', err)}
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${totalUsers}</div><div class="stat-label">Registered Users</div></div>
      <div class="stat-card"><div class="stat-num">${totalEntries}</div><div class="stat-label">Entries</div></div>
      <div class="stat-card stat-paid"><div class="stat-num">${paidEntries}</div><div class="stat-label">Paid Entries</div></div>
      <div class="stat-card stat-pool"><div class="stat-num">€${pool}</div><div class="stat-label">Prize Pool</div></div>
    </div>
    <div class="card admin-section">
      <h2>⛳ Field (${golferCount} golfers)</h2>
      <div class="field-status">Status: ${oddsLocked
        ? `<span class="badge-status locked">🔒 Field Locked</span>`
        : `<span class="badge-status open">${golferCount > 0 ? `✏️ ${golferCount} golfers loaded — not yet locked` : '⚠️ No golfers'}</span>`
      }</div>
      ${oddsLocked ? `<p class="info-note">Field is locked. Official Paddy Power odds snapshot is final.</p>` : `
      <div class="admin-actions-row">
        <form method="POST" action="/admin/import-odds" class="import-form">
          <textarea name="json_data" rows="4" placeholder='[{"name":"Scottie Scheffler","odds":"10/3"}]' class="code-input"></textarea>
          <button type="submit" class="btn btn-outline">📋 Import/Update Odds (JSON)</button>
        </form>
      </div>
      ${golferCount > 0 ? `
      <form method="POST" action="/admin/lock-odds" class="lock-form" onsubmit="return confirm('Permanently lock the field? Cannot be undone.')">
        <button type="submit" class="btn btn-danger">🔒 Lock Field (Permanent)</button>
      </form>` : ''}`}
    </div>
    <div class="card admin-section">
      <h2>⚙️ Tournament Settings</h2>
      <form method="POST" action="/admin/settings" class="settings-form">
        <div class="form-row">
          <div class="form-group"><label>Tournament Par</label><input type="number" name="tournament_par" value="${esc(par)}" min="68" max="75"></div>
          <div class="form-group"><label>Actual Winning Score (post-tournament)</label><input type="number" name="winning_score" value="${esc(ws)}" placeholder="e.g. 265" min="200" max="320"></div>
          <div class="form-group"><label>Entries</label>
            <select name="entries_open">
              <option value="1" ${entriesOpen?'selected':''}>Open</option>
              <option value="0" ${!entriesOpen?'selected':''}>Closed</option>
            </select>
          </div>
        </div>
        <button type="submit" class="btn btn-gold">Save Settings</button>
      </form>
    </div>
    <div class="card admin-section">
      <h2>🔄 Live Score Scraper</h2>
      <div class="scraper-status">Status: <span class="${scraperOn?'text-success':'text-muted'}">${scraperOn?'● Running (every 5 min)':'○ Disabled'}</span> &bull; Last run: ${lastRun?fmtDate(lastRun):'Never'}</div>
      <div class="admin-actions-row">
        <form method="POST" action="/admin/scraper-toggle"><button type="submit" class="btn ${scraperOn?'btn-danger':'btn-gold'}">${scraperOn?'⏸ Disable':'▶ Enable'} Scraper</button></form>
        <form method="POST" action="/admin/scraper-run"><button type="submit" class="btn btn-outline">⚡ Run Now</button></form>
      </div>
      <p class="info-note">Scraper pulls live scores from ESPN every 5 minutes. Manual overrides are never overwritten.</p>
    </div>
  </div>`, { isAdmin: true });
}

function adminUsersPage(msg = '') {
  const users = db.prepare(`SELECT u.*, e.id eid, e.is_paid FROM users u LEFT JOIN entries e ON e.user_id = u.id ORDER BY u.created_at DESC`).all();
  return layout('Admin: Users', `
  <div class="admin-hero"><h1>Users (${users.length})</h1></div>
  <div class="container">${flash('success', msg)}<div class="card"><div class="table-wrap">
    <table class="data-table"><thead><tr><th>#</th><th>Name</th><th>Phone</th><th class="center">Entry</th><th class="center">Paid</th><th>Joined</th><th class="center">Action</th></tr></thead>
    <tbody>${users.map(u => `<tr>
      <td>${u.id}</td><td>${esc(u.full_name)}</td><td>${esc(u.phone)}</td>
      <td class="center">${u.eid?'✓':'—'}</td>
      <td class="center">${u.eid?(u.is_paid?'<span class="text-success">✓ Paid</span>':'<span class="text-warning">Unpaid</span>'):'—'}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td class="center">${u.eid?`<form method="POST" action="/admin/toggle-paid" style="display:inline"><input type="hidden" name="entry_id" value="${u.eid}"><button type="submit" class="btn btn-xs ${u.is_paid?'btn-danger':'btn-gold'}">${u.is_paid?'Unpay':'Mark Paid'}</button></form>`:'—'}</td>
    </tr>`).join('')}</tbody></table>
  </div></div></div>`, { isAdmin: true });
}

function adminEntriesPage(msg = '') {
  const entries = db.prepare(`
    SELECT e.*, u.full_name, u.phone,
      g1.name g1n, g1.odds_display g1o,
      g2.name g2n, g2.odds_display g2o,
      g3.name g3n, g3.odds_display g3o
    FROM entries e
    JOIN users u ON u.id=e.user_id
    JOIN golfers g1 ON g1.id=e.golfer1_id
    JOIN golfers g2 ON g2.id=e.golfer2_id
    JOIN golfers g3 ON g3.id=e.golfer3_id
    ORDER BY e.submitted_at DESC`).all();
  return layout('Admin: Entries', `
  <div class="admin-hero"><h1>Entries (${entries.length})</h1></div>
  <div class="container">${flash('success', msg)}<div class="card"><div class="table-wrap">
    <table class="data-table"><thead><tr>
      <th>#</th><th>Name</th><th>Phone</th><th>Pick 1</th><th>Pick 2</th><th>Pick 3</th>
      <th class="center">Odds</th><th class="center">Pred.</th><th class="center">Paid</th><th>Submitted</th><th>Notes</th><th>Action</th>
    </tr></thead>
    <tbody>${entries.map(e => `<tr>
      <td>${e.id}</td><td>${esc(e.full_name)}</td><td>${esc(e.phone)}</td>
      <td>${esc(e.g1n)} <span class="odds-pill">${esc(e.g1o)}</span></td>
      <td>${esc(e.g2n)} <span class="odds-pill">${esc(e.g2o)}</span></td>
      <td>${esc(e.g3n)} <span class="odds-pill">${esc(e.g3o)}</span></td>
      <td class="center">${e.combined_odds.toFixed(1)}/1</td>
      <td class="center">${e.predicted_score}</td>
      <td class="center ${e.is_paid?'text-success':'text-warning'}">${e.is_paid?'✓ Paid':'Unpaid'}</td>
      <td>${fmtDate(e.submitted_at)}</td>
      <td><form method="POST" action="/admin/entry-notes" style="display:flex;gap:4px">
        <input type="hidden" name="entry_id" value="${e.id}">
        <input type="text" name="notes" value="${esc(e.notes||'')}" class="input-sm">
        <button type="submit" class="btn btn-xs btn-outline">💾</button>
      </form></td>
      <td><form method="POST" action="/admin/toggle-paid" style="display:inline">
        <input type="hidden" name="entry_id" value="${e.id}">
        <button type="submit" class="btn btn-xs ${e.is_paid?'btn-danger':'btn-gold'}">${e.is_paid?'Unpay':'Mark Paid'}</button>
      </form></td>
    </tr>`).join('')}</tbody></table>
  </div></div></div>`, { isAdmin: true });
}

function adminScoresPage(msg = '') {
  const golfers = db.prepare('SELECT g.*, s.round1, s.round2, s.round3, s.round4, s.status, s.manual_override FROM golfers g LEFT JOIN scores s ON s.golfer_id=g.id WHERE g.is_active=1 ORDER BY g.name').all();
  return layout('Admin: Scores', `
  <div class="admin-hero"><h1>Score Entry</h1></div>
  <div class="container">${flash('success', msg)}<div class="card">
    <p class="card-sub">Enter round scores. Check <strong>Manual Override</strong> to prevent scraper overwriting.</p>
    <form method="POST" action="/admin/scores"><div class="table-wrap">
      <table class="data-table scores-table"><thead><tr>
        <th>Golfer</th><th>Odds</th><th class="center">R1</th><th class="center">R2</th><th class="center">R3</th><th class="center">R4</th><th>Status</th><th class="center">Override</th>
      </tr></thead><tbody>
      ${golfers.map(g => `<tr>
        <td><strong>${esc(g.name)}</strong></td>
        <td><span class="odds-pill">${esc(g.odds_display)}</span></td>
        ${['round1','round2','round3','round4'].map(r => `<td class="center"><input type="number" name="r_${g.id}_${r}" value="${g[r]??''}" min="55" max="95" class="score-input"></td>`).join('')}
        <td><select name="status_${g.id}" class="status-select">
          <option value="active"       ${(g.status||'active')==='active'?'selected':''}>Active</option>
          <option value="made_cut"     ${g.status==='made_cut'?'selected':''}>Made Cut</option>
          <option value="missed_cut"   ${g.status==='missed_cut'?'selected':''}>Missed Cut</option>
          <option value="withdrawn"    ${g.status==='withdrawn'?'selected':''}>Withdrawn</option>
          <option value="disqualified" ${g.status==='disqualified'?'selected':''}>Disqualified</option>
        </select></td>
        <td class="center"><input type="checkbox" name="override_${g.id}" ${g.manual_override?'checked':''}></td>
      </tr>`).join('')}
      </tbody></table>
    </div>
    <div style="padding:1rem 0"><button type="submit" class="btn btn-gold">💾 Save All Scores</button></div>
    </form>
  </div></div>`, { isAdmin: true });
}

function adminLeaderboardPage() {
  const { rows, pool, prizes } = calcLeaderboard();
  const ws = getSetting('winning_score');
  return layout('Admin: Leaderboard', `
  <div class="admin-hero"><h1>Full Leaderboard</h1>
    <p>Pool: €${pool.toFixed(2)} &bull; 1st: ${formatPrize(prizes[0])} &bull; 2nd: ${formatPrize(prizes[1])} &bull; 3rd: ${formatPrize(prizes[2])}${ws?` &bull; Winning: ${ws}`:''}</p>
  </div>
  <div class="container"><div class="card">
    ${rows.length === 0 ? `<p class="empty-state">No paid entries yet.</p>` : `
    <div class="table-wrap"><table class="data-table leaderboard-table"><thead><tr>
      <th>Rank</th><th>Name</th><th>Pick 1</th><th>Pick 2</th><th>Pick 3</th>
      <th class="center">Sc1</th><th class="center">Sc2</th><th class="center">Sc3</th>
      <th class="center">Total</th><th class="center">Pred.</th><th class="center">TB</th><th class="center">Prize</th>
    </tr></thead><tbody>
    ${rows.map(r => `<tr class="${r.rank<=3?'podium-row':''}">
      <td class="rank-cell">${r.rank<=3?['🥇','🥈','🥉'][r.rank-1]:'#'+r.rank}</td>
      <td>${esc(r.full_name)}</td>
      <td>${esc(r.g1n)} ${statusBadge(r.s1?.status)}</td>
      <td>${esc(r.g2n)} ${statusBadge(r.s2?.status)}</td>
      <td>${esc(r.g3n)} ${statusBadge(r.s3?.status)}</td>
      <td class="center">${r.sc1||'—'}</td><td class="center">${r.sc2||'—'}</td><td class="center">${r.sc3||'—'}</td>
      <td class="center score-total">${r.total||'—'}</td>
      <td class="center">${r.predicted_score}</td>
      <td class="center">${r.tb<9999?r.tb:'—'}</td>
      <td class="center ${r.prize>0?'text-gold':''}">${formatPrize(r.prize)}</td>
    </tr>`).join('')}
    </tbody></table></div>`}
  </div></div>`, { isAdmin: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'rbc2026-sweep-s3cr3t',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES — PUBLIC
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/rules',       (req, res) => { const u = req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null; res.send(rulesPage(u)); });
app.get('/leaderboard', (req, res) => { const u = req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null; res.send(leaderboardPage(u)); });

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES — AUTH
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/login',  (req, res) => { if (req.session.userId) return res.redirect('/my-entry'); res.send(loginPage()); });
app.get('/register', (req, res) => { if (req.session.userId) return res.redirect('/my-entry'); res.send(registerPage()); });
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.post('/login', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.send(loginPage('Please enter your phone number.'));
  const cleanPhone = phone.trim().replace(/\s+/g, '');
  const user = db.prepare('SELECT * FROM users WHERE phone=?').get(cleanPhone);
  if (!user) return res.send(loginPage('No account found with that phone number.'));
  req.session.userId = user.id;
  res.redirect('/my-entry');
});

app.post('/register', (req, res) => {
  const { full_name, phone } = req.body;
  const vals = { full_name, phone };
  if (!full_name || !phone) return res.send(registerPage('Please fill in all fields.', vals));
  const cleanPhone = phone.trim().replace(/\s+/g, '');
  if (db.prepare('SELECT id FROM users WHERE phone=?').get(cleanPhone)) return res.send(registerPage('An account with that phone number already exists.', vals));
  const result = db.prepare('INSERT INTO users (full_name, phone) VALUES (?,?)').run(full_name.trim(), cleanPhone);
  req.session.userId = result.lastInsertRowid;
  res.redirect('/my-entry');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES — PRIVATE
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', requireLogin, (req, res) => res.redirect('/my-entry'));

app.get('/my-entry', requireLogin, (req, res) => {
  const user    = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const entry   = db.prepare('SELECT * FROM entries WHERE user_id=?').get(user.id);
  const golfers = db.prepare('SELECT * FROM golfers WHERE is_active=1 ORDER BY odds_value DESC').all();
  res.send(myEntryPage(user, entry, golfers));
});

app.post('/entry', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!isEntriesOpen()) { const g = db.prepare('SELECT * FROM golfers WHERE is_active=1 ORDER BY odds_value DESC').all(); return res.send(myEntryPage(user, null, g, 'Entries are now closed.')); }
  if (db.prepare('SELECT id FROM entries WHERE user_id=?').get(user.id)) return res.redirect('/my-entry');
  const { golfer1, golfer2, golfer3, predicted_score } = req.body;
  const golfers = db.prepare('SELECT * FROM golfers WHERE is_active=1 ORDER BY odds_value DESC').all();
  if (!golfer1 || !golfer2 || !golfer3 || !predicted_score) return res.send(myEntryPage(user, null, golfers, 'Please fill in all fields.'));
  const ids = [parseInt(golfer1), parseInt(golfer2), parseInt(golfer3)];
  if (ids[0]===ids[1] || ids[0]===ids[2] || ids[1]===ids[2]) return res.send(myEntryPage(user, null, golfers, 'Please pick 3 different golfers.'));
  const gs = ids.map(id => db.prepare('SELECT * FROM golfers WHERE id=? AND is_active=1').get(id));
  if (gs.some(g => !g)) return res.send(myEntryPage(user, null, golfers, 'Invalid golfer selection.'));
  const combined = gs[0].odds_value + gs[1].odds_value + gs[2].odds_value;
  if (combined < 100) return res.send(myEntryPage(user, null, golfers, `Combined odds must be at least 100/1. Your picks total ${combined.toFixed(1)}/1.`));
  const pred = parseInt(predicted_score);
  if (isNaN(pred) || pred < 200 || pred > 320) return res.send(myEntryPage(user, null, golfers, 'Please enter a valid predicted score (200–320).'));
  db.prepare('INSERT INTO entries (user_id, golfer1_id, golfer2_id, golfer3_id, combined_odds, predicted_score) VALUES (?,?,?,?,?,?)').run(user.id, ids[0], ids[1], ids[2], combined, pred);
  ids.forEach(id => db.prepare('INSERT OR IGNORE INTO scores (golfer_id) VALUES (?)').run(id));
  res.redirect('/my-entry');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES — ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/admin',           (req, res) => { if (req.session.isAdmin) return res.redirect('/admin/dashboard'); res.send(adminLoginPage()); });
app.get('/admin/dashboard', requireAdmin, (req, res) => res.send(adminDashboardPage()));
app.get('/admin/users',     requireAdmin, (req, res) => res.send(adminUsersPage()));
app.get('/admin/entries',   requireAdmin, (req, res) => res.send(adminEntriesPage()));
app.get('/admin/scores',    requireAdmin, (req, res) => res.send(adminScoresPage()));
app.get('/admin/leaderboard', requireAdmin, (req, res) => res.send(adminLeaderboardPage()));
app.get('/admin/logout',    (req, res) => { req.session.isAdmin = false; res.redirect('/admin'); });

app.post('/admin', async (req, res) => {
  const ok = await bcrypt.compare(req.body.password, getSetting('admin_password'));
  if (!ok) return res.send(adminLoginPage('Incorrect password.'));
  req.session.isAdmin = true;
  res.redirect('/admin/dashboard');
});

app.post('/admin/toggle-paid', requireAdmin, (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id=?').get(parseInt(req.body.entry_id));
  if (entry) db.prepare('UPDATE entries SET is_paid=? WHERE id=?').run(entry.is_paid ? 0 : 1, entry.id);
  res.redirect(req.headers.referer || '/admin/entries');
});

app.post('/admin/entry-notes', requireAdmin, (req, res) => {
  db.prepare('UPDATE entries SET notes=? WHERE id=?').run(req.body.notes || '', parseInt(req.body.entry_id));
  res.redirect('/admin/entries');
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const { tournament_par, winning_score, entries_open } = req.body;
  if (tournament_par) setSetting('tournament_par', tournament_par);
  if (winning_score !== undefined) setSetting('winning_score', winning_score);
  if (entries_open)  setSetting('entries_open', entries_open);
  res.send(adminDashboardPage('Settings saved.'));
});

app.post('/admin/lock-odds', requireAdmin, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM golfers WHERE is_active=1').get().c;
  if (count === 0) return res.send(adminDashboardPage('', 'No golfers loaded.'));
  setSetting('odds_locked', '1');
  res.send(adminDashboardPage(`Field locked. ${count} golfers confirmed.`));
});

app.post('/admin/import-odds', requireAdmin, (req, res) => {
  if (getSetting('odds_locked') === '1') return res.send(adminDashboardPage('', 'Field is locked.'));
  try {
    const data = JSON.parse(req.body.json_data);
    if (!Array.isArray(data) || data.length === 0) throw new Error('Expected a JSON array');
    db.prepare('DELETE FROM golfers').run();
    const ins = db.prepare('INSERT INTO golfers (name, odds_display, odds_numerator, odds_denominator, odds_value) VALUES (?,?,?,?,?)');
    let count = 0;
    db.transaction(rows => { for (const r of rows) { const p = parseOdds(r.odds); if (p && r.name) { ins.run(r.name.trim(), p.display, p.numerator, p.denominator, p.value); count++; } } })(data);
    res.send(adminDashboardPage(`Imported ${count} golfers.`));
  } catch(e) { res.send(adminDashboardPage('', `Import failed: ${e.message}`)); }
});

app.post('/admin/scraper-toggle', requireAdmin, (req, res) => {
  setSetting('scraper_active', getSetting('scraper_active') === '1' ? '0' : '1');
  res.redirect('/admin/dashboard');
});

app.post('/admin/scraper-run', requireAdmin, async (req, res) => {
  try { await scrapeLiveScores(); res.send(adminDashboardPage('Manual scrape completed.')); }
  catch(e) { res.send(adminDashboardPage('', `Scrape failed: ${e.message}`)); }
});

app.post('/admin/scores', requireAdmin, (req, res) => {
  const golfers = db.prepare('SELECT id FROM golfers WHERE is_active=1').all();
  const upsert = db.prepare(`INSERT INTO scores (golfer_id, round1, round2, round3, round4, status, manual_override, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(golfer_id) DO UPDATE SET
      round1=excluded.round1, round2=excluded.round2, round3=excluded.round3, round4=excluded.round4,
      status=excluded.status, manual_override=excluded.manual_override, updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const g of golfers) {
      const id = g.id;
      const pr = v => { const n = parseInt(v); return (isNaN(n) || v === '' || v === undefined) ? null : n; };
      upsert.run(id,
        pr(req.body[`r_${id}_round1`]), pr(req.body[`r_${id}_round2`]),
        pr(req.body[`r_${id}_round3`]), pr(req.body[`r_${id}_round4`]),
        req.body[`status_${id}`] || 'active',
        req.body[`override_${id}`] ? 1 : 0
      );
    }
  })();
  res.send(adminScoresPage('Scores saved.'));
});

app.use((req, res) => res.status(404).send(layout('Not Found', `<div class="container" style="padding:4rem 1rem;text-align:center"><h1>404</h1><p>Page not found.</p><a href="/" class="btn btn-gold">Go Home</a></div>`)));

// ═══════════════════════════════════════════════════════════════════════════════
//  SCRAPER — ESPN API
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapeLiveScores() {
  const url  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
  const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const events = resp.data?.events;
  if (!events?.length) { setSetting('scraper_last_run', new Date().toISOString()); return; }

  const event = events.find(e => /rbc heritage|heritage/i.test(e.name)) || events[0];
  const competition = event?.competitions?.[0];
  if (!competition) return;

  const par = getPar();
  const upsert = db.prepare(`INSERT INTO scores (golfer_id, round1, round2, round3, round4, status, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(golfer_id) DO UPDATE SET
      round1 = CASE WHEN manual_override=1 THEN round1 ELSE excluded.round1 END,
      round2 = CASE WHEN manual_override=1 THEN round2 ELSE excluded.round2 END,
      round3 = CASE WHEN manual_override=1 THEN round3 ELSE excluded.round3 END,
      round4 = CASE WHEN manual_override=1 THEN round4 ELSE excluded.round4 END,
      status = CASE WHEN manual_override=1 THEN status ELSE excluded.status END,
      updated_at = excluded.updated_at`);

  let updated = 0;
  db.transaction(() => {
    for (const comp of (competition.competitors || [])) {
      const name = comp.athlete?.displayName;
      if (!name) continue;
      const golfer = db.prepare("SELECT id FROM golfers WHERE lower(name) LIKE lower('%'||?||'%') OR lower(?) LIKE lower('%'||name||'%')").get(name, name);
      if (!golfer) continue;
      const lines = comp.linescores || [];
      const rounds = [null, null, null, null];
      lines.forEach((ls, i) => { if (i < 4 && ls.value != null) rounds[i] = parseInt(ls.value) || null; });
      let st = 'active';
      if (/cut/i.test(comp.status?.type?.name || '')) st = 'missed_cut';
      else if (/withdraw/i.test(comp.status?.type?.name || '')) st = 'withdrawn';
      else if (/disq/i.test(comp.status?.type?.name || '')) st = 'disqualified';
      else if (rounds[0] && rounds[1]) st = 'made_cut';
      upsert.run(golfer.id, rounds[0], rounds[1], rounds[2], rounds[3], st);
      updated++;
    }
  })();
  setSetting('scraper_last_run', new Date().toISOString());
  console.log(`[Scraper] Updated ${updated} golfers at ${new Date().toLocaleTimeString()}`);
}

cron.schedule('*/5 * * * *', async () => {
  if (getSetting('scraper_active') !== '1') return;
  try { await scrapeLiveScores(); } catch(e) { console.error('[Scraper] Error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT & START
// ═══════════════════════════════════════════════════════════════════════════════

seedField(); // load Paddy Power odds snapshot on first run

app.listen(PORT, () => {
  console.log(`\n⛳  RBC Heritage 2026 Sweepstake`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Admin: http://localhost:${PORT}/admin  (password: 0874021075)`);
  console.log(`    Entry deadline: ${ENTRY_DEADLINE.toLocaleString('en-IE', { timeZone: 'Europe/Dublin' })} Irish time\n`);
});
