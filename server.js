'use strict';
// Block Arena server. One file, functions only.
// Serves the web client and runs the game over WebSocket.
// Usage:  node server.js [mode]   mode = rotate (default) | ffa | tdm | hp | ctf | kc | gg | inf | lms
// env: PORT (default 8080), MAP (name or number, locks the map), LIMIT (score limit), TIME (seconds)
// The host (the player on the same PC as the server) can change mode, map, limit, time and the IP whitelist in the game menu.
// All settings are saved in settings.json next to this file (env SETTINGS=path to move it, SETTINGS=off to disable).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.css': 'text/css; charset=utf-8',
};

let MAX_PLAYERS = 12;
const MAX_HP = 100;
const FAST = !!process.env.FAST;               // test helper: short respawn / restart timers
const RESPAWN_MS = FAST ? 300 : 3000;
const RESTART_MS = FAST ? 1500 : 9000;
const TICK_MS = 50;
let HEAD_MULT = 1.5;                          // headshot damage multiplier (settings.json: headshotMultiplier)
const EYE = 1.6;
const EYE_C = 1.05;
const REGEN_DELAY = 5000;
const REGEN_RATE = 30;
const ZONE_MS = Number(process.env.ZONE_MS) || (FAST ? 4000 : 45000);   // hardpoint zone moves this often
const FLAG_RETURN_MS = 25000;
const TAG_LIFE_MS = 15000;
const ROUND_MS = FAST ? 20000 : 120000;        // last man standing round length

// ---- game modes ----
const MODES = {
  ffa: { name: 'FREE FOR ALL', teams: false, limit: 20, time: 600, desc: 'Everyone for themselves. First to the kill limit wins.' },
  tdm: { name: 'TEAM DEATHMATCH', teams: true, limit: 30, time: 600, desc: 'Red vs blue. First team to the kill limit wins.' },
  hp:  { name: 'HARDPOINT', teams: true, limit: 120, time: 600, desc: 'Stand in the glowing zone to score one point a second. It jumps every 45 seconds. A contested zone scores nothing.' },
  ctf: { name: 'CAPTURE THE FLAG', teams: true, limit: 3, time: 600, desc: 'Grab the enemy flag and bring it to your base. Your own flag must be home to score.' },
  kc:  { name: 'KILL CONFIRMED', teams: true, limit: 40, time: 600, desc: 'Kills drop dog tags. Collect enemy tags to score. Collect your own side\'s tags to deny them.' },
  gg:  { name: 'GUN GAME', teams: false, limit: 8, time: 600, desc: 'Every kill gives you the next gun. First to get a kill with the last gun wins. The limit sets how many levels.' },
  inf: { name: 'INFECTED', teams: true, limit: 0, time: 240, desc: 'One player starts infected with claws. Survivors who die join the infected. Survivors win if the time runs out.' },
  lms: { name: 'LAST MAN STANDING', teams: false, limit: 3, time: 900, desc: 'One life per round. The last player alive wins the round. First to the round limit wins.' },
};
const MODE_ORDER = ['ffa', 'tdm', 'hp', 'ctf', 'kc', 'gg', 'inf', 'lms'];
const LADDER = ['pistol', 'revolver', 'smg', 'shotgun', 'rifle', 'lmg', 'marksman', 'sniper'];

const WEAPONS = {
  rifle:    { label: 'Assault Rifle', damage: 22,  rate: 0.10,  mag: 30, reload: 1.6, spread: 0.015, pellets: 1, auto: true,  zoom: 60, ads: 0.15, rs: 35,  re: 85,  dmin: 0.6,  recoil: 0.006 },
  smg:      { label: 'SMG',           damage: 14,  rate: 0.06,  mag: 40, reload: 1.5, spread: 0.030, pellets: 1, auto: true,  zoom: 70, ads: 0.25, rs: 18,  re: 45,  dmin: 0.5,  recoil: 0.004 },
  sniper:   { label: 'Sniper',        damage: 80,  rate: 1.10,  mag: 3,  reload: 2.2, spread: 0.070, pellets: 1, auto: false, zoom: 18, ads: 0.0,  rs: 300, re: 400, dmin: 1,    recoil: 0.04, scope: true },
  shotgun:  { label: 'Shotgun',       damage: 12,  rate: 0.85,  mag: 6,  reload: 2.4, spread: 0.060, pellets: 9, auto: false, zoom: 62, ads: 0.7,  rs: 6,   re: 22,  dmin: 0.15, recoil: 0.03 },
  lmg:      { label: 'LMG',           damage: 20,  rate: 0.085, mag: 60, reload: 3.2, spread: 0.035, pellets: 1, auto: true,  zoom: 62, ads: 0.3,  rs: 30,  re: 70,  dmin: 0.6,  recoil: 0.005 },
  marksman: { label: 'Marksman',      damage: 45,  rate: 0.28,  mag: 10, reload: 1.8, spread: 0.020, pellets: 1, auto: false, zoom: 40, ads: 0.1,  rs: 50,  re: 110, dmin: 0.7,  recoil: 0.012 },
  pistol:   { label: 'Pistol',        damage: 20,  rate: 0.22,  mag: 12, reload: 1.1, spread: 0.012, pellets: 1, auto: false, zoom: 62, ads: 0.3,  rs: 25,  re: 60,  dmin: 0.6,  recoil: 0.01 },
  claws:    { label: 'Claws',         damage: 50,  rate: 0.45,  mag: 999, reload: 0, spread: 0.0, pellets: 1, auto: true,  zoom: 62, ads: 1,    rs: 2.5, re: 3.2, dmin: 0,    recoil: 0.01, range: 3.2, melee: true },
  revolver: { label: 'Revolver',      damage: 55,  rate: 0.55,  mag: 6,  reload: 2.0, spread: 0.010, pellets: 1, auto: false, zoom: 58, ads: 0.3,  rs: 25,  re: 60,  dmin: 0.6,  recoil: 0.02 },
};

const CLASSES = [
  { name: 'Assault',  ls: ['rifle', 'pistol'],     speed: 1.0 },
  { name: 'Rusher',   ls: ['smg', 'pistol'],       speed: 1.08 },
  { name: 'Hunter',   ls: ['sniper', 'revolver'],  speed: 1.0 },
  { name: 'Breacher', ls: ['shotgun', 'revolver'], speed: 1.02 },
  { name: 'Gunner',   ls: ['lmg', 'pistol'],       speed: 0.9 },
  { name: 'Marksman', ls: ['marksman', 'revolver'], speed: 1.0 },
];

// ====================================================================
// Maps (boxes only). Single source of truth, sent to clients.
// ====================================================================
const MAPS = [];

function mk(name, half, theme) {
  const m = { name, half, theme, boxes: [], spawns: [], teamSpawns: null, pub: null };
  MAPS.push(m);
  return m;
}
function bx(m, x, z, w, h, d, col, kind, y0) {
  const b = y0 || 0;
  m.boxes.push({ c: [x, b + h / 2, z], s: [w, h, d], col, k: kind || 'wall' });
}
function shell(m, floorCol, wallCol, wallH) {
  const h = m.half, wh = wallH || 8, L = h * 2 + 4;
  m.boxes.push({ c: [0, -0.5, 0], s: [L, 1, L], col: floorCol, k: 'floor' });
  m.boxes.push({ c: [0, wh / 2, -(h + 1)], s: [L, wh, 2], col: wallCol, k: 'wall' });
  m.boxes.push({ c: [0, wh / 2, h + 1], s: [L, wh, 2], col: wallCol, k: 'wall' });
  m.boxes.push({ c: [-(h + 1), wh / 2, 0], s: [2, wh, L], col: wallCol, k: 'wall' });
  m.boxes.push({ c: [h + 1, wh / 2, 0], s: [2, wh, L], col: wallCol, k: 'wall' });
}
// n steps rising in direction dir ('px','nx','pz','nz'), starting at edge point (x,z)
function stairs(m, x, z, dir, n, w, col, sh, sd) {
  const dx = dir === 'px' ? 1 : dir === 'nx' ? -1 : 0;
  const dz = dir === 'pz' ? 1 : dir === 'nz' ? -1 : 0;
  for (let i = 0; i < n; i++) {
    const off = i * sd + sd / 2, h = (i + 1) * sh;
    const sx = dx ? sd : w, sz = dx ? w : sd;
    m.boxes.push({ c: [x + dx * off, h / 2, z + dz * off], s: [sx, h, sz], col, k: 'crate' });
  }
}
function sp(list) { return list.map((p) => [p[0], 0.1, p[1]]); }

function buildMaps() {
  // ---- 1. Arena ----
  let m = mk('Arena', 41, { fog: [0.82, 0.9, 0.97], sky: [1, 1, 1], amb: 1, sunK: 1 });
  shell(m, '#9fb59a', '#7d8aa0', 8);
  bx(m, 0, 0, 8, 3, 8, '#e0b84a');
  stairs(m, 10, 0, 'nx', 6, 5, '#e88a3a', 0.5, 1);
  bx(m, -20, -15, 6, 2, 6, '#4f9fd8'); bx(m, 20, 15, 6, 2, 6, '#d85a68');
  bx(m, -20, 15, 4, 4, 4, '#8a6fd8'); bx(m, 20, -15, 4, 4, 4, '#5fbf80');
  bx(m, 0, -22, 20, 3, 2, '#9aa0aa'); bx(m, 0, 22, 20, 3, 2, '#9aa0aa');
  bx(m, -30, 0, 2, 3, 16, '#9aa0aa'); bx(m, 30, 0, 2, 3, 16, '#9aa0aa');
  for (const c of [[-10, 8, 2, 1.2], [10, -8, 2, 1.2], [12, 10, 3, 1.5], [-12, -10, 3, 1.5], [0, 14, 2, 1], [0, -14, 2, 1]]) {
    bx(m, c[0], c[1], c[2], c[3], c[2], '#d09a50', 'crate');
  }
  m.spawns = sp([[-34, -34], [34, -34], [-34, 34], [34, 34], [0, -36], [0, 36], [-36, 0], [36, 0]]);

  // ---- 2. Warehouse (indoor, catwalks) ----
  m = mk('Warehouse', 30, { fog: [0.5, 0.53, 0.6], sky: [0.5, 0.55, 0.7], amb: 0.95, sunK: 0.8 });
  shell(m, '#8a8f94', '#6f7b8c', 9);
  bx(m, 0, 0, 64, 1, 64, '#59606c', 'ceil', 9);
  for (const s of [[-12, -18], [12, -18], [-12, 18], [12, 18], [-12, 0], [12, 0]]) bx(m, s[0], s[1], 14, 2.6, 1.4, '#c9862f', 'crate');
  for (const c of [[-24, -10], [24, 10], [-24, 10], [24, -10]]) bx(m, c[0], c[1], 3, 3, 3, '#d09a50', 'crate');
  bx(m, 0, -9, 2, 1.2, 2, '#d09a50', 'crate'); bx(m, 0, 9, 2, 1.2, 2, '#d09a50', 'crate');
  bx(m, -26, 0, 4, 0.4, 44, '#555d6b', 'wall', 3.2); bx(m, 26, 0, 4, 0.4, 44, '#555d6b', 'wall', 3.2);
  stairs(m, -26, 29, 'nz', 8, 3, '#d09a50', 0.45, 1);
  stairs(m, 26, -29, 'pz', 8, 3, '#d09a50', 0.45, 1);
  m.spawns = sp([[-20, -27], [20, -27], [-20, 27], [20, 27], [0, -27], [0, 27], [-28, -3], [28, 3]]);

  // ---- 3. Fortress (team bases, bridge) ----
  m = mk('Fortress', 45, { fog: [0.78, 0.88, 1.0], sky: [1, 1, 1], amb: 1.05, sunK: 1 });
  shell(m, '#8fb08a', '#8890a0', 8);
  for (const s of [-1, 1]) {
    const col = s < 0 ? '#d85a5a' : '#5a8ad8';
    bx(m, -13, s * 28, 18, 4.5, 1.5, col); bx(m, 13, s * 28, 18, 4.5, 1.5, col);
    bx(m, -22.5, s * 36, 1.5, 4.5, 16, col); bx(m, 22.5, s * 36, 1.5, 4.5, 16, col);
    bx(m, -18, s * 40, 5, 4, 5, col); bx(m, 18, s * 40, 5, 4, 5, col);
    stairs(m, -9, s * 40, 'nx', 8, 3, '#d09a50', 0.5, 0.8);
    stairs(m, 9, s * 40, 'px', 8, 3, '#d09a50', 0.5, 0.8);
  }
  bx(m, 0, 0, 30, 0.5, 6, '#c9c9d6', 'wall', 4);
  stairs(m, -24, 0, 'px', 9, 5, '#d09a50', 0.5, 1);
  stairs(m, 24, 0, 'nx', 9, 5, '#d09a50', 0.5, 1);
  for (const c of [[-8, -10], [8, 10], [-8, 10], [8, -10]]) bx(m, c[0], c[1], 3, 1.5, 3, '#d09a50', 'crate');
  bx(m, -32, 0, 2, 3, 12, '#9aa0aa'); bx(m, 32, 0, 2, 3, 12, '#9aa0aa');
  const red = sp([[-8, -35], [0, -38], [8, -35], [-12, -33], [12, -33]]);
  const blue = sp([[-8, 35], [0, 38], [8, 35], [-12, 33], [12, 33]]);
  m.teamSpawns = [red, blue];
  m.spawns = red.concat(blue);

  // ---- 4. Canyon (sunset) ----
  m = mk('Canyon', 50, { fog: [0.98, 0.78, 0.6], sky: [1.0, 0.72, 0.55], amb: 1.0, sunK: 1.15 });
  shell(m, '#d9b384', '#a86a45', 10);
  bx(m, -18, -10, 4, 7, 34, '#b5654a'); bx(m, 18, 10, 4, 7, 34, '#b5654a');
  bx(m, 0, -34, 26, 5, 4, '#c47a55'); bx(m, 0, 34, 26, 5, 4, '#c47a55');
  for (const p of [[0, 0], [-9, -22], [9, 22], [-38, -6], [38, 6], [-30, 4], [30, -4]]) bx(m, p[0], p[1], 3, 9, 3, '#c47a55');
  bx(m, -32, 28, 14, 2.5, 14, '#b5654a'); stairs(m, -20, 28, 'nx', 5, 4, '#d9b384', 0.5, 1);
  bx(m, 32, -28, 14, 2.5, 14, '#b5654a'); stairs(m, 20, -28, 'px', 5, 4, '#d9b384', 0.5, 1);
  for (const c of [[-8, 12], [8, -12], [22, -5], [-22, 5], [12, 28], [-12, -28]]) bx(m, c[0], c[1], 3, 1.5, 3, '#d9a066', 'crate');
  m.spawns = sp([[-44, -44], [44, -44], [-44, 44], [44, 44], [0, -46], [0, 46], [-46, 0], [46, 0]]);

  // ---- 5. Skyblocks (night, platforms) ----
  m = mk('Skyblocks', 36, { fog: [0.1, 0.12, 0.25], sky: [0.14, 0.17, 0.4], amb: 0.8, sunK: 0.35 });
  shell(m, '#2c3350', '#3a4468', 12);
  bx(m, 0, 0, 10, 3, 10, '#27d7e8'); stairs(m, 10, 0, 'nx', 6, 4, '#8be04f', 0.5, 1);
  stairs(m, -10, 0, 'px', 6, 4, '#8be04f', 0.5, 1);
  for (const p of [[-22, -22], [22, -22], [-22, 22], [22, 22]]) {
    bx(m, p[0], p[1], 9, 0.6, 9, '#e04fd0', 'wall', 4.5);
    stairs(m, p[0] < 0 ? -8 : 8, p[1], p[0] < 0 ? 'nx' : 'px', 10, 3.5, '#f0993a', 0.51, 0.95);
  }
  bx(m, -22, 0, 3, 0.4, 35, '#e04fd0', 'wall', 4.7); bx(m, 22, 0, 3, 0.4, 35, '#e04fd0', 'wall', 4.7);
  for (const c of [[0, -14], [0, 14], [-12, 8], [12, -8]]) bx(m, c[0], c[1], 2.5, 1.5, 2.5, '#f0993a', 'crate');
  m.spawns = sp([[-31, -31], [31, -31], [-31, 31], [31, 31], [0, -31], [0, 31], [-31, 0], [31, 0]]);

  for (const mm of MAPS) {
    for (const b of mm.boxes) {
      b.mn = [b.c[0] - b.s[0] / 2, b.c[1] - b.s[1] / 2, b.c[2] - b.s[2] / 2];
      b.mx = [b.c[0] + b.s[0] / 2, b.c[1] + b.s[1] / 2, b.c[2] + b.s[2] / 2];
    }
    mm.pub = { name: mm.name, half: mm.half, theme: mm.theme, boxes: mm.boxes.map((b) => ({ c: b.c, s: b.s, col: b.col, k: b.k })) };
  }
}


// capture-the-flag bases and hardpoint zones per map: zones are [x, z, ground y, radius]
const OBJECTIVES = {
  Arena:     { bases: [[0, -35], [0, 35]], zones: [[0, -10, 0, 4], [-26, 8, 0, 4], [26, -8, 0, 4], [0, 28, 0, 4]] },
  Warehouse: { bases: [[0, -24], [0, 24]], zones: [[0, 0, 0, 4], [0, -15, 0, 4], [0, 15, 0, 4]] },
  Fortress:  { bases: [[0, -38], [0, 38]], zones: [[0, 0, 0, 5], [-20, 12, 0, 4], [20, -12, 0, 4], [0, -20, 0, 4], [0, 20, 0, 4]] },
  Canyon:    { bases: [[0, -43], [0, 43]], zones: [[6, 0, 0, 4], [-24, -10, 0, 4], [24, 10, 0, 4], [0, -20, 0, 4]] },
  Skyblocks: { bases: [[0, -27], [0, 27]], zones: [[0, 0, 3, 4], [-12, -12, 0, 4], [12, 12, 0, 4], [0, -26, 0, 4]] },
};

function finishMaps() {
  for (const m of MAPS) {
    const o = OBJECTIVES[m.name];
    m.bases = o.bases;
    m.zones = o.zones;
    if (m.teamSpawns) {
      m.sideSpawns = m.teamSpawns;
    } else {
      const byZ = m.spawns.slice().sort((a, b) => a[2] - b[2]);
      const h = byZ.length / 2;
      m.sideSpawns = [byZ.slice(0, h), byZ.slice(h)];
    }
  }
}

// ====================================================================
// State + helpers
// ====================================================================
const state = {
  mode: 'ffa', players: new Map(), nextId: 1, scores: [0, 0], over: false, mapIdx: 0, map: null,
  cfg: { mode: 'rotate', map: 'rotate', limit: 0, time: 0 },   // what the host picked
  limit: 20, time: 600, endAt: 0, lastSec: 0, hostId: 0,
  round: null, zone: null, zoneIdx: 0, flags: [null, null], tags: [], nextTag: 1,
  restartTimer: null, roundTimer: null,
};

function r2(v) { return Math.round(v * 100) / 100; }
function num(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of state.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
function say(text) { broadcast({ t: 'say', text }); }
function cleanName(n) {
  const s = String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 12);
  return s || 'Player' + Math.floor(100 + Math.random() * 900);
}
function isLoopback(a) { return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function eyeOf(p) { return p.crouch ? EYE_C : EYE; }
function modeDef() { return MODES[state.mode]; }
function teamMode() { return modeDef().teams; }
function sameTeam(a, b) { return teamMode() && a.team >= 0 && a.team === b.team; }
function teamName(t) {
  if (state.mode === 'inf') return t === 0 ? 'SURVIVORS' : 'INFECTED';
  return t === 0 ? 'RED' : 'BLUE';
}
function countTeams() {
  const c = [0, 0];
  for (const p of state.players.values()) if (p.team === 0 || p.team === 1) c[p.team]++;
  return c;
}
function leftSec() { return Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000)); }

function extraOf(p) {
  switch (state.mode) {
    case 'gg': return 'Lv ' + (p.level + 1);
    case 'ctf': return 'Caps ' + p.caps;
    case 'kc': return 'Conf ' + p.confs;
    case 'lms': return 'Wins ' + p.wins;
    default: return '';
  }
}
function sendEx(p) { broadcast({ t: 'ex', id: p.id, ex: extraOf(p) }); }

function info(p) {
  return { id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, alive: p.alive,
    p: [r2(p.x), r2(p.y), r2(p.z)], yaw: r2(p.yaw), ex: extraOf(p) };
}
function sendMe(p) {
  p.lastMe = Date.now();
  send(p.ws, { t: 'me', hp: Math.round(p.hp), max: p.maxHp, spd: p.speedMul, w: p.weapon, ammo: p.ammo, rld: p.reloading,
    ls: p.loadout, cls: p.curCls, lvl: p.level });
}

function objState() {
  const z = state.zone;
  return {
    zone: z ? [z.x, z.y, z.z, z.r, z.holder, Math.max(0, z.moveAt - Date.now())] : null,
    flags: state.flags.map((f) => (f ? [f.s, f.c, f.x, f.y, f.z] : null)),
    tags: state.tags.map((t) => [t.id, t.x, t.y, t.z, t.team]),
    round: state.round ? state.round.n : 0,
    bases: state.mode === 'ctf' ? state.map.bases : null,
  };
}
function matchInfo() {
  return { mode: state.mode, name: modeDef().name, limit: state.limit, left: leftSec(), scores: state.scores,
    map: state.map.pub, cfg: state.cfg, obj: objState() };
}

// ====================================================================
// Settings file (shared by all players) + IP whitelist
// ====================================================================
const SETTINGS_ENV = process.env.SETTINGS || '';
const SETTINGS_FILE = SETTINGS_ENV && SETTINGS_ENV !== 'off' ? path.resolve(SETTINGS_ENV) : path.join(__dirname, 'settings.json');
const SETTINGS_ON = SETTINGS_ENV !== 'off';
const wl = { enabled: false, ips: [] };     // whitelist: your own PC (loopback) is always allowed

function normIp(a) {
  a = String(a || '').trim();
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

// accepts 1.2.3.4, 1.2.3.0/24 or an IPv6 address; returns the cleaned entry or null
function parseEntry(raw) {
  const t = normIp(raw);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(t);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    const bits = m[5] === undefined ? 32 : Number(m[5]);
    if (o.some((x) => x > 255) || bits > 32) return null;
    return o.join('.') + (bits === 32 ? '' : '/' + bits);
  }
  if (t.includes(':') && /^[0-9a-f:]+$/i.test(t) && t.length <= 45) return t.toLowerCase();
  return null;
}
function ipInt(ip) {
  const o = ip.split('.').map(Number);
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
function wlMatch(ip, e) {
  if (!e.includes('/')) return ip.toLowerCase() === e;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = e.split('/');
  const bits = Number(parts[1]);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipInt(ip) & mask) >>> 0) === ((ipInt(parts[0]) & mask) >>> 0);
}
function isAllowed(addr) {
  if (isLoopback(addr) || !wl.enabled) return true;
  const ip = normIp(addr);
  return wl.ips.some((e) => wlMatch(ip, e));
}
function wlInfo() {
  return { enabled: wl.enabled, ips: wl.ips,
    players: Array.from(state.players.values()).map((p) => ({ id: p.id, name: p.name, ip: p.ip, loop: p.loop })) };
}
function sendWlInfo() {
  const h = state.players.get(state.hostId);
  if (h) send(h.ws, Object.assign({ t: 'wlinfo' }, wlInfo()));
}
function kickDisallowed() {
  if (!state.wss) return;
  for (const ws of state.wss.clients) {
    if (ws.ip && !isAllowed(ws.ip)) { try { ws.close(1008, 'not on the whitelist'); } catch (e) { /* ignore */ } setTimeout(() => ws.terminate(), 500); }
  }
}
// op: enable (on) | add (ip) | remove (ip)
function wlCommand(c) {
  if (c.op === 'enable') {
    const on = !!c.on;
    if (on && !wl.enabled) {          // switching it on must not throw out the people who are playing right now
      for (const p of state.players.values()) {
        const e = p.loop ? null : parseEntry(p.ip);
        if (e && !wl.ips.includes(e) && wl.ips.length < 200) wl.ips.push(e);
      }
    }
    wl.enabled = on;
  } else if (c.op === 'add') {
    const e = parseEntry(c.ip);
    if (e && !wl.ips.includes(e) && wl.ips.length < 200) wl.ips.push(e);
  } else if (c.op === 'remove') {
    wl.ips = wl.ips.filter((x) => x !== c.ip);
  }
  saveSettings();
  kickDisallowed();
  sendWlInfo();
}

function settingsSnapshot() {
  const weapons = {};
  for (const [k, w] of Object.entries(WEAPONS)) weapons[k] = { damage: w.damage, rate: w.rate, mag: w.mag, reload: w.reload, spread: w.spread };
  return {
    _help: 'Edit this file while the server is stopped. It applies to everybody on the server. host = mode/map/limit/time the host chose '
      + '(mode: rotate, ffa, tdm, hp, ctf, kc, gg, inf, lms). whitelist.ips takes 1.2.3.4 or 1.2.3.0/24. The PC running the server is always allowed.',
    headshotMultiplier: HEAD_MULT,
    maxPlayers: MAX_PLAYERS,
    weapons,
    host: { mode: state.cfg.mode, map: state.cfg.map, limit: state.cfg.limit, time: state.cfg.time },
    whitelist: { enabled: wl.enabled, ips: wl.ips },
  };
}

let saveWarned = false;
function saveSettings() {
  if (!SETTINGS_ON) return;
  try {
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settingsSnapshot(), null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    if (!saveWarned) { console.warn('Could not save settings: ' + e.message); saveWarned = true; }
  }
}

function loadSettings() {
  if (!SETTINGS_ON) return;
  let o = null;
  try {
    o = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('settings.json ignored (' + e.message + '). Using defaults.');
    return;
  }
  if (!o || typeof o !== 'object') return;
  if (num(o.headshotMultiplier, 1, 10)) HEAD_MULT = o.headshotMultiplier;
  if (Number.isInteger(o.maxPlayers) && o.maxPlayers >= 2 && o.maxPlayers <= 32) MAX_PLAYERS = o.maxPlayers;
  for (const k of Object.keys(o.weapons || {})) {
    if (!WEAPONS[k] || !o.weapons[k]) continue;
    for (const f of Object.keys(o.weapons[k])) {
      const v = o.weapons[k][f];
      if (typeof WEAPONS[k][f] === 'number' && num(v, 0, 1000) && !(f === 'rate' && v < 0.02)) WEAPONS[k][f] = v;
    }
  }
  const h = o.host;
  if (h && typeof h === 'object') {
    if (h.mode === 'rotate' || MODES[h.mode]) state.cfg.mode = h.mode;
    if (h.map === 'rotate' || MAPS.some((m) => m.name === h.map)) state.cfg.map = h.map;
    if (num(h.limit, 0, 9999)) state.cfg.limit = Math.floor(h.limit);
    if (num(h.time, 0, 3600)) state.cfg.time = Math.floor(h.time);
  }
  const w = o.whitelist;
  if (w && typeof w === 'object') {
    wl.enabled = !!w.enabled;
    wl.ips = (Array.isArray(w.ips) ? w.ips : []).map(parseEntry).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 200);
  }
}

// ====================================================================
// Ray tests
// ====================================================================
function rayAABB(o, d, mn, mx) {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return -1;
      continue;
    }
    let a = (mn[i] - o[i]) / d[i];
    let b = (mx[i] - o[i]) / d[i];
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}

function fireRay(p, d, maxT) {
  const o = [p.x, p.y + eyeOf(p), p.z];
  let tBest = maxT;
  for (const b of state.map.boxes) {
    const t = rayAABB(o, d, b.mn, b.mx);
    if (t >= 0 && t < tBest) tBest = t;
  }
  let hit = null;
  for (const q of state.players.values()) {
    if (q === p || !q.alive || sameTeam(p, q)) continue;
    const top = q.crouch ? 0.9 : 1.4;
    const tb = rayAABB(o, d, [q.x - 0.4, q.y, q.z - 0.4], [q.x + 0.4, q.y + top, q.z + 0.4]);
    const th = rayAABB(o, d, [q.x - 0.25, q.y + top, q.z - 0.25], [q.x + 0.25, q.y + top + 0.45, q.z + 0.25]);
    if (th >= 0 && th < tBest) { tBest = th; hit = { q, head: true }; }
    if (tb >= 0 && tb < tBest) { tBest = tb; hit = { q, head: false }; }
  }
  return { o, t: tBest, hit, dir: d };
}

// ====================================================================
// Players
// ====================================================================
function spawnList(p) {
  const m = state.map;
  if (teamMode() && p.team >= 0) {
    if (state.mode === 'ctf' || state.mode === 'hp') return m.sideSpawns[p.team];
    if (state.mode === 'tdm' && m.teamSpawns) return m.teamSpawns[p.team];
  }
  return m.spawns;
}

function pickSpawn(p) {
  const list = spawnList(p);
  let best = list[0];
  let bestD = -1;
  for (const s of list) {
    let d = 9999;
    for (const q of state.players.values()) {
      if (q === p || !q.alive || sameTeam(p, q)) continue;
      d = Math.min(d, Math.hypot(s[0] - q.x, s[2] - q.z));
    }
    d += Math.random() * 6;
    if (d > bestD) { bestD = d; best = s; }
  }
  return best;
}

function resetAmmo(p) {
  p.ammo = {};
  for (const k of p.loadout) p.ammo[k] = WEAPONS[k].mag;
}

function cancelReload(p) {
  if (p.reloadTimer) clearTimeout(p.reloadTimer);
  p.reloadTimer = null;
  p.reloading = false;
}

// guns, health and speed depend on the mode (gun game ladder, infected claws)
function applyLoadout(p) {
  const infected = state.mode === 'inf' && p.team === 1;
  if (state.mode === 'gg') p.loadout = [LADDER[Math.min(p.level, LADDER.length - 1)]];
  else if (infected) p.loadout = ['claws'];
  else p.loadout = CLASSES[p.cls].ls.slice();
  p.weapon = p.loadout[0];
  p.maxHp = infected ? 150 : MAX_HP;
  p.speedMul = CLASSES[p.cls].speed * (infected ? 1.2 : 1);
  p.curCls = p.cls;
  resetAmmo(p);
}

function spawnPlayer(p, force) {
  if (state.over || !state.players.has(p.id)) return;
  if (state.mode === 'lms' && !force) return;       // one life per round
  const s = pickSpawn(p);
  p.x = s[0]; p.y = s[1]; p.z = s[2];
  p.yaw = Math.atan2(s[0], s[2]);
  p.pitch = 0;
  p.crouch = false;
  p.alive = true;
  p.nextFire = 0;
  p.lastSt = Date.now();
  p.lastHit = 0;
  cancelReload(p);
  applyLoadout(p);
  p.hp = p.maxHp;
  broadcast({ t: 'spawn', id: p.id, p: [p.x, p.y, p.z], yaw: r2(p.yaw) });
  sendMe(p);
}

function joinTeam() {
  if (!teamMode()) return -1;
  const c = countTeams();
  if (state.mode === 'inf') return c[0] >= 1 ? 1 : 0;   // latecomers join the infected
  return c[0] <= c[1] ? 0 : 1;
}

function assignTeams() {
  const list = Array.from(state.players.values());
  if (!teamMode()) { for (const p of list) p.team = -1; return; }
  if (state.mode === 'inf') { for (const p of list) p.team = 0; return; }
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  list.forEach((p, i) => { p.team = i % 2; });
}

function electHost() {
  let best = null;
  for (const p of state.players.values()) if (p.loop && (!best || p.id < best.id)) best = p;   // the player on the server PC
  if (!best) {
    best = state.players.get(state.hostId) || null;
    if (!best) for (const p of state.players.values()) if (!best || p.id < best.id) best = p;
  }
  const id = best ? best.id : 0;
  if (id !== state.hostId) { state.hostId = id; broadcast({ t: 'host', id }); sendWlInfo(); }
}

function addPlayer(ws, m) {
  if (state.players.size >= MAX_PLAYERS) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }
  const cls = Number.isInteger(m.cls) && m.cls >= 0 && m.cls < CLASSES.length ? m.cls : 0;
  const p = {
    id: state.nextId++, ws, loop: !!ws.loop, ip: ws.ip || '', name: cleanName(m.name), team: joinTeam(), x: 0, y: -50, z: 0, yaw: 0, pitch: 0, crouch: false,
    hp: 0, maxHp: MAX_HP, speedMul: 1, alive: false, kills: 0, deaths: 0, level: 0, caps: 0, confs: 0, wins: 0,
    cls, curCls: cls, loadout: CLASSES[cls].ls.slice(), weapon: CLASSES[cls].ls[0],
    ammo: {}, nextFire: 0, reloading: false, reloadTimer: null, respawnTimer: null, lastSt: Date.now(),
    lastHit: 0, lastMe: 0, lastChat: 0,
  };
  resetAmmo(p);
  ws.player = p;
  state.players.set(p.id, p);
  electHost();
  send(ws, Object.assign({ t: 'welcome', id: p.id, over: state.over, host: state.hostId === p.id,
    players: Array.from(state.players.values()).filter((q) => q !== p).map(info) }, matchInfo()));
  broadcast({ t: 'join', p: info(p) });
  sendWlInfo();
  if (state.mode === 'lms') {
    if (!state.round.active || state.players.size <= 2) startRound();
    else send(ws, { t: 'say', text: 'Spectating until the next round' });
  } else {
    spawnPlayer(p);
  }
  infCheck();
}

function removePlayer(p) {
  cancelReload(p);
  if (p.respawnTimer) clearTimeout(p.respawnTimer);
  dropFlagIfCarrier(p);
  state.players.delete(p.id);
  broadcast({ t: 'leave', id: p.id });
  electHost();
  sendWlInfo();
  lmsCheck();
  infCheck();
}

// ====================================================================
// Mode logic
// ====================================================================
function initMode() {
  const now = Date.now();
  const m = state.map, mode = state.mode;
  state.limit = mode === 'inf' ? 0 : (state.cfg.limit > 0 ? state.cfg.limit : MODES[mode].limit);
  if (mode === 'gg') state.limit = Math.max(1, Math.min(LADDER.length, state.limit));
  state.time = state.cfg.time > 0 ? state.cfg.time : MODES[mode].time;
  state.endAt = now + state.time * 1000;
  state.lastSec = 0;
  state.tags = [];
  state.flags = [null, null];
  state.zone = null;
  state.round = null;
  if (mode === 'ctf') for (let t = 0; t < 2; t++) state.flags[t] = { s: 'home', c: -1, x: m.bases[t][0], y: 0, z: m.bases[t][1], dropAt: 0 };
  if (mode === 'hp') { state.zoneIdx = Math.floor(Math.random() * m.zones.length); setZone(now); }
  if (mode === 'lms') state.round = { n: 0, active: false, endAt: 0 };
}

// ---- hardpoint ----
function setZone(now) {
  const z = state.map.zones[state.zoneIdx % state.map.zones.length];
  state.zone = { x: z[0], z: z[1], y: z[2], r: z[3], holder: -1, moveAt: now + ZONE_MS };
}
function sendZone() {
  const z = state.zone;
  if (z) broadcast({ t: 'zone', z: [z.x, z.y, z.z, z.r, z.holder, Math.max(0, z.moveAt - Date.now())], sc: state.scores });
}
function inZone(p, z) { return Math.hypot(p.x - z.x, p.z - z.z) <= z.r && Math.abs(p.y - z.y) < 2.6; }
function tickHp(now, sec) {
  const z = state.zone;
  if (now >= z.moveAt) {
    state.zoneIdx = (state.zoneIdx + 1) % state.map.zones.length;
    setZone(now);
    sendZone();
    say('The zone has moved!');
  }
  if (!sec) return;
  const c = [0, 0];
  for (const p of state.players.values()) if (p.alive && p.team >= 0 && inZone(p, z)) c[p.team]++;
  let holder = -1;
  if (c[0] && c[1]) holder = 2;
  else if (c[0]) holder = 0;
  else if (c[1]) holder = 1;
  if (holder === 0 || holder === 1) state.scores[holder]++;
  z.holder = holder;
  sendZone();
  checkWin();
}

// ---- capture the flag ----
function sendFlags() { broadcast({ t: 'flags', f: state.flags.map((f) => [f.s, f.c, f.x, f.y, f.z]) }); }
function homeFlag(t) {
  const f = state.flags[t], b = state.map.bases[t];
  f.s = 'home'; f.c = -1; f.x = b[0]; f.y = 0; f.z = b[1];
}
function nearFlag(p, f, r) { return Math.hypot(p.x - f.x, p.z - f.z) <= r && Math.abs(p.y - f.y) < 2.5; }
function dropFlagIfCarrier(p) {
  if (state.mode !== 'ctf') return;
  let changed = false;
  for (let t = 0; t < 2; t++) {
    const f = state.flags[t];
    if (f && f.s === 'carried' && f.c === p.id) {
      f.s = 'dropped'; f.c = -1; f.x = p.x; f.y = p.y; f.z = p.z; f.dropAt = Date.now();
      changed = true;
      say(p.name + ' dropped the ' + teamName(t) + ' flag');
    }
  }
  if (changed) sendFlags();
}
function tickCtf(now) {
  let changed = false;
  for (const p of state.players.values()) {
    if (!p.alive || p.team < 0) continue;
    const own = state.flags[p.team], enemy = state.flags[1 - p.team];
    if (enemy.s !== 'carried' && nearFlag(p, enemy, 1.6)) {
      enemy.s = 'carried'; enemy.c = p.id; changed = true;
      say(p.name + ' took the ' + teamName(1 - p.team) + ' flag!');
    }
    if (own.s === 'dropped' && nearFlag(p, own, 1.6)) {
      homeFlag(p.team); changed = true;
      say(p.name + ' returned the ' + teamName(p.team) + ' flag');
    }
    if (enemy.s === 'carried' && enemy.c === p.id && own.s === 'home' && nearFlag(p, own, 2.2)) {
      homeFlag(1 - p.team);
      state.scores[p.team]++;
      p.caps++;
      changed = true;
      say(teamName(p.team) + ' captured the flag!');
      broadcast({ t: 'score', sc: state.scores });
      sendEx(p);
      checkWin();
    }
  }
  for (let t = 0; t < 2; t++) {
    const f = state.flags[t];
    if (f.s === 'dropped' && now - f.dropAt > FLAG_RETURN_MS) {
      homeFlag(t); changed = true;
      say('The ' + teamName(t) + ' flag returned home');
    }
  }
  if (changed) sendFlags();
}

// ---- kill confirmed ----
function dropTag(victim) {
  const t = { id: state.nextTag++, x: victim.x, y: victim.y, z: victim.z, team: victim.team, t0: Date.now() };
  state.tags.push(t);
  while (state.tags.length > 24) {
    const old = state.tags.shift();
    broadcast({ t: 'tagx', id: old.id, by: 0, k: 'expire' });
  }
  broadcast({ t: 'tag', id: t.id, p: [r2(t.x), r2(t.y), r2(t.z)], team: t.team });
}
function tickKc(now) {
  for (const p of state.players.values()) {
    if (!p.alive || p.team < 0) continue;
    for (const t of state.tags.slice()) {
      if (Math.hypot(p.x - t.x, p.z - t.z) > 1.5 || Math.abs(p.y - t.y) > 2.5) continue;
      state.tags.splice(state.tags.indexOf(t), 1);
      if (t.team !== p.team) {
        state.scores[p.team]++;
        p.confs++;
        broadcast({ t: 'tagx', id: t.id, by: p.id, k: 'confirm' });
        broadcast({ t: 'score', sc: state.scores });
        sendEx(p);
        checkWin();
      } else {
        broadcast({ t: 'tagx', id: t.id, by: p.id, k: 'deny' });
      }
    }
  }
  for (const t of state.tags.slice()) {
    if (now - t.t0 > TAG_LIFE_MS) {
      state.tags.splice(state.tags.indexOf(t), 1);
      broadcast({ t: 'tagx', id: t.id, by: 0, k: 'expire' });
    }
  }
}

// ---- gun game ----
function ggAdvance(killer) {
  killer.level++;
  if (killer.level >= state.limit) { sendEx(killer); endMatch(killer.name + ' WINS!'); return; }
  applyLoadout(killer);
  sendEx(killer);
  sendMe(killer);
}

// ---- infected ----
function infect(p) {
  p.team = 1;
  broadcast({ t: 'team', id: p.id, team: 1 });
}
function pickInfected() {
  const list = Array.from(state.players.values());
  if (list.length < 2) return null;
  const p = list[Math.floor(Math.random() * list.length)];
  p.team = 1;
  return p;
}
function infCheck() {
  if (state.mode !== 'inf' || state.over || state.players.size < 2) return;
  const c = countTeams();
  if (c[0] === 0) { endMatch('INFECTED WIN!'); return; }
  if (c[1] === 0 && c[0] >= 2) {
    const l = Array.from(state.players.values()).filter((p) => p.team === 0);
    const v = l[Math.floor(Math.random() * l.length)];
    infect(v);
    say(v.name + ' is the new infected!');
  }
}

// ---- last man standing ----
function startRound() {
  if (state.over || !state.round) return;
  state.round.n++;
  state.round.active = true;
  state.round.endAt = Date.now() + ROUND_MS;
  broadcast({ t: 'round', n: state.round.n });
  say('ROUND ' + state.round.n);
  for (const p of state.players.values()) { p.alive = false; spawnPlayer(p, true); }
}
function endRound(w) {
  if (!state.round || !state.round.active || state.over) return;
  state.round.active = false;
  if (w) {
    w.wins++;
    sendEx(w);
    say(w.name + ' won the round');
    if (w.wins >= state.limit) { endMatch(w.name + ' WINS!'); return; }
  } else {
    say('Round draw');
  }
  state.roundTimer = setTimeout(startRound, FAST ? 800 : 4000);
}
function lmsCheck() {
  if (state.mode !== 'lms' || !state.round || !state.round.active || state.over) return;
  const alive = Array.from(state.players.values()).filter((p) => p.alive);
  if (state.players.size >= 2 && alive.length <= 1) endRound(alive[0] || null);
}
function tickLms(now) {
  const r = state.round;
  if (!r.active || now < r.endAt) return;
  let top = null, tie = false;
  for (const p of state.players.values()) {
    if (!p.alive) continue;
    if (!top || p.hp > top.hp) { top = p; tie = false; } else if (p.hp === top.hp) tie = true;
  }
  endRound(tie ? null : top);
}

// ---- match flow ----
function nextMode() {
  if (state.cfg.mode !== 'rotate') return state.cfg.mode;
  return MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length];
}
function nextMapIdx() {
  if (state.cfg.map !== 'rotate') return Math.max(0, MAPS.findIndex((m) => m.name === state.cfg.map));
  return (state.mapIdx + 1) % MAPS.length;
}

function checkWin() {
  if (state.over) return;
  const mode = state.mode, lim = state.limit;
  if (mode === 'ffa') {
    for (const p of state.players.values()) if (p.kills >= lim) { endMatch(p.name + ' WINS!'); return; }
  } else if (mode === 'tdm' || mode === 'hp' || mode === 'ctf' || mode === 'kc') {
    if (state.scores[0] >= lim) endMatch(teamName(0) + ' TEAM WINS!');
    else if (state.scores[1] >= lim) endMatch(teamName(1) + ' TEAM WINS!');
  }
}

function topPlayer(fn) {
  let top = null, tie = false;
  for (const p of state.players.values()) {
    const v = fn(p);
    if (!top || v > top.v) { top = { p, v }; tie = false; } else if (v === top.v) tie = true;
  }
  return top && !tie ? top.p : null;
}

function timeUp() {
  const mode = state.mode;
  let text = 'DRAW';
  if (mode === 'inf') {
    text = 'SURVIVORS WIN!';
  } else if (mode === 'tdm' || mode === 'hp' || mode === 'ctf' || mode === 'kc') {
    if (state.scores[0] > state.scores[1]) text = teamName(0) + ' TEAM WINS!';
    else if (state.scores[1] > state.scores[0]) text = teamName(1) + ' TEAM WINS!';
  } else {
    const key = mode === 'gg' ? (p) => p.level : mode === 'lms' ? (p) => p.wins : (p) => p.kills;
    const w = topPlayer(key);
    if (w) text = w.name + ' WINS!';
  }
  endMatch(text);
}

function endMatch(text) {
  if (state.over) return;
  state.over = true;
  if (state.roundTimer) clearTimeout(state.roundTimer);
  state.roundTimer = null;
  for (const p of state.players.values()) {
    if (p.respawnTimer) clearTimeout(p.respawnTimer);
    p.respawnTimer = null;
  }
  broadcast({ t: 'over', text, next: MAPS[nextMapIdx()].name, nextMode: MODES[nextMode()].name });
  state.restartTimer = setTimeout(newMatch, RESTART_MS);
}

function newMatch() {
  if (state.restartTimer) clearTimeout(state.restartTimer);
  if (state.roundTimer) clearTimeout(state.roundTimer);
  state.restartTimer = null;
  state.roundTimer = null;
  state.over = false;
  state.mapIdx = nextMapIdx();
  state.map = MAPS[state.mapIdx];
  state.mode = nextMode();
  state.scores = [0, 0];
  for (const p of state.players.values()) {
    if (p.respawnTimer) clearTimeout(p.respawnTimer);
    p.respawnTimer = null;
    cancelReload(p);
    p.kills = 0; p.deaths = 0; p.level = 0; p.caps = 0; p.confs = 0; p.wins = 0;
    p.alive = false;
  }
  assignTeams();
  const first = state.mode === 'inf' ? pickInfected() : null;
  initMode();
  broadcast(Object.assign({ t: 'new', players: Array.from(state.players.values()).map(info) }, matchInfo()));
  if (first) say(first.name + ' is the first infected!');
  if (state.mode === 'lms') startRound();
  else for (const p of state.players.values()) spawnPlayer(p);
}

// ---- host settings ----
function applyConfig(c, restart) {
  const cfg = state.cfg;
  if (typeof c.mode === 'string' && (c.mode === 'rotate' || MODES[c.mode])) cfg.mode = c.mode;
  if (typeof c.map === 'string' && (c.map === 'rotate' || MAPS.some((m) => m.name === c.map))) cfg.map = c.map;
  if (Number.isFinite(c.limit)) cfg.limit = Math.max(0, Math.min(9999, Math.floor(c.limit)));
  if (Number.isFinite(c.time)) cfg.time = Math.max(0, Math.min(3600, Math.floor(c.time)));
  broadcast({ t: 'cfg', cfg });
  saveSettings();
  if (restart || state.players.size === 0) newMatch();
  else say('Host settings saved. They apply from the next match.');
}

// ====================================================================
// Combat
// ====================================================================
function falloff(w, dist) {
  if (dist <= w.rs) return 1;
  if (dist >= w.re) return w.dmin;
  return 1 - (1 - w.dmin) * ((dist - w.rs) / (w.re - w.rs));
}

function die(victim, killer, weapon, head, dmg) {
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  killer.kills++;
  cancelReload(victim);
  const mode = state.mode;
  if (mode === 'tdm') state.scores[killer.team]++;
  dropFlagIfCarrier(victim);
  if (mode === 'kc') dropTag(victim);
  broadcast({ t: 'kill', k: killer.id, v: victim.id, w: weapon, head, d: Math.round(dmg), kills: killer.kills,
    deaths: victim.deaths, sc: state.scores });
  sendMe(victim);
  if (mode === 'gg') ggAdvance(killer);
  if (mode === 'inf' && victim.team === 0) {
    infect(victim);
    state.scores[1]++;
    say(victim.name + ' was infected!');
    infCheck();
  }
  if (mode === 'lms') lmsCheck();
  checkWin();
  if (!state.over && mode !== 'lms') {
    victim.respawnTimer = setTimeout(() => {
      victim.respawnTimer = null;
      if (!victim.alive) spawnPlayer(victim);
    }, RESPAWN_MS);
  }
}

function applyDamage(shooter, q, weapon, head, dmg) {
  q.hp -= dmg;
  q.lastHit = Date.now();
  if (q.hp > 0) {
    broadcast({ t: 'dmg', v: q.id, hp: Math.round(q.hp), by: shooter.id, head, d: Math.round(dmg) });
    sendMe(q);
  } else {
    die(q, shooter, weapon, head, dmg);
  }
}

function spreadDir(d, spread) {
  const up = Math.abs(d[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
  const rx = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  const rl = Math.hypot(rx[0], rx[1], rx[2]);
  const r = [rx[0] / rl, rx[1] / rl, rx[2] / rl];
  const u = [r[1] * d[2] - r[2] * d[1], r[2] * d[0] - r[0] * d[2], r[0] * d[1] - r[1] * d[0]];
  const a = (Math.random() * 2 - 1) * spread;
  const b = (Math.random() * 2 - 1) * spread;
  const dd = [d[0] + r[0] * a + u[0] * b, d[1] + r[1] * a + u[1] * b, d[2] + r[2] * a + u[2] * b];
  const l = Math.hypot(dd[0], dd[1], dd[2]);
  return [dd[0] / l, dd[1] / l, dd[2] / l];
}

function onShoot(p, m) {
  if (!p.alive || state.over) return;
  const now = Date.now();
  const wk = p.weapon;
  const w = WEAPONS[wk];
  if (p.reloading || now < p.nextFire - 20) return;
  if (p.ammo[wk] <= 0) { startReload(p); return; }
  if (!Array.isArray(m.d) || m.d.length !== 3 || !m.d.every((v) => num(v, -1.5, 1.5))) return;
  const len = Math.hypot(m.d[0], m.d[1], m.d[2]);
  if (len < 0.5) return;
  const d = [m.d[0] / len, m.d[1] / len, m.d[2] / len];

  p.ammo[wk]--;
  p.nextFire = now + w.rate * 1000;

  // spread, pellets, range and damage falloff all happen on the server so clients cannot cheat them
  const spread = w.spread * (m.sc ? w.ads : 1);
  const ends = [];
  const hits = new Map();
  let eye = null;
  for (let i = 0; i < w.pellets; i++) {
    const res = fireRay(p, spreadDir(d, spread), w.range || 300);
    eye = res.o;
    ends.push([r2(res.o[0] + res.dir[0] * res.t), r2(res.o[1] + res.dir[1] * res.t), r2(res.o[2] + res.dir[2] * res.t)]);
    if (res.hit) {
      const dmg = w.damage * falloff(w, res.t) * (res.hit.head ? HEAD_MULT : 1);
      const e = hits.get(res.hit.q.id) || { q: res.hit.q, dmg: 0, head: false };
      e.dmg += dmg;
      e.head = e.head || res.hit.head;
      hits.set(res.hit.q.id, e);
    }
  }
  broadcast({ t: 'shot', id: p.id, o: [r2(eye[0]), r2(eye[1]), r2(eye[2])], es: ends, w: wk });
  for (const e of hits.values()) if (e.q.alive) applyDamage(p, e.q, wk, e.head, e.dmg);
  if (p.ammo[wk] <= 0 && p.alive) startReload(p);
  else sendMe(p);
}

function startReload(p) {
  const w = WEAPONS[p.weapon];
  if (!p.alive || p.reloading || p.ammo[p.weapon] >= w.mag) return;
  p.reloading = true;
  const key = p.weapon;
  p.reloadTimer = setTimeout(() => {
    p.reloadTimer = null;
    if (!p.reloading || !state.players.has(p.id)) return;
    p.reloading = false;
    p.ammo[key] = WEAPONS[key].mag;
    sendMe(p);
  }, w.reload * 1000);
  sendMe(p);
}

function onWeapon(p, m) {
  if (!p.alive || (m.s !== 0 && m.s !== 1)) return;
  const wk = p.loadout[m.s];
  if (!wk || wk === p.weapon) return;
  cancelReload(p);
  p.weapon = wk;
  p.nextFire = Date.now() + 250;
  sendMe(p);
}

function onClass(p, m) {
  if (!Number.isInteger(m.c) || m.c < 0 || m.c >= CLASSES.length) return;
  p.cls = m.c;    // applied on next spawn
}

function onChat(p, m) {
  const now = Date.now();
  if (now - p.lastChat < 700) return;
  p.lastChat = now;
  const text = String(m.m || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
  if (text) broadcast({ t: 'chat', id: p.id, m: text });
}

function onState(p, m) {
  if (!p.alive) return;
  if (!Array.isArray(m.p) || m.p.length !== 3 || !Array.isArray(m.r) || m.r.length !== 2) return;
  const [x, y, z] = m.p;
  const h = state.map.half;
  if (!num(x, -h, h) || !num(y, -2, 40) || !num(z, -h, h)) return;
  if (!num(m.r[0], -1000, 1000) || !num(m.r[1], -1.6, 1.6)) return;
  const now = Date.now();
  const dt = Math.min((now - p.lastSt) / 1000, 2);
  if (Math.hypot(x - p.x, y - p.y, z - p.z) > 40 * dt + 2) {
    send(p.ws, { t: 'fix', p: [p.x, p.y, p.z] });
    return;
  }
  p.x = x; p.y = y; p.z = z;
  p.yaw = m.r[0];
  p.pitch = m.r[1];
  p.crouch = m.c === 1;
  p.lastSt = now;
}

function onMessage(ws, m) {
  if (!ws.player) {
    if (m.t === 'join') addPlayer(ws, m);
    return;
  }
  const p = ws.player;
  switch (m.t) {
    case 'st': onState(p, m); break;
    case 'shoot': onShoot(p, m); break;
    case 'rld': startReload(p); break;
    case 'wpn': onWeapon(p, m); break;
    case 'cls': onClass(p, m); break;
    case 'chat': onChat(p, m); break;
    case 'cfg': if (p.id === state.hostId) applyConfig(m, !!m.restart); break;
    case 'wl': if (p.id === state.hostId) wlCommand(m); break;
    default: break;
  }
}

// ====================================================================
// Network loop
// ====================================================================
function onConnection(ws, req) {
  ws.isAlive = true;
  ws.bucket = 100;
  ws.loop = isLoopback(req.socket.remoteAddress);
  ws.ip = normIp(req.socket.remoteAddress);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    if (--ws.bucket < 0) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    onMessage(ws, m);
  });
  ws.on('close', () => { if (ws.player) removePlayer(ws.player); });
  ws.on('error', () => {});
}

function modeTick(now) {
  if (state.over) return;
  if (!state.players.size) { state.endAt = now + state.time * 1000; return; }   // the clock only runs while somebody is playing
  const sec = Math.floor(now / 1000) !== state.lastSec;
  if (sec) {
    state.lastSec = Math.floor(now / 1000);
    broadcast({ t: 'time', left: leftSec() });
  }
  if (now >= state.endAt) { timeUp(); return; }
  switch (state.mode) {
    case 'hp': tickHp(now, sec); break;
    case 'ctf': tickCtf(now); break;
    case 'kc': tickKc(now); break;
    case 'lms': tickLms(now); break;
    default: break;
  }
}

function tick() {
  const now = Date.now();
  for (const p of state.players.values()) {
    p.ws.bucket = Math.min(100, p.ws.bucket + 10);
    if (p.alive && p.hp < p.maxHp && now - p.lastHit > REGEN_DELAY) {
      p.hp = Math.min(p.maxHp, p.hp + REGEN_RATE * (TICK_MS / 1000));
      if (now - p.lastMe > 250 || p.hp >= p.maxHp) sendMe(p);
    }
  }
  if (!state.players.size) { modeTick(now); return; }
  const ps = [];
  for (const p of state.players.values()) {
    if (p.alive) ps.push([p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), p.crouch ? 1 : 0]);
  }
  broadcast({ t: 'snap', ps });
  modeTick(now);
}

function heartbeat(wss) {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}

// ====================================================================
// HTTP
// ====================================================================
function apiInfo(req) {
  return JSON.stringify({ mode: state.mode, modeCfg: state.cfg.mode, cfg: state.cfg, limit: state.limit, left: leftSec(),
    weapons: WEAPONS, classes: CLASSES, map: state.map.pub, maps: MAPS.map((m) => m.name),
    modes: MODE_ORDER.map((id) => ({ id, name: MODES[id].name, desc: MODES[id].desc, teams: MODES[id].teams, limit: MODES[id].limit, time: MODES[id].time })),
    host: isLoopback(req.socket.remoteAddress), players: state.players.size, max: MAX_PLAYERS });
}

// host-only JSON endpoints (only reachable from the PC that runs the server)
function hostOnlyJson(req, res, fn) {
  if (!isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end('only the host PC can change settings'); return; }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 2048) req.destroy(); });
  req.on('end', () => {
    try {
      const out = fn(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400);
      res.end('bad request');
    }
  });
}

function serveStatic(req, res) {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); res.end(); return; }
  if (!isAllowed(req.socket.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Access denied: your IP address is not on this server\'s whitelist.');
    return;
  }
  if (url === '/api/config' && req.method === 'POST') { hostOnlyJson(req, res, (c) => { applyConfig(c, !!c.restart); return { ok: true, cfg: state.cfg }; }); return; }
  if (url === '/api/whitelist' && req.method === 'POST') { hostOnlyJson(req, res, (c) => { wlCommand(c); return { ok: true, wl: wlInfo() }; }); return; }
  if (url === '/api/whitelist') {
    if (!isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end('only the host PC can see the whitelist'); return; }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(wlInfo()));
    return;
  }
  if (url === '/api/info') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(apiInfo(req));
    return;
  }
  if (url === '/') url = '/index.html';
  const file = path.resolve(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ====================================================================
// Entry
// ====================================================================
function main() {
  buildMaps();
  finishMaps();
  loadSettings();                           // settings.json first, then command line / env override it
  const arg = (process.env.MODE || process.argv[2] || '').toLowerCase();
  if (arg === 'rotate' || MODES[arg]) state.cfg.mode = arg;
  const want = (process.env.MAP || '').toLowerCase();
  let widx = MAPS.findIndex((m) => m.name.toLowerCase() === want);
  if (widx < 0 && /^\d+$/.test(want)) widx = Math.min(MAPS.length - 1, Math.max(0, Number(want) - 1));
  if (widx >= 0) state.cfg.map = MAPS[widx].name;
  if (process.env.LIMIT) state.cfg.limit = Math.max(0, Number(process.env.LIMIT) || 0);
  if (process.env.TIME) state.cfg.time = Math.max(0, Number(process.env.TIME) || 0);
  const idx = MAPS.findIndex((m) => m.name === state.cfg.map);
  state.mapIdx = idx >= 0 ? idx : 0;
  state.map = MAPS[state.mapIdx];
  state.mode = state.cfg.mode === 'rotate' ? 'ffa' : state.cfg.mode;
  initMode();
  saveSettings();                           // creates settings.json on the first run so it can be edited
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: 2048, verifyClient: (i) => isAllowed(i.req.socket.remoteAddress) });
  state.wss = wss;
  wss.on('connection', onConnection);
  setInterval(tick, TICK_MS);
  setInterval(() => heartbeat(wss), 30000);
  server.on('error', (e) => { console.error('Server error:', e.message); process.exit(1); });
  server.listen(port, '0.0.0.0', () => {
    console.log('Block Arena running. Mode: ' + (state.cfg.mode === 'rotate' ? 'all modes take turns' : MODES[state.mode].name) +
      '  Map: ' + state.map.name + (state.cfg.map === 'rotate' ? ' (rotates)' : ' (locked)'));
    console.log('  The player on this PC is the host and can change mode, map and the IP whitelist in the game menu.');
    console.log('  Settings file: ' + (SETTINGS_ON ? SETTINGS_FILE : '(saving is off)') + (wl.enabled ? '   WHITELIST ON (' + wl.ips.length + ' entries)' : ''));
    console.log('  This PC:  http://localhost:' + port);
    for (const ip of lanAddresses()) console.log('  Friends:  http://' + ip + ':' + port);
  });
}

main();
