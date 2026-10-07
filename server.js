'use strict';
// Basic restaurant POS server. No npm dependencies: needs Node 22.5+ (built-in SQLite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const TAX_PERCENT = Number(process.env.TAX_PERCENT) || 0; // e.g. TAX_PERCENT=16
const CURRENCY = process.env.CURRENCY || 'Rs';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'Al Naaz Biryani';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'pos.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Database ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  available INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  table_no TEXT,
  type TEXT NOT NULL DEFAULT 'dine-in',
  status TEXT NOT NULL DEFAULT 'open',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tendered INTEGER NOT NULL,
  change_given INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

// Upgrade databases created before login existed.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('orders', 'created_by', 'INTEGER');
addColumn('orders', 'paid_by', 'INTEGER');

// ---------- Passwords and sessions ----------
const SESSION_HOURS = 12;
const MIN_PASSWORD = 6;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomPassword = () => crypto.randomBytes(6).toString('base64url');

// First run: create an admin account and print its password once.
// Lost the password? Run:  node server.js --reset-admin
function ensureAdmin() {
  const resetting = process.argv.includes('--reset-admin');
  const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get();
  if (hasAdmin && !resetting) return false;
  const password = process.env.ADMIN_PASSWORD || randomPassword();
  const existing = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin', active = 1 WHERE id = ?").run(
      hashPassword(password),
      existing.id
    );
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  } else {
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(
      hashPassword(password)
    );
  }
  console.log('');
  console.log('=====================================================');
  console.log(`  ADMIN LOGIN   username: admin   password: ${password}`);
  console.log('  Log in and change it (top right > Password).');
  console.log('=====================================================');
  console.log('');
  return true;
}
ensureAdmin();
if (process.argv.includes('--reset-admin')) process.exit(0);

const MENU = require('./menu.js');

function insertMenu() {
  const findCat = db.prepare('SELECT id FROM categories WHERE name = ?');
  const addCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const addItem = db.prepare('INSERT INTO items (category_id, name, price) VALUES (?, ?, ?)');
  for (const [cat, items] of Object.entries(MENU)) {
    const existing = findCat.get(cat);
    const id = existing ? existing.id : Number(addCat.run(cat).lastInsertRowid);
    for (const [name, price] of items) addItem.run(id, name, price);
  }
}

// First run on an empty database: load the menu from menu.js.
function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0) return;
  insertMenu();
}

// node server.js --load-menu : replace the current menu with menu.js.
// Items used in past orders are hidden (so old receipts and reports stay correct); the rest are removed.
function loadMenu() {
  tx(() => {
    db.exec(`
      UPDATE items SET available = 0 WHERE id IN (SELECT DISTINCT item_id FROM order_items WHERE item_id IS NOT NULL);
      DELETE FROM items WHERE id NOT IN (SELECT DISTINCT item_id FROM order_items WHERE item_id IS NOT NULL);
      DELETE FROM categories WHERE id NOT IN (SELECT DISTINCT category_id FROM items);
    `);
    insertMenu();
  });
}

seed();
if (process.argv.includes('--load-menu')) {
  loadMenu();
  const n = db.prepare('SELECT COUNT(*) AS n FROM items WHERE available = 1').get().n;
  console.log(`Menu loaded from menu.js: ${n} items.`);
  process.exit(0);
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const isInt = (v) => Number.isInteger(v);
const cleanText = (v) => (typeof v === 'string' ? v.trim() : '');
const todayLocal = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

// ---------- Orders ----------
function getOrder(id) {
  const order = db
    .prepare(
      `SELECT o.*, cu.username AS created_by_name, pu.username AS paid_by_name
       FROM orders o
       LEFT JOIN users cu ON cu.id = o.created_by
       LEFT JOIN users pu ON pu.id = o.paid_by
       WHERE o.id = ?`
    )
    .get(id);
  if (!order) throw new HttpError(404, 'Order not found');
  const o = { ...order };
  o.items = db
    .prepare('SELECT item_id, name, price, qty FROM order_items WHERE order_id = ? ORDER BY id')
    .all(id)
    .map((r) => ({ ...r }));
  const pay = db
    .prepare('SELECT method, amount, tendered, change_given FROM payments WHERE order_id = ?')
    .get(id);
  o.payment = pay ? { ...pay } : null;
  return o;
}

function recalc(orderId) {
  const subtotal = db
    .prepare('SELECT COALESCE(SUM(price * qty), 0) AS s FROM order_items WHERE order_id = ?')
    .get(orderId).s;
  const { discount } = db.prepare('SELECT discount FROM orders WHERE id = ?').get(orderId);
  const disc = Math.min(discount, subtotal);
  const tax = Math.round(((subtotal - disc) * TAX_PERCENT) / 100);
  db.prepare('UPDATE orders SET subtotal = ?, discount = ?, tax = ?, total = ? WHERE id = ?').run(
    subtotal,
    disc,
    tax,
    subtotal - disc + tax,
    orderId
  );
}

// Validates the cart and returns rows ready to insert. allowIds = item ids that may be
// unavailable because they are already on the order being edited.
function buildLines(items, allowIds = new Set()) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Add at least one item');
  const merged = new Map();
  for (const line of items) {
    if (!isInt(line.item_id) || !isInt(line.qty) || line.qty < 1 || line.qty > 999) {
      throw new HttpError(400, 'Each line needs item_id and a whole-number qty of 1 or more');
    }
    merged.set(line.item_id, (merged.get(line.item_id) || 0) + line.qty);
  }
  const find = db.prepare('SELECT id, name, price, available FROM items WHERE id = ?');
  return [...merged].map(([itemId, qty]) => {
    const item = find.get(itemId);
    if (!item) throw new HttpError(400, `Item ${itemId} does not exist`);
    if (!item.available && !allowIds.has(itemId)) {
      throw new HttpError(400, `${item.name} is not available`);
    }
    return { item_id: item.id, name: item.name, price: item.price, qty };
  });
}

function parseOrderFields(body) {
  const type = body.type === 'takeaway' ? 'takeaway' : 'dine-in';
  const table_no = type === 'dine-in' ? cleanText(body.table_no).slice(0, 20) : '';
  const discount = body.discount === undefined || body.discount === '' ? 0 : body.discount;
  if (!isInt(discount) || discount < 0) throw new HttpError(400, 'Discount must be a whole number, 0 or more');
  if (type === 'dine-in' && !table_no) throw new HttpError(400, 'Enter a table number for dine-in');
  return { type, table_no, discount };
}

const insertLine = db.prepare(
  'INSERT INTO order_items (order_id, item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)'
);

function createOrder(body, user) {
  const fields = parseOrderFields(body);
  const lines = buildLines(body.items);
  return tx(() => {
    const id = Number(
      db
        .prepare('INSERT INTO orders (table_no, type, discount, created_by) VALUES (?, ?, ?, ?)')
        .run(fields.table_no, fields.type, fields.discount, user.id).lastInsertRowid
    );
    for (const l of lines) insertLine.run(id, l.item_id, l.name, l.price, l.qty);
    recalc(id);
    return getOrder(id);
  });
}

function updateOrder(id, body) {
  const existing = getOrder(id);
  if (existing.status !== 'open') throw new HttpError(409, `Order is already ${existing.status}`);
  const fields = parseOrderFields(body);
  const lines = buildLines(body.items, new Set(existing.items.map((i) => i.item_id)));
  return tx(() => {
    db.prepare('UPDATE orders SET table_no = ?, type = ?, discount = ? WHERE id = ?').run(
      fields.table_no,
      fields.type,
      fields.discount,
      id
    );
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    for (const l of lines) insertLine.run(id, l.item_id, l.name, l.price, l.qty);
    recalc(id);
    return getOrder(id);
  });
}

function payOrder(id, body, user) {
  const order = getOrder(id);
  if (order.status !== 'open') throw new HttpError(409, `Order is already ${order.status}`);
  const method = body.method === 'card' ? 'card' : body.method === 'cash' ? 'cash' : null;
  if (!method) throw new HttpError(400, 'Payment method must be cash or card');
  let tendered = order.total;
  if (method === 'cash' && body.tendered !== undefined && body.tendered !== '') {
    tendered = body.tendered;
  }
  if (!isInt(tendered) || tendered < order.total) {
    throw new HttpError(400, 'Cash received is less than the total');
  }
  return tx(() => {
    db.prepare(
      'INSERT INTO payments (order_id, method, amount, tendered, change_given) VALUES (?, ?, ?, ?, ?)'
    ).run(id, method, order.total, tendered, tendered - order.total);
    db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now','localtime'), paid_by = ? WHERE id = ?").run(
      user.id,
      id
    );
    return getOrder(id);
  });
}

function cancelOrder(id) {
  const order = getOrder(id);
  if (order.status !== 'open') throw new HttpError(409, `Order is already ${order.status}`);
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id);
  return getOrder(id);
}

function listOrders(status) {
  const allowed = ['open', 'paid', 'cancelled'];
  const st = allowed.includes(status) ? status : 'open';
  return db
    .prepare('SELECT id FROM orders WHERE status = ? ORDER BY id DESC LIMIT 200')
    .all(st)
    .map((r) => getOrder(r.id));
}

// ---------- Menu ----------
function getMenu() {
  const items = db.prepare('SELECT id, category_id, name, price, available FROM items ORDER BY id').all();
  const categories = db
    .prepare('SELECT id, name FROM categories ORDER BY id')
    .all()
    .map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id).map((i) => ({ ...i })) }));
  return { config: { currency: CURRENCY, taxPercent: TAX_PERCENT, restaurantName: RESTAURANT_NAME }, categories };
}

function parsePrice(v) {
  if (!isInt(v) || v < 0) throw new HttpError(400, 'Price must be a whole number, 0 or more');
  return v;
}

function createItem(body) {
  const name = cleanText(body.name);
  if (!name) throw new HttpError(400, 'Item name is required');
  const price = parsePrice(body.price);
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(body.category_id)) {
    throw new HttpError(400, 'Choose a valid category');
  }
  const id = Number(
    db.prepare('INSERT INTO items (category_id, name, price) VALUES (?, ?, ?)').run(body.category_id, name, price)
      .lastInsertRowid
  );
  return { ...db.prepare('SELECT * FROM items WHERE id = ?').get(id) };
}

function updateItem(id, body) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) throw new HttpError(404, 'Item not found');
  const name = body.name === undefined ? item.name : cleanText(body.name);
  if (!name) throw new HttpError(400, 'Item name is required');
  const price = body.price === undefined ? item.price : parsePrice(body.price);
  const available = body.available === undefined ? item.available : body.available ? 1 : 0;
  db.prepare('UPDATE items SET name = ?, price = ?, available = ? WHERE id = ?').run(name, price, available, id);
  return { ...db.prepare('SELECT * FROM items WHERE id = ?').get(id) };
}

function deleteItem(id) {
  if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) throw new HttpError(404, 'Item not found');
  const used = db.prepare('SELECT 1 FROM order_items WHERE item_id = ? LIMIT 1').get(id);
  if (used) {
    // Past orders refer to it, so hide it instead of deleting.
    db.prepare('UPDATE items SET available = 0 WHERE id = ?').run(id);
    return { archived: true };
  }
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  return { deleted: true };
}

function createCategory(body) {
  const name = cleanText(body.name);
  if (!name) throw new HttpError(400, 'Category name is required');
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) {
    throw new HttpError(409, 'That category already exists');
  }
  const id = Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid);
  return { id, name };
}

function deleteCategory(id) {
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw new HttpError(404, 'Category not found');
  if (db.prepare('SELECT 1 FROM items WHERE category_id = ? LIMIT 1').get(id)) {
    throw new HttpError(409, 'Remove or move the items in this category first');
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { deleted: true };
}

// ---------- Reports ----------
function dailyReport(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue,
              COALESCE(SUM(discount),0) AS discounts, COALESCE(SUM(tax),0) AS tax
       FROM orders WHERE status = 'paid' AND date(paid_at) = ?`
    )
    .get(date);
  const byMethod = db
    .prepare(
      `SELECT p.method, COUNT(*) AS orders, SUM(p.amount) AS amount
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.status = 'paid' AND date(o.paid_at) = ? GROUP BY p.method`
    )
    .all(date)
    .map((r) => ({ ...r }));
  const topItems = db
    .prepare(
      `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'paid' AND date(o.paid_at) = ?
       GROUP BY oi.name ORDER BY qty DESC, amount DESC LIMIT 10`
    )
    .all(date)
    .map((r) => ({ ...r }));
  const byCashier = db
    .prepare(
      `SELECT COALESCE(u.username, '(unknown)') AS cashier, COUNT(*) AS orders, SUM(o.total) AS amount
       FROM orders o LEFT JOIN users u ON u.id = o.paid_by
       WHERE o.status = 'paid' AND date(o.paid_at) = ?
       GROUP BY o.paid_by ORDER BY amount DESC`
    )
    .all(date)
    .map((r) => ({ ...r }));
  const cancelled = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled' AND date(created_at) = ?")
    .get(date).n;
  return { date, ...totals, byMethod, byCashier, topItems, cancelled };
}

// ---------- Login, sessions, users ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, s.token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(sha256(token), Date.now());
  return row ? { ...row } : null;
}

const cookieHeader = (token, maxAge) =>
  `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// Slow down password guessing: 5 wrong tries from one address locks it for a minute.
const failedLogins = new Map();
function checkLoginLock(ip) {
  const rec = failedLogins.get(ip);
  if (rec && rec.until > Date.now()) {
    throw new HttpError(429, 'Too many wrong attempts. Wait a minute and try again.');
  }
}
function recordLoginFailure(ip) {
  const rec = failedLogins.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.count = 0;
    rec.until = Date.now() + 60_000;
  }
  failedLogins.set(ip, rec);
}

function login(body, ip) {
  checkLoginLock(ip);
  const username = cleanText(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(ip);
    throw new HttpError(401, 'Wrong username or password');
  }
  failedLogins.delete(ip);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    user.id,
    Date.now() + SESSION_HOURS * 3600_000
  );
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  return pw;
}

function changeOwnPassword(session, body) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.id);
  if (typeof body.current !== 'string' || !verifyPassword(body.current, user.password_hash)) {
    throw new HttpError(400, 'Current password is wrong');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validPassword(body.next)), user.id);
  // Sign out every other device.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, session.token_hash);
  return { ok: true };
}

function listUsers() {
  return db
    .prepare('SELECT id, username, role, active, created_at FROM users ORDER BY id')
    .all()
    .map((u) => ({ ...u }));
}

function createUser(body) {
  const username = cleanText(body.username);
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
    throw new HttpError(400, 'Username: 3-30 letters, numbers, dot, dash or underscore');
  }
  const role = body.role === 'admin' ? 'admin' : 'cashier';
  const password = validPassword(body.password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw new HttpError(409, 'That username is taken');
  }
  const id = Number(
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      username,
      hashPassword(password),
      role
    ).lastInsertRowid
  );
  return listUsers().find((u) => u.id === id);
}

function updateUser(id, body, session) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'User not found');
  const role = body.role === undefined ? user.role : body.role === 'admin' ? 'admin' : 'cashier';
  const active = body.active === undefined ? user.active : body.active ? 1 : 0;
  if (id === session.id && (!active || role !== 'admin')) {
    throw new HttpError(400, 'You cannot deactivate or demote your own account');
  }
  const wasActiveAdmin = user.role === 'admin' && user.active === 1;
  const stillActiveAdmin = role === 'admin' && active === 1;
  if (wasActiveAdmin && !stillActiveAdmin) {
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(id).n;
    if (others === 0) throw new HttpError(400, 'There must be at least one active admin');
  }
  const hash = body.password === undefined ? user.password_hash : hashPassword(validPassword(body.password));
  db.prepare('UPDATE users SET role = ?, active = ?, password_hash = ? WHERE id = ?').run(role, active, hash, id);
  // New password, role change or deactivation: force a fresh login.
  if (body.password !== undefined || !active || role !== user.role) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  return listUsers().find((u) => u.id === id);
}

// ---------- Routing ----------
async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;
  let m;

  // Public routes
  if (pathname === '/api/login' && method === 'POST') {
    const { token, user } = login(await readJson(req), req.socket.remoteAddress || 'unknown');
    return sendJson(res, 200, { user }, { 'Set-Cookie': cookieHeader(token, SESSION_HOURS * 3600) });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  // Everything below needs a logged-in user
  const session = getSession(req);
  if (!session) throw new HttpError(401, 'Please log in');
  const user = { id: session.id, username: session.username, role: session.role };
  const adminOnly = () => {
    if (user.role !== 'admin') throw new HttpError(403, 'Only an admin can do that');
  };

  if (pathname === '/api/me' && method === 'GET') return sendJson(res, 200, { user });
  if (pathname === '/api/me/password' && method === 'POST') {
    return sendJson(res, 200, changeOwnPassword(session, await readJson(req)));
  }

  if (pathname === '/api/users') {
    adminOnly();
    if (method === 'GET') return sendJson(res, 200, listUsers());
    if (method === 'POST') return sendJson(res, 201, createUser(await readJson(req)));
  }
  if ((m = pathname.match(/^\/api\/users\/(\d+)$/)) && method === 'PUT') {
    adminOnly();
    return sendJson(res, 200, updateUser(Number(m[1]), await readJson(req), session));
  }

  if (pathname === '/api/menu' && method === 'GET') return sendJson(res, 200, getMenu());

  if (pathname === '/api/categories' && method === 'POST') {
    adminOnly();
    return sendJson(res, 201, createCategory(await readJson(req)));
  }
  if ((m = pathname.match(/^\/api\/categories\/(\d+)$/)) && method === 'DELETE') {
    adminOnly();
    return sendJson(res, 200, deleteCategory(Number(m[1])));
  }

  if (pathname === '/api/items' && method === 'POST') {
    adminOnly();
    return sendJson(res, 201, createItem(await readJson(req)));
  }
  if ((m = pathname.match(/^\/api\/items\/(\d+)$/))) {
    if (method === 'PUT') {
      adminOnly();
      return sendJson(res, 200, updateItem(Number(m[1]), await readJson(req)));
    }
    if (method === 'DELETE') {
      adminOnly();
      return sendJson(res, 200, deleteItem(Number(m[1])));
    }
  }

  if (pathname === '/api/orders') {
    if (method === 'GET') return sendJson(res, 200, listOrders(searchParams.get('status')));
    if (method === 'POST') return sendJson(res, 201, createOrder(await readJson(req), user));
  }
  if ((m = pathname.match(/^\/api\/orders\/(\d+)$/))) {
    if (method === 'GET') return sendJson(res, 200, getOrder(Number(m[1])));
    if (method === 'PUT') return sendJson(res, 200, updateOrder(Number(m[1]), await readJson(req)));
  }
  if ((m = pathname.match(/^\/api\/orders\/(\d+)\/pay$/)) && method === 'POST') {
    return sendJson(res, 200, payOrder(Number(m[1]), await readJson(req), user));
  }
  if ((m = pathname.match(/^\/api\/orders\/(\d+)\/cancel$/)) && method === 'POST') {
    return sendJson(res, 200, cancelOrder(Number(m[1])));
  }

  if (pathname === '/api/reports/daily' && method === 'GET') {
    adminOnly();
    return sendJson(res, 200, dailyReport(searchParams.get('date') || todayLocal()));
  }

  throw new HttpError(404, 'Not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Restaurant POS running at http://localhost:${PORT}`);
  console.log(`Currency: ${CURRENCY}  |  Tax: ${TAX_PERCENT}%  |  Database: ${DB_FILE}`);
});
