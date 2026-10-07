'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let menu = { config: { currency: 'Rs', taxPercent: 0 }, categories: [] };
let activeCat = null;
const cart = new Map(); // item_id -> qty
let editingId = null;
let me = null; // logged-in user: { id, username, role }

const money = (n) => `${menu.config.currency} ${Number(n).toLocaleString()}`;

function itemById(id) {
  for (const c of menu.categories) for (const i of c.items) if (i.id === id) return i;
  return null;
}

let toastTimer;
function toast(msg, isError = false) {
  if (msg === 'Please log in') return; // the login screen is already showing
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin(); // session expired or signed out
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Wraps a click handler so errors show as a toast instead of failing silently.
const safe = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- Views ----------
const ADMIN_VIEWS = ['menu', 'reports', 'users'];

function showView(name) {
  if (ADMIN_VIEWS.includes(name) && me?.role !== 'admin') name = 'order';
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + name));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'open') renderOpen().catch((e) => toast(e.message, true));
  if (name === 'menu') renderMenuAdmin();
  if (name === 'reports') renderReports().catch((e) => toast(e.message, true));
  if (name === 'users') renderUsers().catch((e) => toast(e.message, true));
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
});

// ---------- Modal ----------
function showModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalBox').innerHTML = '';
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

// ---------- Order screen ----------
// Categories shown on the order screen: only those with at least one available item.
const orderCats = () => menu.categories.filter((c) => c.items.some((i) => i.available));

async function loadMenu() {
  menu = await api('/menu');
  const name = menu.config.restaurantName || 'Restaurant POS';
  document.title = name + ' POS';
  document.querySelectorAll('.topbar h1, .login-box h1').forEach((h) => (h.textContent = name));
  if (!orderCats().some((c) => c.id === activeCat)) activeCat = orderCats()[0]?.id ?? null;
  renderCats();
  renderItems();
  renderCart();
}

function renderCats() {
  $('#cats').innerHTML = orderCats()
    .map((c) => `<button data-cat="${c.id}" class="${c.id === activeCat ? 'active' : ''}">${esc(c.name)}</button>`)
    .join('');
}

function renderItems() {
  const cat = menu.categories.find((c) => c.id === activeCat);
  const items = cat ? cat.items.filter((i) => i.available) : [];
  $('#items').innerHTML = items.length
    ? items
        .map(
          (i) => `<button class="item-btn" data-item="${i.id}">
            <span>${esc(i.name)}</span><span class="price">${money(i.price)}</span></button>`
        )
        .join('')
    : '<div class="empty">No items in this category.</div>';
}

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  activeCat = Number(b.dataset.cat);
  renderCats();
  renderItems();
});

$('#items').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-item]');
  if (!b) return;
  const id = Number(b.dataset.item);
  cart.set(id, (cart.get(id) || 0) + 1);
  renderCart();
});

function calcTotals() {
  let subtotal = 0;
  for (const [id, qty] of cart) subtotal += (itemById(id)?.price || 0) * qty;
  const wanted = Math.max(parseInt($('#discount').value, 10) || 0, 0);
  const discount = Math.min(wanted, subtotal);
  const tax = Math.round(((subtotal - discount) * menu.config.taxPercent) / 100);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

function renderCart() {
  $('#cartTitle').textContent = editingId ? `Editing order #${editingId}` : 'New order';
  $('#cartLines').innerHTML = cart.size
    ? [...cart]
        .map(([id, qty]) => {
          const item = itemById(id);
          return `<div class="line">
            <span>${esc(item?.name || 'Item')}<br><span class="muted">${money(item?.price || 0)}</span></span>
            <span class="qty">
              <button data-dec="${id}">−</button><b>${qty}</b><button data-inc="${id}">+</button>
            </span>
            <b>${money((item?.price || 0) * qty)}</b>
          </div>`;
        })
        .join('')
    : '<div class="empty">Tap items to add them.</div>';

  const t = calcTotals();
  const taxRow = menu.config.taxPercent ? `<div><span>Tax (${menu.config.taxPercent}%)</span><span>${money(t.tax)}</span></div>` : '';
  $('#totals').innerHTML = `
    <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    ${t.discount ? `<div><span>Discount</span><span>− ${money(t.discount)}</span></div>` : ''}
    ${taxRow}
    <div class="grand"><span>Total</span><span>${money(t.total)}</span></div>`;
  $('#payBtn').disabled = $('#saveBtn').disabled = cart.size === 0;
  $('#table').disabled = $('#type').value === 'takeaway';
}

$('#cartLines').addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) {
    const id = Number(inc.dataset.inc);
    cart.set(id, cart.get(id) + 1);
  } else if (dec) {
    const id = Number(dec.dataset.dec);
    const q = cart.get(id) - 1;
    if (q <= 0) cart.delete(id);
    else cart.set(id, q);
  } else return;
  renderCart();
});

$('#discount').addEventListener('input', renderCart);
$('#type').addEventListener('change', renderCart);

function resetCart() {
  cart.clear();
  editingId = null;
  $('#table').value = '';
  $('#discount').value = 0;
  $('#type').value = 'dine-in';
  renderCart();
}
$('#clearBtn').addEventListener('click', resetCart);

async function persistOrder() {
  if (cart.size === 0) throw new Error('Add at least one item');
  const payload = {
    type: $('#type').value,
    table_no: $('#table').value,
    discount: parseInt($('#discount').value, 10) || 0,
    items: [...cart].map(([item_id, qty]) => ({ item_id, qty })),
  };
  return editingId ? api(`/orders/${editingId}`, 'PUT', payload) : api('/orders', 'POST', payload);
}

$('#saveBtn').addEventListener(
  'click',
  safe(async () => {
    const order = await persistOrder();
    toast(`Order #${order.id} saved`);
    resetCart();
    refreshOpenCount();
  })
);

$('#payBtn').addEventListener(
  'click',
  safe(async () => {
    const order = await persistOrder();
    resetCart();
    refreshOpenCount();
    openPayModal(order);
  })
);

// ---------- Payment + receipt ----------
function openPayModal(order) {
  showModal(`
    <h2>Pay order #${order.id}</h2>
    <div class="totals"><div class="grand"><span>Total due</span><span>${money(order.total)}</span></div></div>
    <div class="row">
      <select id="payMethod"><option value="cash">Cash</option><option value="card">Card</option></select>
    </div>
    <div class="row" id="cashRow"><input id="tendered" type="number" min="0" step="1" placeholder="Cash received (blank = exact)"></div>
    <div id="changeLine" class="muted"></div>
    <div class="row">
      <button id="payClose" class="ghost">Close</button>
      <button id="payConfirm" class="primary">Confirm payment</button>
    </div>`);

  const updateChange = () => {
    const v = parseInt($('#tendered').value, 10);
    $('#changeLine').textContent = v >= order.total ? `Change to return: ${money(v - order.total)}` : '';
  };
  $('#payMethod').addEventListener('change', () => {
    $('#cashRow').hidden = $('#payMethod').value !== 'cash';
    updateChange();
  });
  $('#tendered').addEventListener('input', updateChange);
  $('#payClose').addEventListener('click', closeModal);
  $('#payConfirm').addEventListener(
    'click',
    safe(async () => {
      const method = $('#payMethod').value;
      const raw = $('#tendered').value;
      const body = { method };
      if (method === 'cash' && raw !== '') body.tendered = Number(raw);
      const paid = await api(`/orders/${order.id}/pay`, 'POST', body);
      refreshOpenCount();
      if (!$('#view-open').hidden) renderOpen();
      showReceipt(paid);
    })
  );
}

function showReceipt(o) {
  const lines = o.items
    .map((i) => `<div class="r"><span>${i.qty} × ${esc(i.name)}</span><span>${money(i.price * i.qty)}</span></div>`)
    .join('');
  const p = o.payment;
  showModal(`
    <div class="receipt">
      <div class="center"><b>${esc((menu.config.restaurantName || 'RESTAURANT').toUpperCase())}</b><br>Order #${o.id}<br>${esc(o.paid_at || o.created_at)}<br>
        ${o.type === 'takeaway' ? 'Takeaway' : 'Table ' + esc(o.table_no)}
        ${o.paid_by_name ? '<br>Cashier: ' + esc(o.paid_by_name) : ''}</div>
      <hr>${lines}<hr>
      <div class="r"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
      ${o.discount ? `<div class="r"><span>Discount</span><span>− ${money(o.discount)}</span></div>` : ''}
      ${o.tax ? `<div class="r"><span>Tax</span><span>${money(o.tax)}</span></div>` : ''}
      <div class="r"><b>TOTAL</b><b>${money(o.total)}</b></div>
      ${
        p
          ? `<hr><div class="r"><span>Paid (${esc(p.method)})</span><span>${money(p.tendered)}</span></div>
             ${p.change_given ? `<div class="r"><span>Change</span><span>${money(p.change_given)}</span></div>` : ''}`
          : ''
      }
      <hr><div class="center">Thank you!</div>
    </div>
    <div class="row">
      <button id="rClose" class="ghost">Close</button>
      <button id="rPrint" class="primary">Print</button>
    </div>`);
  $('#rClose').addEventListener('click', closeModal);
  $('#rPrint').addEventListener('click', () => window.print());
}

// ---------- Open orders ----------
async function refreshOpenCount() {
  if (!me) return;
  try {
    const open = await api('/orders?status=open');
    const badge = $('#openCount');
    badge.textContent = open.length;
    badge.hidden = open.length === 0;
  } catch {
    /* ignore: badge is a convenience */
  }
}

async function renderOpen() {
  const orders = await api('/orders?status=open');
  const badge = $('#openCount');
  badge.textContent = orders.length;
  badge.hidden = orders.length === 0;
  $('#openList').innerHTML = orders.length
    ? orders
        .map(
          (o) => `<div class="card" data-order="${o.id}">
            <h3><span>#${o.id} · ${o.type === 'takeaway' ? 'Takeaway' : 'Table ' + esc(o.table_no)}</span><span>${money(o.total)}</span></h3>
            <div class="muted">${esc(o.created_at)}</div>
            <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>
            <div class="row">
              <button data-act="edit">Edit</button>
              <button data-act="pay" class="primary">Pay</button>
              <button data-act="cancel" class="danger">Cancel</button>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty">No open orders.</div>';
}

$('#openList').addEventListener(
  'click',
  safe(async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-order]').dataset.order);
    const order = await api(`/orders/${id}`);
    if (btn.dataset.act === 'pay') return openPayModal(order);
    if (btn.dataset.act === 'edit') {
      cart.clear();
      for (const i of order.items) cart.set(i.item_id, i.qty);
      editingId = id;
      $('#type').value = order.type;
      $('#table').value = order.table_no || '';
      $('#discount').value = order.discount;
      showView('order');
      renderCart();
      return;
    }
    if (btn.dataset.act === 'cancel') {
      if (!confirm(`Cancel order #${id}?`)) return;
      await api(`/orders/${id}/cancel`, 'POST');
      toast(`Order #${id} cancelled`);
      await renderOpen();
    }
  })
);

// ---------- Menu admin ----------
function renderMenuAdmin() {
  $('#itemCat').innerHTML = menu.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#menuAdmin').innerHTML = menu.categories
    .map(
      (c) => `<div class="cat-block">
        <h3>${esc(c.name)} <button class="small danger" data-delcat="${c.id}">Delete category</button></h3>
        ${
          c.items.length
            ? c.items
                .map(
                  (i) => `<div class="menu-row ${i.available ? '' : 'off'}" data-id="${i.id}">
                    <input class="name" value="${esc(i.name)}">
                    <input class="price" type="number" min="0" step="1" value="${i.price}">
                    <div class="row-actions">
                      <button class="small" data-act="save">Save</button>
                      <button class="small" data-act="toggle">${i.available ? 'Hide' : 'Show'}</button>
                      <button class="small danger" data-act="delete">Delete</button>
                    </div>
                  </div>`
                )
                .join('')
            : '<div class="empty">No items yet.</div>'
        }
      </div>`
    )
    .join('');
}

$('#catForm').addEventListener(
  'submit',
  safe(async (e) => {
    e.preventDefault();
    await api('/categories', 'POST', { name: $('#catName').value });
    $('#catName').value = '';
    await loadMenu();
    renderMenuAdmin();
    toast('Category added');
  })
);

$('#itemForm').addEventListener(
  'submit',
  safe(async (e) => {
    e.preventDefault();
    await api('/items', 'POST', {
      category_id: Number($('#itemCat').value),
      name: $('#itemName').value,
      price: Number($('#itemPrice').value),
    });
    $('#itemName').value = '';
    $('#itemPrice').value = '';
    await loadMenu();
    renderMenuAdmin();
    toast('Item added');
  })
);

$('#menuAdmin').addEventListener(
  'click',
  safe(async (e) => {
    const delCat = e.target.closest('[data-delcat]');
    if (delCat) {
      await api(`/categories/${delCat.dataset.delcat}`, 'DELETE');
      await loadMenu();
      renderMenuAdmin();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.menu-row');
    const id = Number(row.dataset.id);
    const item = itemById(id);
    if (btn.dataset.act === 'save') {
      await api(`/items/${id}`, 'PUT', { name: row.querySelector('.name').value, price: Number(row.querySelector('.price').value) });
      toast('Saved');
    } else if (btn.dataset.act === 'toggle') {
      await api(`/items/${id}`, 'PUT', { available: !item.available });
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`Delete "${item.name}"?`)) return;
      const r = await api(`/items/${id}`, 'DELETE');
      if (r.archived) toast('Used in past orders, so it was hidden instead');
    }
    await loadMenu();
    renderMenuAdmin();
  })
);

// ---------- Reports ----------
async function renderReports() {
  const date = $('#reportDate').value || new Date().toLocaleDateString('en-CA');
  $('#reportDate').value = date;
  const r = await api(`/reports/daily?date=${encodeURIComponent(date)}`);
  const table = (head, rows) =>
    rows.length
      ? `<table><thead><tr>${head.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
         <tbody>${rows.map((row) => `<tr>${row.map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nothing yet.</div>';
  $('#reportBody').innerHTML = `
    <div class="stats">
      <div class="stat">Sales<b>${money(r.revenue)}</b></div>
      <div class="stat">Paid orders<b>${r.orders}</b></div>
      <div class="stat">Discounts<b>${money(r.discounts)}</b></div>
      <div class="stat">Tax collected<b>${money(r.tax)}</b></div>
      <div class="stat">Cancelled<b>${r.cancelled}</b></div>
    </div>
    <h3>By payment method</h3>
    ${table(['Method', 'Orders', 'Amount'], r.byMethod.map((m) => [esc(m.method), m.orders, money(m.amount)]))}
    <h3>By cashier</h3>
    ${table(['Cashier', 'Orders', 'Amount'], (r.byCashier || []).map((c) => [esc(c.cashier), c.orders, money(c.amount)]))}
    <h3>Top items</h3>
    ${table(['Item', 'Qty', 'Sales'], r.topItems.map((i) => [esc(i.name), i.qty, money(i.amount)]))}`;
}
$('#reportDate').addEventListener('change', () => renderReports().catch((e) => toast(e.message, true)));

// ---------- Users (admin) ----------
async function renderUsers() {
  const users = await api('/users');
  $('#userList').innerHTML = users
    .map(
      (u) => `<div class="user-row" data-id="${u.id}">
        <div><b>${esc(u.username)}</b> <span class="pill">${esc(u.role)}</span>
          ${u.active ? '' : '<span class="pill off">disabled</span>'}</div>
        <button class="small" data-act="reset">Reset password</button>
        ${
          u.id === me.id
            ? '<span class="muted">(you)</span>'
            : `<button class="small ${u.active ? 'danger' : ''}" data-act="toggle" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>`
        }
      </div>`
    )
    .join('');
}

$('#userForm').addEventListener(
  'submit',
  safe(async (e) => {
    e.preventDefault();
    await api('/users', 'POST', { username: $('#newUser').value, password: $('#newPass').value, role: $('#newRole').value });
    $('#userForm').reset();
    toast('User added');
    await renderUsers();
  })
);

$('#userList').addEventListener(
  'click',
  safe(async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('.user-row').dataset.id);
    if (btn.dataset.act === 'reset') {
      const pw = prompt('New password (6+ characters):');
      if (!pw) return;
      await api(`/users/${id}`, 'PUT', { password: pw });
      toast('Password changed. That user must log in again.');
    } else {
      await api(`/users/${id}`, 'PUT', { active: btn.dataset.active !== '1' });
    }
    await renderUsers();
  })
);

// ---------- Login / logout / password ----------
function showLogin() {
  me = null;
  document.body.classList.add('logged-out');
  closeModal();
  $('#loginPass').value = '';
  $('#loginError').hidden = true;
  $('#loginUser').focus();
}

async function enterApp(user) {
  me = user;
  document.body.classList.remove('logged-out');
  $('#who').textContent = `${me.username} (${me.role})`;
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = me.role !== 'admin'));
  resetCart();
  await loadMenu();
  showView('order');
  refreshOpenCount();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/login', 'POST', { username: $('#loginUser').value, password: $('#loginPass').value });
    $('#loginUser').value = '';
    $('#loginPass').value = '';
    await enterApp(user);
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').hidden = false;
  }
});

$('#logoutBtn').addEventListener(
  'click',
  safe(async () => {
    await api('/logout', 'POST');
    showLogin();
  })
);

$('#pwBtn').addEventListener('click', () => {
  showModal(`
    <h2>Change password</h2>
    <div class="row"><input id="pwCurrent" type="password" placeholder="Current password" autocomplete="current-password"></div>
    <div class="row"><input id="pwNext" type="password" placeholder="New password (6+ characters)" autocomplete="new-password"></div>
    <div class="row">
      <button id="pwCancel" class="ghost">Cancel</button>
      <button id="pwSave" class="primary">Save</button>
    </div>`);
  $('#pwCancel').addEventListener('click', closeModal);
  $('#pwSave').addEventListener(
    'click',
    safe(async () => {
      await api('/me/password', 'POST', { current: $('#pwCurrent').value, next: $('#pwNext').value });
      closeModal();
      toast('Password changed');
    })
  );
});

// ---------- Start ----------
(async () => {
  try {
    const { user } = await api('/me');
    await enterApp(user);
  } catch {
    showLogin();
  }
})();
setInterval(refreshOpenCount, 20000);
