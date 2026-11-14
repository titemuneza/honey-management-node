'use strict';

/* =========================================================================
   Honey Management System - frontend (vanilla JS, no build step)
   ========================================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const state = { user: null, currency: 'USD' };

/* ---------- safe HTML templating ----------------------------------------
   html`...` escapes every interpolated value unless it is itself html`...`
   or raw(...). This keeps user-entered text from ever becoming markup.      */
class Safe { constructor(s) { this.s = s; } }
const raw = (s) => new Safe(String(s));
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const part = (v) => {
  if (v === false || v === null || v === undefined) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
};
const html = (strings, ...values) =>
  new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''));
const render = (el, safe) => { el.innerHTML = safe.s; };

/* ---------- formatting -------------------------------------------------- */
let moneyFmt = null;
const fmt = (n) => {
  if (!moneyFmt) {
    try { moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency }); }
    catch { moneyFmt = { format: (v) => `${state.currency} ${Number(v).toFixed(2)}` }; }
  }
  return moneyFmt.format(Number(n) || 0);
};
const num = (n) => new Intl.NumberFormat().format(Number(n) || 0);
const when = (s) => (s || '').slice(0, 16);
const label = (s) => String(s || '').replace(/_/g, ' ');

/* ---------- API --------------------------------------------------------- */
async function api(path, { method = 'GET', body } = {}) {
  const options = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try { response = await fetch('/api' + path, options); }
  catch { throw new Error('Cannot reach the server. Check your connection.'); }
  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }
  if (response.status === 401 && path !== '/login') { showLogin(); throw new Error('Please sign in'); }
  if (!response.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

/* ---------- toasts & modals --------------------------------------------- */
function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}

function closeModal() { $$('.overlay').forEach((el) => el.remove()); }

function openModal(title, body, { wide = false } = {}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  render(overlay, html`
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head"><h2>${title}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close" data-noprint>&times;</button></div>
      <div class="modal-body">${body}</div>
    </div>`);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.body.appendChild(overlay);
  const first = $('input:not([type=hidden]), select, textarea', overlay);
  if (first) first.focus();
  return overlay;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ---------- forms ------------------------------------------------------- */
function fieldHtml(f, values) {
  const value = values[f.key] ?? f.default ?? '';
  const required = f.required ? raw(' required') : '';
  const attrs = raw(f.attrs ? ' ' + f.attrs : '');
  let input;
  if (f.type === 'select') {
    input = html`<select name="${f.key}"${required}>${f.options.map((o) =>
      html`<option value="${o.value}"${raw(String(o.value) === String(value) ? ' selected' : '')}>${o.label}</option>`)}</select>`;
  } else if (f.type === 'textarea') {
    input = html`<textarea name="${f.key}" rows="3"${required}>${value}</textarea>`;
  } else {
    input = html`<input name="${f.key}" type="${f.type || 'text'}" value="${value}"${required}${attrs}${f.autocomplete ? raw(` autocomplete="${f.autocomplete}"`) : ''}>`;
  }
  return html`<label class="field${f.full ? ' full' : ''}"><span>${f.label}${f.required ? raw('<em aria-hidden="true">*</em>') : ''}</span>${input}${f.hint ? html`<small>${f.hint}</small>` : ''}</label>`;
}

function modalForm({ title, fields, values = {}, submitLabel = 'Save', onSubmit, wide = false }) {
  const overlay = openModal(title, html`
    <form novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="form-grid">${fields.map((f) => fieldHtml(f, values))}</div>
      <div class="form-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">${submitLabel}</button>
      </div>
    </form>`, { wide });
  const form = $('form', overlay);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const errorBox = $('.form-error', form);
    const button = $('button[type=submit]', form);
    errorBox.hidden = true;
    button.disabled = true;
    const data = {};
    new FormData(form).forEach((v, k) => { data[k] = v; });
    try {
      await onSubmit(data);
      closeModal();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  });
}

/* =========================================================================
   Login & shell
   ========================================================================= */
function showLogin() {
  closeModal();
  state.user = null;
  render($('#app'), html`
    <main class="login-wrap">
      <form class="login-card" id="login-form">
        <div class="brand">${logo()}<span>Honey Management</span></div>
        <p class="muted">Sign in to manage stock, sales and customers.</p>
        <div class="form-error" role="alert" hidden></div>
        <label class="field"><span>Username</span><input name="username" autocomplete="username" required autofocus></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </main>`);
  const form = $('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('.form-error', form);
    const button = $('button', form);
    errorBox.hidden = true;
    button.disabled = true;
    try {
      const data = await api('/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } });
      state.user = data.user;
      state.currency = data.currency;
      moneyFmt = null;
      location.hash = '#/dashboard';
      startApp();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  });
}

function logo() {
  return raw('<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2l12 7v14l-12 7L4 23V9z" fill="#e8a317"/><path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="#fff8ea"/></svg>');
}

const NAV = [
  ['dashboard', 'Dashboard'],
  ['sales', 'Sales'],
  ['products', 'Products'],
  ['stock', 'Stock & batches'],
  ['customers', 'Customers'],
  ['suppliers', 'Suppliers'],
  ['reports', 'Reports'],
  ['users', 'Users', 'admin'],
  ['database', 'Database', 'admin'],
];

function startApp() {
  const items = NAV.filter(([, , role]) => !role || role === state.user.role);
  render($('#app'), html`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">${logo()}<span>Honey Management</span></div>
        <nav class="nav" aria-label="Main">${items.map(([id, text]) =>
          html`<a href="#/${id}" data-nav="${id}">${text}</a>`)}</nav>
        <div class="sidebar-foot">
          <div class="who">${state.user.full_name || state.user.username}</div>
          <div class="role">${state.user.role}</div>
          <button class="link-btn" data-action="password">Change password</button>
          <button class="link-btn" data-action="logout">Sign out</button>
        </div>
      </aside>
      <main class="main" id="main" tabindex="-1"></main>
    </div>`);
  $('.sidebar-foot').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'logout') {
      try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
      showLogin();
    } else if (action === 'password') {
      changePassword();
    }
  });
  route();
}

function changePassword() {
  modalForm({
    title: 'Change password',
    fields: [
      { key: 'current_password', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { key: 'new_password', label: 'New password', type: 'password', required: true, full: true, hint: 'At least 8 characters', autocomplete: 'new-password' },
    ],
    onSubmit: async (data) => {
      await api('/change-password', { method: 'POST', body: data });
      toast('Password updated');
    },
  });
}

/* ---------- router ------------------------------------------------------ */
const pages = {};
async function route() {
  if (!state.user) return;
  closeModal();
  let name = location.hash.replace(/^#\//, '') || 'dashboard';
  if (!pages[name] || (name === 'users' && state.user.role !== 'admin')) name = 'dashboard';
  $$('.nav a').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const main = $('#main');
  main.onclick = null;
  render(main, html`<p class="loading">Loading…</p>`);
  try {
    await pages[name](main);
  } catch (err) {
    if (state.user) render(main, html`<div class="card"><h2>Something went wrong</h2><p>${err.message}</p><button class="btn" data-retry>Try again</button></div>`);
    const retry = $('[data-retry]', main);
    if (retry) retry.addEventListener('click', route);
  }
}
window.addEventListener('hashchange', route);

/* =========================================================================
   Dashboard
   ========================================================================= */
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function revenueChart(daily) {
  const W = 640, H = 250, pad = { l: 48, r: 8, t: 12, b: 30 };
  const max = niceMax(Math.max(...daily.map((d) => d.revenue), 1));
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bw = iw / daily.length;
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sales for the last 14 days">`;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ih - (ih * i) / 4;
    svg += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
    svg += `<text class="axis-text" x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${esc(compact.format((max * i) / 4))}</text>`;
  }
  daily.forEach((d, i) => {
    const h = (d.revenue / max) * ih;
    const x = pad.l + i * bw + bw * 0.16;
    const date = new Date(d.date + 'T00:00:00');
    const tip = `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${fmt(d.revenue)} (${d.orders} order${d.orders === 1 ? '' : 's'})`;
    svg += `<rect class="bar" x="${x}" y="${pad.t + ih - h}" width="${bw * 0.68}" height="${Math.max(h, d.revenue > 0 ? 2 : 0)}" rx="3"><title>${esc(tip)}</title></rect>`;
    if (i % 2 === 0 || daily.length < 8) {
      svg += `<text class="axis-text" x="${x + bw * 0.34}" y="${H - 10}" text-anchor="middle">${date.getDate()}</text>`;
    }
  });
  return raw(svg + '</svg>');
}

pages.dashboard = async (main) => {
  const d = await api('/dashboard');
  const maxStock = Math.max(...d.stock_levels.map((p) => p.stock), 1);
  const topMax = Math.max(...d.top_products.map((p) => p.revenue), 1);
  const hasSales = d.daily.some((x) => x.revenue > 0);
  render(main, html`
    <header class="page-head">
      <div><h1>Dashboard</h1><p class="muted">Welcome back, ${state.user.full_name || state.user.username}.</p></div>
      <div class="actions"><button class="btn primary" data-action="new-sale">New sale</button></div>
    </header>
    <section class="kpis">
      <div class="kpi"><div class="label">Sales today</div><div class="value">${fmt(d.today.revenue)}</div><div class="sub">${d.today.orders} order${d.today.orders === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="label">Sales this month</div><div class="value">${fmt(d.month.revenue)}</div><div class="sub">${d.month.orders} order${d.month.orders === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="label">Stock value</div><div class="value">${fmt(d.counts.stock_value)}</div><div class="sub">${num(d.counts.units_in_stock)} units across ${d.counts.products} products</div></div>
      <div class="kpi ${d.low_stock.length ? 'warn' : ''}"><div class="label">Low stock</div><div class="value">${d.low_stock.length}</div><div class="sub">${d.low_stock.length ? 'products need restocking' : 'everything is well stocked'}</div></div>
    </section>
    <section class="grid-2">
      <div class="card"><h2>Sales, last 14 days</h2>${hasSales ? revenueChart(d.daily) : html`<p class="empty">No sales in the last 14 days yet.</p>`}</div>
      <div class="card"><h2>Top products (30 days)</h2>
        ${d.top_products.length ? html`<ul class="hbars">${d.top_products.map((p) => html`
          <li><div class="row"><span>${p.name}</span><span class="val">${fmt(p.revenue)} · ${num(p.units)} sold</span></div>
          <div class="track"><div class="fill" style="width:${Math.max(3, (p.revenue / topMax) * 100)}%"></div></div></li>`)}</ul>`
          : html`<p class="empty">Top sellers will appear after your first sales.</p>`}
      </div>
    </section>
    <section class="grid-2 even">
      <div class="card"><h2>Stock levels</h2>
        ${d.stock_levels.length ? html`<ul class="hbars">${d.stock_levels.map((p) => html`
          <li><div class="row"><span>${p.name}</span><span class="val">${num(p.stock)} in stock</span></div>
          <div class="track"><div class="fill ${p.stock <= p.low_stock_threshold ? 'low' : ''}" style="width:${Math.max(p.stock > 0 ? 3 : 0, (p.stock / maxStock) * 100)}%"></div></div></li>`)}</ul>`
          : html`<p class="empty">No products yet. <a href="#/products">Add your first product</a>.</p>`}
      </div>
      <div class="card"><h2>Low-stock alerts</h2>
        ${d.low_stock.length ? html`<ul class="alert-list">${d.low_stock.map((p) => html`
          <li><span>${p.name}${p.unit ? ` (${p.unit})` : ''}</span><span>${p.stock} left · alert at ${p.low_stock_threshold}</span></li>`)}</ul>
          <p style="margin:12px 0 0"><a href="#/stock">Receive stock</a></p>`
          : html`<p class="all-good">All products are above their low-stock level.</p>`}
      </div>
    </section>
    <section class="card"><h2>Recent sales</h2>
      ${d.recent_sales.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Payment</th><th class="num">Total</th></tr></thead>
        <tbody>${d.recent_sales.map((s) => html`<tr><td>${s.id}</td><td>${when(s.created_at)}</td><td>${s.customer_name || 'Walk-in'}</td><td>${label(s.payment_method)}</td><td class="num">${fmt(s.total)}${s.status === 'void' ? html` <span class="badge void">void</span>` : ''}</td></tr>`)}</tbody>
      </table></div><p style="margin:12px 0 0"><a href="#/sales">View all sales</a></p>` : html`<p class="empty">No sales recorded yet.</p>`}
    </section>`);
  main.onclick = (e) => {
    if (e.target.closest('[data-action="new-sale"]')) newSale(route);
  };
};

/* =========================================================================
   Generic list page (products, customers, suppliers)
   ========================================================================= */
async function crudPage(main, cfg) {
  const isAdmin = state.user.role === 'admin';
  let items = [], query = '';
  render(main, html`
    <header class="page-head">
      <div><h1>${cfg.title}</h1><p class="muted">${cfg.subtitle}</p></div>
      <div class="actions"><button class="btn primary" data-action="add">Add ${cfg.singular}</button></div>
    </header>
    <div class="card">
      <div class="toolbar"><input type="search" class="search" placeholder="Search ${cfg.title.toLowerCase()}…" aria-label="Search ${cfg.title.toLowerCase()}"></div>
      <div class="table-wrap" id="list"></div>
    </div>`);
  const listEl = $('#list', main);

  const draw = () => render(listEl, items.length ? html`
    <table>
      <thead><tr>${cfg.columns.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.label}</th>`)}<th></th></tr></thead>
      <tbody>${items.map((item) => html`<tr>
        ${cfg.columns.map((c) => html`<td class="${c.num ? 'num' : ''}">${c.render ? c.render(item) : (item[c.key] ?? '')}</td>`)}
        <td class="row-actions">
          ${(cfg.rowActions || []).map((a) => html`<button class="btn small" data-action="${a.action}" data-id="${item.id}">${a.label}</button>`)}
          <button class="btn small" data-action="edit" data-id="${item.id}">Edit</button>
          ${isAdmin ? html`<button class="btn small danger" data-action="delete" data-id="${item.id}">Delete</button>` : ''}
        </td></tr>`)}</tbody>
    </table>` : html`<p class="empty">${query ? 'Nothing matches your search.' : cfg.empty}</p>`);

  const load = async () => {
    const data = await api(`${cfg.endpoint}${query ? '?q=' + encodeURIComponent(query) : ''}`);
    items = data.items;
    draw();
  };

  const form = (item) => modalForm({
    title: item ? `Edit ${cfg.singular}` : `Add ${cfg.singular}`,
    fields: cfg.fields,
    values: item || {},
    onSubmit: async (data) => {
      await api(item ? `${cfg.endpoint}/${item.id}` : cfg.endpoint, { method: item ? 'PUT' : 'POST', body: data });
      toast(`${cfg.singular[0].toUpperCase()}${cfg.singular.slice(1)} saved`);
      await load();
    },
  });

  let timer;
  $('.search', main).addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = e.target.value.trim(); load().catch((err) => toast(err.message, 'error')); }, 250);
  });

  main.onclick = async (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const item = items.find((i) => String(i.id) === button.dataset.id);
    const action = button.dataset.action;
    try {
      if (action === 'add') form(null);
      else if (action === 'edit' && item) form(item);
      else if (action === 'delete' && item) {
        if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
        await api(`${cfg.endpoint}/${item.id}`, { method: 'DELETE' });
        toast(`${cfg.singular[0].toUpperCase()}${cfg.singular.slice(1)} deleted`);
        await load();
      } else if (item && cfg.onAction) await cfg.onAction(action, item, load);
    } catch (err) { toast(err.message, 'error'); }
  };
  await load();
}

pages.products = (main) => crudPage(main, {
  title: 'Products', singular: 'product', endpoint: '/products',
  subtitle: 'Honey varieties, jar sizes and prices.',
  empty: 'No products yet. Add your first honey product to start tracking stock and sales.',
  columns: [
    { label: 'Product', key: 'name', render: (p) => html`<strong>${p.name}</strong>` },
    { label: 'Honey type', key: 'honey_type' },
    { label: 'Size', key: 'unit' },
    { label: 'Price', num: true, render: (p) => fmt(p.price) },
    { label: 'In stock', num: true, render: (p) => html`${num(p.stock)} ${p.low ? html`<span class="badge low">Low</span>` : html`<span class="badge ok">OK</span>`}` },
    { label: 'Alert at', key: 'low_stock_threshold', num: true },
  ],
  fields: [
    { key: 'name', label: 'Product name', required: true, full: true },
    { key: 'honey_type', label: 'Honey type', hint: 'e.g. Wildflower, Acacia' },
    { key: 'unit', label: 'Size / unit', hint: 'e.g. 500g jar' },
    { key: 'price', label: 'Selling price', type: 'number', required: true, attrs: 'min="0" step="0.01"' },
    { key: 'low_stock_threshold', label: 'Low-stock alert level', type: 'number', default: 10, attrs: 'min="0" step="1"', hint: 'Warn when stock falls to this number' },
  ],
  rowActions: [{ action: 'receive', label: 'Receive stock' }],
  onAction: (action, item, reload) => { if (action === 'receive') return receiveStock({ product_id: item.id }, reload); },
});

pages.customers = (main) => crudPage(main, {
  title: 'Customers', singular: 'customer', endpoint: '/customers',
  subtitle: 'People and businesses you sell to.',
  empty: 'No customers yet. Add customers to attach them to sales and track orders.',
  columns: [
    { label: 'Name', key: 'name', render: (c) => html`<strong>${c.name}</strong>` },
    { label: 'Phone', key: 'phone' },
    { label: 'Email', key: 'email' },
    { label: 'Address', key: 'address' },
  ],
  fields: [
    { key: 'name', label: 'Name', required: true, full: true },
    { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: 'Address', type: 'textarea', full: true },
  ],
});

pages.suppliers = (main) => crudPage(main, {
  title: 'Suppliers', singular: 'supplier', endpoint: '/suppliers',
  subtitle: 'Beekeepers, apiaries and cooperatives you buy honey from.',
  empty: 'No suppliers yet. Add the beekeepers you buy from to trace each batch.',
  columns: [
    { label: 'Name', key: 'name', render: (s) => html`<strong>${s.name}</strong>` },
    { label: 'Phone', key: 'phone' },
    { label: 'Location', key: 'location' },
    { label: 'Notes', key: 'notes' },
  ],
  fields: [
    { key: 'name', label: 'Name', required: true, full: true },
    { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'location', label: 'Location' },
    { key: 'notes', label: 'Notes', type: 'textarea', full: true },
  ],
});

/* =========================================================================
   Stock & batches
   ========================================================================= */
async function receiveStock(preset, done) {
  const [{ items: products }, { items: suppliers }] = await Promise.all([api('/products'), api('/suppliers')]);
  if (!products.length) { toast('Add a product first, then receive stock for it.', 'error'); return; }
  modalForm({
    title: 'Receive stock',
    submitLabel: 'Add to stock',
    values: preset,
    fields: [
      { key: 'product_id', label: 'Product', type: 'select', required: true, full: true,
        options: products.map((p) => ({ value: p.id, label: `${p.name}${p.unit ? ' (' + p.unit + ')' : ''} - ${p.stock} in stock` })) },
      { key: 'quantity', label: 'Quantity received', type: 'number', required: true, attrs: 'min="1" step="1"' },
      { key: 'cost_per_unit', label: 'Cost per unit', type: 'number', default: 0, attrs: 'min="0" step="0.01"' },
      { key: 'supplier_id', label: 'Supplier', type: 'select',
        options: [{ value: '', label: 'None / own production' }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))] },
      { key: 'harvest_date', label: 'Harvest date', type: 'date' },
      { key: 'batch_code', label: 'Batch code', hint: 'Leave blank to generate one' },
      { key: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    onSubmit: async (data) => {
      const saved = await api('/stock', { method: 'POST', body: data });
      toast(`Added ${saved.quantity} × ${saved.product_name} (batch ${saved.batch_code})`);
      if (done) await done();
    },
  });
}

async function editStock(entry, done) {
  const { items: suppliers } = await api('/suppliers');
  modalForm({
    title: `Edit batch: ${entry.product_name}`,
    values: entry,
    fields: [
      { key: 'quantity', label: 'Quantity received', type: 'number', required: true, attrs: 'min="1" step="1"', hint: 'Changing this adjusts the product stock by the difference' },
      { key: 'cost_per_unit', label: 'Cost per unit', type: 'number', attrs: 'min="0" step="0.01"' },
      { key: 'supplier_id', label: 'Supplier', type: 'select',
        options: [{ value: '', label: 'None / own production' }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))] },
      { key: 'harvest_date', label: 'Harvest date', type: 'date' },
      { key: 'batch_code', label: 'Batch code', full: true },
      { key: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    onSubmit: async (data) => {
      await api(`/stock/${entry.id}`, { method: 'PUT', body: data });
      toast('Batch updated');
      if (done) await done();
    },
  });
}

pages.stock = async (main) => {
  const isAdmin = state.user.role === 'admin';
  let entries = [];
  const draw = () => render($('#list', main), entries.length ? html`<table>
    <thead><tr><th>Received</th><th>Batch</th><th>Product</th><th>Supplier</th><th class="num">Qty</th><th class="num">Cost / unit</th><th>Harvested</th><th></th></tr></thead>
    <tbody>${entries.map((s) => html`<tr>
      <td>${when(s.created_at)}</td><td>${s.batch_code}</td><td><strong>${s.product_name}</strong></td><td>${s.supplier_name || '—'}</td>
      <td class="num">${num(s.quantity)}</td><td class="num">${fmt(s.cost_per_unit)}</td><td>${s.harvest_date || '—'}</td>
      <td class="row-actions"><button class="btn small" data-edit="${s.id}">Edit</button>
        ${isAdmin ? html`<button class="btn small danger" data-delete="${s.id}">Delete</button>` : ''}</td></tr>`)}</tbody>
  </table>` : html`<p class="empty">No stock received yet. Use “Receive stock” when a new batch arrives.</p>`);
  const load = async () => { entries = (await api('/stock')).items; draw(); };
  render(main, html`
    <header class="page-head">
      <div><h1>Stock & batches</h1><p class="muted">Every batch received, with its supplier and harvest date. Editing or deleting a batch adjusts product stock.</p></div>
      <div class="actions"><button class="btn primary" data-action="receive">Receive stock</button></div>
    </header>
    <div class="card"><div class="table-wrap" id="list"></div></div>`);
  main.onclick = async (e) => {
    try {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-delete]');
      if (e.target.closest('[data-action="receive"]')) await receiveStock({}, load);
      else if (edit) await editStock(entries.find((s) => String(s.id) === edit.dataset.edit), load);
      else if (del) {
        const entry = entries.find((s) => String(s.id) === del.dataset.delete);
        if (!confirm(`Delete batch ${entry.batch_code} (${entry.quantity} × ${entry.product_name})? Stock will be reduced by that amount.`)) return;
        await api(`/stock/${entry.id}`, { method: 'DELETE' });
        toast('Batch deleted');
        await load();
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  await load();
};

/* =========================================================================
   Sales
   ========================================================================= */
const PAYMENTS = [['cash', 'Cash'], ['mobile_money', 'Mobile money'], ['card', 'Card'], ['bank_transfer', 'Bank transfer']];

async function newSale(done, existing = null) {
  let products, customers;
  try {
    [{ items: products }, { items: customers }] = await Promise.all([api('/products'), api('/customers')]);
  } catch (err) { toast(err.message, 'error'); return; }

  // When editing, the sale's own items count as available again, at the price they were sold for.
  const held = {}, heldPrice = {};
  if (existing) existing.items.forEach((i) => { held[i.product_id] = i.quantity; heldPrice[i.product_id] = i.unit_price; });
  const stockOf = (p) => p.stock + (held[p.id] || 0);
  const priceOf = (p) => (heldPrice[p.id] !== undefined ? heldPrice[p.id] : p.price);
  const available = products.filter((p) => stockOf(p) > 0);
  if (!available.length) { toast('Nothing in stock to sell yet. Receive stock first.', 'error'); return; }

  const line = (preset) => html`<div class="sale-line">
    <select name="product" aria-label="Product">${available.map((p) =>
      html`<option value="${p.id}" data-price="${priceOf(p)}" data-stock="${stockOf(p)}"${raw(preset && String(preset.product_id) === String(p.id) ? ' selected' : '')}>${p.name}${p.unit ? ' (' + p.unit + ')' : ''} · ${fmt(priceOf(p))} · ${stockOf(p)} left</option>`)}</select>
    <input name="qty" type="number" min="1" step="1" value="${preset ? preset.quantity : 1}" aria-label="Quantity">
    <span class="line-total"></span>
    <button type="button" class="icon-btn" data-remove aria-label="Remove line">&times;</button>
  </div>`;

  const overlay = openModal(existing ? `Edit sale #${existing.id}` : 'New sale', html`
    <form novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="form-grid">
        <label class="field"><span>Customer</span><select name="customer_id"><option value="">Walk-in customer</option>${customers.map((c) =>
          html`<option value="${c.id}"${raw(existing && String(existing.customer_id) === String(c.id) ? ' selected' : '')}>${c.name}</option>`)}</select></label>
        <label class="field"><span>Payment method</span><select name="payment_method">${PAYMENTS.map(([v, t]) =>
          html`<option value="${v}"${raw(existing && existing.payment_method === v ? ' selected' : '')}>${t}</option>`)}</select></label>
      </div>
      <div id="lines">${existing ? existing.items.map((i) => line(i)) : line()}</div>
      <button type="button" class="btn small" data-add-line>+ Add another product</button>
      <div class="sale-total"><span>Total</span><span id="grand">${fmt(0)}</span></div>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${existing ? 'Save changes' : 'Record sale'}</button></div>
    </form>`, { wide: true });

  const form = $('form', overlay);
  const linesEl = $('#lines', overlay);
  const recalc = () => {
    let total = 0;
    $$('.sale-line', linesEl).forEach((row) => {
      const option = $('select', row).selectedOptions[0];
      const qtyInput = $('input', row);
      qtyInput.max = option.dataset.stock;
      const qty = Math.max(0, parseInt(qtyInput.value, 10) || 0);
      const lineTotal = qty * Number(option.dataset.price);
      total += lineTotal;
      $('.line-total', row).textContent = fmt(lineTotal);
    });
    $('#grand', overlay).textContent = fmt(total);
  };
  recalc();
  form.addEventListener('input', recalc);
  form.addEventListener('change', recalc);
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-line]')) {
      linesEl.insertAdjacentHTML('beforeend', line().s);
      recalc();
    } else if (e.target.closest('[data-remove]')) {
      if ($$('.sale-line', linesEl).length > 1) { e.target.closest('.sale-line').remove(); recalc(); }
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('.form-error', form);
    const button = $('button[type=submit]', form);
    errorBox.hidden = true;
    button.disabled = true;
    const items = $$('.sale-line', linesEl).map((row) => ({ product_id: $('select', row).value, quantity: $('input', row).value }));
    try {
      const sale = await api(existing ? `/sales/${existing.id}` : '/sales', {
        method: existing ? 'PUT' : 'POST',
        body: { customer_id: form.customer_id.value || null, payment_method: form.payment_method.value, items },
      });
      toast(existing ? `Sale #${sale.id} updated` : `Sale #${sale.id} recorded: ${fmt(sale.total)}`);
      showSale(sale, done);
      if (done) done();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  });
}

function showSale(sale, done) {
  const isAdmin = state.user.role === 'admin';
  const isVoid = sale.status === 'void';
  const overlay = openModal(`Sale #${sale.id}`, html`
    <div class="receipt">
      <dl>
        <dt>Date</dt><dd>${when(sale.created_at)}</dd>
        <dt>Customer</dt><dd>${sale.customer_name || 'Walk-in customer'}</dd>
        <dt>Payment</dt><dd>${label(sale.payment_method)}</dd>
        <dt>Served by</dt><dd>${sale.served_by || '—'}</dd>
        <dt>Status</dt><dd>${isVoid ? html`<span class="badge void">void</span>` : html`<span class="badge ok">completed</span>`}</dd>
      </dl>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
        <tbody>${sale.items.map((i) => html`<tr><td>${i.product_name}${i.unit ? ` (${i.unit})` : ''}</td><td class="num">${i.quantity}</td><td class="num">${fmt(i.unit_price)}</td><td class="num">${fmt(i.line_total)}</td></tr>`)}</tbody>
      </table></div>
      <div class="sale-total"><span>Total</span><span>${fmt(sale.total)}</span></div>
      <div class="form-actions" data-noprint>
        ${isAdmin ? html`<button class="btn danger" data-delete>Delete</button>` : ''}
        ${isAdmin && !isVoid ? html`<button class="btn danger" data-void>Void</button>` : ''}
        ${isVoid ? '' : html`<button class="btn" data-edit>Edit</button>`}
        <button class="btn" data-print>Print</button>
        <button class="btn primary" data-close>Done</button>
      </div>
    </div>`);
  $('[data-print]', overlay).addEventListener('click', () => window.print());
  const on = (selector, handler) => { const el = $(selector, overlay); if (el) el.addEventListener('click', handler); };
  on('[data-edit]', () => { closeModal(); newSale(done, sale); });
  on('[data-void]', async () => {
    if (!confirm(`Void sale #${sale.id}? It stays on record, and stock is returned to inventory.`)) return;
    try {
      await api(`/sales/${sale.id}/void`, { method: 'POST' });
      toast(`Sale #${sale.id} voided`);
      closeModal();
      if (done) done();
    } catch (err) { toast(err.message, 'error'); }
  });
  on('[data-delete]', async () => {
    if (!confirm(`Permanently delete sale #${sale.id}?${isVoid ? '' : ' Stock will be returned to inventory.'} This cannot be undone.`)) return;
    try {
      await api(`/sales/${sale.id}`, { method: 'DELETE' });
      toast(`Sale #${sale.id} deleted`);
      closeModal();
      if (done) done();
    } catch (err) { toast(err.message, 'error'); }
  });
}

pages.sales = async (main) => {
  const isAdmin = state.user.role === 'admin';
  let from = '', to = '';
  const load = async () => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const { items } = await api('/sales' + (params.toString() ? '?' + params : ''));
    const total = items.filter((s) => s.status === 'completed').reduce((sum, s) => sum + s.total, 0);
    $('#sales-total', main).textContent = items.length ? `${items.length} sale${items.length === 1 ? '' : 's'} · ${fmt(total)} completed` : '';
    render($('#list', main), items.length ? html`<table>
      <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Payment</th><th class="num">Units</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${items.map((s) => html`<tr>
        <td>${s.id}</td><td>${when(s.created_at)}</td><td>${s.customer_name || 'Walk-in'}</td><td>${label(s.payment_method)}</td>
        <td class="num">${num(s.units)}</td><td class="num">${fmt(s.total)}</td>
        <td>${s.status === 'void' ? html`<span class="badge void">void</span>` : html`<span class="badge ok">completed</span>`}</td>
        <td class="row-actions"><button class="btn small" data-view="${s.id}">View</button>
          ${s.status === 'void' ? '' : html`<button class="btn small" data-edit="${s.id}">Edit</button>`}
          ${isAdmin ? html`<button class="btn small danger" data-delete="${s.id}">Delete</button>` : ''}</td></tr>`)}</tbody>
    </table>` : html`<p class="empty">No sales found. Record one with “New sale”.</p>`);
  };
  render(main, html`
    <header class="page-head">
      <div><h1>Sales</h1><p class="muted">Every sale, edit or deletion updates stock automatically.</p></div>
      <div class="actions"><button class="btn primary" data-action="new-sale">New sale</button></div>
    </header>
    <div class="card">
      <div class="toolbar">
        <label>From <input type="date" id="from" style="width:auto"></label>
        <label>To <input type="date" id="to" style="width:auto"></label>
        <span class="muted" id="sales-total"></span>
      </div>
      <div class="table-wrap" id="list"></div>
    </div>`);
  const filter = () => { from = $('#from', main).value; to = $('#to', main).value; load().catch((e) => toast(e.message, 'error')); };
  $('#from', main).addEventListener('change', filter);
  $('#to', main).addEventListener('change', filter);
  main.onclick = async (e) => {
    if (e.target.closest('[data-action="new-sale"]')) { newSale(load); return; }
    const view = e.target.closest('[data-view]');
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    try {
      if (view) showSale(await api(`/sales/${view.dataset.view}`), load);
      else if (edit) newSale(load, await api(`/sales/${edit.dataset.edit}`));
      else if (del) {
        const id = del.dataset.delete;
        if (!confirm(`Permanently delete sale #${id}? Stock will be returned to inventory if it was completed. This cannot be undone.`)) return;
        await api(`/sales/${id}`, { method: 'DELETE' });
        toast(`Sale #${id} deleted`);
        await load();
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  await load();
};

/* =========================================================================
   Reports
   ========================================================================= */
pages.reports = async (main) => {
  render(main, html`
    <header class="page-head"><div><h1>Reports</h1><p class="muted">Download your data as CSV files that open in Excel or Google Sheets.</p></div></header>
    <section class="report-grid">
      <div class="card"><h2>Sales</h2><p>Every sale line by date, customer, product and payment method.</p>
        <div class="range"><label class="field"><span>From</span><input type="date" id="r-from"></label><label class="field"><span>To</span><input type="date" id="r-to"></label></div>
        <a class="btn primary" id="r-sales" href="/api/reports/sales.csv" download>Download sales CSV</a></div>
      <div class="card"><h2>Inventory</h2><p>Current stock, value and low-stock status for each product.</p>
        <a class="btn primary" href="/api/reports/inventory.csv" download>Download inventory CSV</a></div>
      <div class="card"><h2>Batches received</h2><p>All stock-in batches with suppliers, costs and harvest dates.</p>
        <a class="btn primary" href="/api/reports/stock-in.csv" download>Download batches CSV</a></div>
      <div class="card"><h2>Customers</h2><p>Customer contacts with their order counts and total spending.</p>
        <a class="btn primary" href="/api/reports/customers.csv" download>Download customers CSV</a></div>
    </section>`);
  const update = () => {
    const params = new URLSearchParams();
    if ($('#r-from', main).value) params.set('from', $('#r-from', main).value);
    if ($('#r-to', main).value) params.set('to', $('#r-to', main).value);
    $('#r-sales', main).href = '/api/reports/sales.csv' + (params.toString() ? '?' + params : '');
  };
  $('#r-from', main).addEventListener('change', update);
  $('#r-to', main).addEventListener('change', update);
};

/* =========================================================================
   Users (admin only)
   ========================================================================= */
pages.users = async (main) => {
  let users = [];
  const draw = () => render($('#list', main), html`<table>
    <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${users.map((u) => html`<tr>
      <td><strong>${u.username}</strong>${u.id === state.user.id ? html` <span class="badge">you</span>` : ''}</td>
      <td>${u.full_name || '—'}</td><td>${u.role}</td>
      <td>${u.active ? html`<span class="badge ok">active</span>` : html`<span class="badge void">disabled</span>`}</td>
      <td class="row-actions"><button class="btn small" data-edit="${u.id}">Edit</button>
        ${u.id === state.user.id ? '' : html`<button class="btn small danger" data-delete="${u.id}">Delete</button>`}</td></tr>`)}</tbody>
  </table>`);
  const load = async () => { users = (await api('/users')).items; draw(); };
  const roleOptions = [{ value: 'staff', label: 'Staff - can sell and manage stock' }, { value: 'admin', label: 'Admin - full access' }];

  render(main, html`
    <header class="page-head">
      <div><h1>Users</h1><p class="muted">Admins manage everything; staff can sell and manage stock but cannot delete records or manage users.</p></div>
      <div class="actions"><button class="btn primary" data-action="add">Add user</button></div>
    </header>
    <div class="card"><div class="table-wrap" id="list"></div></div>`);

  main.onclick = async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    try {
      if (e.target.closest('[data-action="add"]')) {
        modalForm({
          title: 'Add user',
          fields: [
            { key: 'username', label: 'Username', required: true, autocomplete: 'off', hint: 'Letters, numbers, . _ -' },
            { key: 'full_name', label: 'Full name' },
            { key: 'role', label: 'Role', type: 'select', options: roleOptions, full: true },
            { key: 'password', label: 'Temporary password', type: 'password', required: true, full: true, autocomplete: 'new-password', hint: 'At least 8 characters' },
          ],
          onSubmit: async (data) => { await api('/users', { method: 'POST', body: data }); toast('User created'); await load(); },
        });
      } else if (edit) {
        const user = users.find((u) => String(u.id) === edit.dataset.edit);
        modalForm({
          title: `Edit ${user.username}`,
          values: { ...user, active: user.active ? '1' : '0' },
          fields: [
            { key: 'full_name', label: 'Full name', full: true },
            { key: 'role', label: 'Role', type: 'select', options: roleOptions },
            { key: 'active', label: 'Status', type: 'select', options: [{ value: '1', label: 'Active' }, { value: '0', label: 'Disabled' }] },
            { key: 'password', label: 'New password', type: 'password', full: true, autocomplete: 'new-password', hint: 'Leave blank to keep the current password' },
          ],
          onSubmit: async (data) => {
            const body = { full_name: data.full_name, role: data.role, active: data.active === '1' };
            if (data.password) body.password = data.password;
            await api(`/users/${user.id}`, { method: 'PUT', body });
            toast('User updated');
            await load();
          },
        });
      } else if (del) {
        const user = users.find((u) => String(u.id) === del.dataset.delete);
        if (!confirm(`Delete user "${user.username}"? Their past sales stay on record.`)) return;
        await api(`/users/${user.id}`, { method: 'DELETE' });
        toast('User deleted');
        await load();
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  await load();
};

/* =========================================================================
   Database overview (admin only)
   ========================================================================= */
pages.database = async (main) => {
  const d = await api('/database');
  const size = d.size_bytes >= 1048576 ? `${(d.size_bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(d.size_bytes / 1024))} KB`;
  render(main, html`
    <header class="page-head"><div><h1>Database</h1><p class="muted">${d.engine} · database <strong>${d.file}</strong> · ${size}</p></div></header>
    <section class="card" style="margin-bottom:14px">
      <h2>How the app uses the database</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>CRUD</th><th>SQL statement</th><th>Where in the app</th></tr></thead>
        <tbody>
          <tr><td><strong>Create</strong></td><td><code>INSERT</code></td><td>Add product / customer / supplier / user, receive stock, record a sale</td></tr>
          <tr><td><strong>Read</strong></td><td><code>SELECT</code></td><td>Every list, search, receipt, dashboard figure and CSV report</td></tr>
          <tr><td><strong>Update</strong></td><td><code>UPDATE</code></td><td>Edit buttons on every page; stock changes after each sale or batch edit</td></tr>
          <tr><td><strong>Delete</strong></td><td><code>DELETE</code></td><td>Delete buttons (admin); records with history are protected</td></tr>
        </tbody>
      </table></div>
      <p class="muted" style="margin-top:10px">The full table definitions are in <code>database.sql</code>.</p>
    </section>
    <section class="db-grid">${d.tables.map((t) => html`
      <div class="card"><h2>${t.name} <span class="badge">${num(t.rows)} row${t.rows === 1 ? '' : 's'}</span></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Column</th><th>Type</th><th>Notes</th></tr></thead>
          <tbody>${t.columns.map((c) => html`<tr><td>${c.name}</td><td>${c.type}</td><td>${c.pk ? 'primary key' : c.required ? 'required' : ''}</td></tr>`)}</tbody>
        </table></div></div>`)}</section>`);
};

/* =========================================================================
   Boot
   ========================================================================= */
(async function boot() {
  try {
    const data = await api('/me');
    state.user = data.user;
    state.currency = data.currency;
    startApp();
  } catch {
    if (!state.user) showLogin();
  }
})();
