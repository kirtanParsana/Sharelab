'use strict';
const { createClient } = require('@libsql/client');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');

const txStore = new AsyncLocalStorage();
let client;
let initPromise;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name,email UNIQUE,role,pw,verified INT DEFAULT 1,late INT DEFAULT 0,noshow INT DEFAULT 0,mail INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS creds(u,k,st,file,PRIMARY KEY(u,k));
CREATE TABLE IF NOT EXISTS res(id TEXT PRIMARY KEY,n,c,l,o,m,req,mode,q INT,rule,active INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS bk(id TEXT PRIMARY KEY,r,u,day,s INT,h INT,purpose,st,why,t INT,ci,co,late INT DEFAULT 0,ovd INT DEFAULT 0,rem INT DEFAULT 0,ct INT);
CREATE TABLE IF NOT EXISTS inc(id TEXT PRIMARY KEY,b,t,s,d,st,rep,res DEFAULT '',at INT,ev DEFAULT '[]');
CREATE TABLE IF NOT EXISTS notif(id INTEGER PRIMARY KEY AUTOINCREMENT,u,m,t INT,seen INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,t INT,who,act,ent,why,p,h);
CREATE TABLE IF NOT EXISTS sess(tok TEXT PRIMARY KEY,u,exp INT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v INT);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,u,mime,data BLOB,ref,t INT);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,t INT,u,to_,subject,body,st);
`;

const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN mail INT DEFAULT 1',
  'ALTER TABLE creds ADD COLUMN file',
  'ALTER TABLE bk ADD COLUMN ct INT',
  "ALTER TABLE inc ADD COLUMN ev DEFAULT '[]'"
];

function isFileUrl(url) {
  return typeof url === 'string' && (url === ':memory:' || url.startsWith('file:'));
}

function ensureFileDir(url) {
  if (!url || url === ':memory:' || !url.startsWith('file:')) return url;
  let p = url.slice(5);
  if (p.startsWith('//') && !p.startsWith('///')) p = p.slice(2);
  else if (p.startsWith('///')) p = p.slice(2);
  if (!p) return url;
  const abs = path.resolve(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return 'file:' + abs;
}

function resolveConfig() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
  const prod = process.env.NODE_ENV === 'production';

  if (prod) {
    if (!url) throw new Error('TURSO_DATABASE_URL is required in production. Set it to your Turso libSQL URL (libsql://...). Do not use a local SQLite file on Render.');
    if (isFileUrl(url)) throw new Error('Production must use hosted Turso (libsql:// or https://). Local file databases are not allowed because Render disks are ephemeral.');
    if (!authToken) throw new Error('TURSO_AUTH_TOKEN is required in production for hosted Turso.');
    return { url, authToken };
  }

  if (url) {
    if (!isFileUrl(url) && !authToken) throw new Error('TURSO_AUTH_TOKEN is required for hosted Turso.');
    return { url: isFileUrl(url) ? ensureFileDir(url) : url, authToken: isFileUrl(url) ? undefined : authToken };
  }

  const local = path.join(__dirname, 'data', 'sharelab.db');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  return { url: 'file:' + local };
}

function normalizeValue(v) {
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (v && v.constructor && v.constructor.name === 'ArrayBuffer') return Buffer.from(v);
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
  return v;
}

function normalizeRow(row, columns) {
  if (!row) return undefined;
  const out = {};
  for (const col of columns) out[col] = normalizeValue(row[col]);
  return out;
}

function executor() {
  const ctx = txStore.getStore();
  if (ctx) return ctx.tx;
  if (!client) throw new Error('Database not initialized');
  return client;
}

async function execute(sql, args = []) {
  const rs = await executor().execute({ sql, args });
  return rs;
}

async function all(sql, ...args) {
  const rs = await execute(sql, args);
  return rs.rows.map(row => normalizeRow(row, rs.columns));
}

async function one(sql, ...args) {
  const rows = await all(sql, ...args);
  return rows[0];
}

async function run(sql, ...args) {
  const rs = await execute(sql, args);
  return { lastInsertRowid: rs.lastInsertRowid, rowsAffected: rs.rowsAffected };
}

function enqueueJob(job) {
  const ctx = txStore.getStore();
  if (ctx) ctx.jobs.push(job);
  else job();
}

async function withTransaction(fn) {
  if (!client) throw new Error('Database not initialized');
  if (txStore.getStore()) return fn();
  const tx = await client.transaction('write');
  const ctx = { tx, jobs: [] };
  try {
    const out = await txStore.run(ctx, fn);
    await tx.commit();
    for (const job of ctx.jobs) job();
    return out;
  } catch (e) {
    if (!tx.closed) {
      try { await tx.rollback(); } catch { /* already closed */ }
    }
    throw e;
  } finally {
    if (!tx.closed) {
      try { tx.close(); } catch { /* already closed */ }
    }
  }
}

async function migrate() {
  await client.executeMultiple(SCHEMA_SQL);
  for (const sql of MIGRATIONS) {
    try { await client.execute(sql); } catch { /* column already exists */ }
  }
}

function createClientFromEnv() {
  return createClient(resolveConfig());
}

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!client) client = createClientFromEnv();
    await migrate();
    return client;
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

function close() {
  if (client && !client.closed) {
    try { client.close(); } catch { /* already closed */ }
  }
  client = undefined;
  initPromise = null;
}

function getClient() {
  if (!client) throw new Error('Database not initialized');
  return client;
}

module.exports = {
  resolveConfig, init, close, getClient, all, one, run, withTransaction, enqueueJob, isFileUrl
};
