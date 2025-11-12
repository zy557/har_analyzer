const state = {
  entries: [],
  filtered: [],
  selectedId: null,
  total: 0,
  offset: 0,
  limit: 200,
  filters: { q: '', domain: '', priority: '', method: '', type: '', statusMin: '', statusMax: '' },
  loading: false,
  sortKey: 'started_ms',
  sortOrder: 'asc',
  groupBy: 'none',
  wfRects: new Map(),
  wfMin: 0,
  wfMax: 0,
  wfDragging: false,
  wfLastX: 0,
  wfSelRange: null,
  selectedIds: [],
  wfRowH: 16,
  wfStartRow: 0,
  lastSelectedIndex: null,
};

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

async function fetchStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();
    $('#stats').innerHTML = `<div>总请求: ${s.count} | 总大小: ${formatBytes(s.totalSize)} | 总耗时: ${Math.round(s.totalTime)}ms</div>`;
    renderSelectionStats();
  } catch {}
}

async function loadEntries(reset = true) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.entries = [];
  }
  const params = new URLSearchParams();
  params.set('offset', state.offset);
  params.set('limit', state.limit);
  const { q, domain, priority, method, type, statusMin, statusMax } = state.filters;
  if (q) params.set('q', q);
  if (domain) params.set('domain', domain);
  if (priority) params.set('priority', priority);
  if (method) params.set('method', method);
  if (type) params.set('type', type);
  if (statusMin) params.set('statusMin', statusMin);
  if (statusMax) params.set('statusMax', statusMax);
  const res = await fetch(`/api/entries?${params.toString()}`);
  const data = await res.json();
  state.total = data.total || 0;
  const page = data.entries || [];
  state.entries = reset ? page : state.entries.concat(page);
  state.filtered = state.entries.slice();
  state.offset += page.length;
  renderList2();
  renderWaterfallCanvas();
  fetchStats();
  state.loading = false;
}

function renderList() {
  const ul = $('#entryList');
  ul.innerHTML = '';
  state.filtered
    .sort(sortComparator())
    .forEach(e => {
      const li = document.createElement('li');
      li.className = 'entry-item';
      li.innerHTML = `
        <span class="pill method mono">${e.method}</span>
        <span class="url" title="${e.url}">${e.url}</span>
        <span class="pill status mono">${e.status}</span>
        <span class="meta mono">${Math.round(e.time)} ms | ${e.mimeType || ''}</span>
      `;
      li.addEventListener('click', () => selectEntry(e.id));
      ul.appendChild(li);
    });
  maybeLoadMore();
}

function renderList2() {
  const ul = $('#entryList');
  ul.innerHTML = '';
  const list = state.filtered.slice().sort(sortComparator());
  const grouped = groupEntries(list);
  const renderedIds = [];
  grouped.forEach(item => {
    if (item.__group) {
      const gh = document.createElement('li');
      gh.className = 'group-header';
      gh.textContent = item.label;
      ul.appendChild(gh);
      return;
    }
    const li = document.createElement('li');
    li.className = 'entry-item';
    li.innerHTML = `
      <span class="pill method mono">${item.method}</span>
      <span class="url" title="${item.url}">${item.url}</span>
      <span class="pill status mono">${item.status}</span>
      <span class="meta mono">${Math.round(item.time)} ms | ${item.mimeType || ''}</span>
    `;
    const idx = renderedIds.length; renderedIds.push(item.id);
    li.addEventListener('click', (e) => {
      if (e.shiftKey && state.lastSelectedIndex != null) {
        const start = Math.min(state.lastSelectedIndex, idx);
        const end = Math.max(state.lastSelectedIndex, idx);
        state.selectedIds = renderedIds.slice(start, end + 1);
        state.selectedId = item.id;
        state.lastSelectedIndex = idx;
        renderList2();
        renderWaterfallCanvas();
      } else if (e.ctrlKey || e.metaKey) {
        const set = new Set(state.selectedIds || []);
        if (set.has(item.id)) set.delete(item.id); else set.add(item.id);
        state.selectedIds = Array.from(set);
        state.selectedId = item.id;
        state.lastSelectedIndex = idx;
        renderList2();
        renderWaterfallCanvas();
      } else {
        state.selectedId = item.id;
        state.selectedIds = [item.id];
        state.lastSelectedIndex = idx;
        selectEntry(item.id);
      }
    });
    if (item.id === state.selectedId || (state.selectedIds && state.selectedIds.includes(item.id))) {
      li.classList.add('selected');
    }
    ul.appendChild(li);
  });
  maybeLoadMore();
  renderSelectionStats();
}

async function selectEntry(id) {
  state.selectedId = id;
  const res = await fetch(`/api/entries/${id}`);
  const data = await res.json();
  renderTabs(data);
  // 同步列表与瀑布图高亮
  renderList2();
  renderWaterfallCanvas();
  // 确保选中项在侧栏可视区域
  const listEls = $all('#entryList .entry-item');
  const list = state.filtered.slice().sort(sortComparator());
  const idx = list.findIndex(e => e.id === id);
  if (idx >= 0 && listEls[idx]) listEls[idx].scrollIntoView({ block: 'nearest' });
  renderSelectionStats();
}

function renderTabs(detail) {
  $all('.tab-btn').forEach(btn => btn.classList.remove('active'));
  $all('.tab-content').forEach(c => c.classList.remove('active'));
  $('#tab-headers').classList.add('active');
  $all('.tab-btn').find(b => b.dataset.tab === 'headers').classList.add('active');

  // Headers
  const hdrs = [];
  const reqH = detail.request.headers || [];
  const respH = detail.response.headers || [];
  hdrs.push(`<h3>Request Headers</h3>`);
  reqH.forEach(h => hdrs.push(kv(h.name, h.value)));
  hdrs.push(`<h3>Response Headers</h3>`);
  respH.forEach(h => hdrs.push(kv(h.name, h.value)));
  $('#tab-headers').innerHTML = hdrs.join('');

  // Request
  const rq = detail.request;
  const rqHtml = [];
  rqHtml.push(kv('URL', rq.url));
  rqHtml.push(kv('Method', rq.method));
  rqHtml.push(kv('HTTP Version', rq.httpVersion));
  rqHtml.push(kv('Query', JSON.stringify(rq.queryString || [], null, 2)));
  rqHtml.push(kv('Cookies', JSON.stringify(rq.cookies || [], null, 2)));
  rqHtml.push(kv('Post Data', rq.postData ? JSON.stringify(rq.postData, null, 2) : ''));
  $('#tab-request').innerHTML = rqHtml.join('');

  // Response
  const rs = detail.response;
  const rsHtml = [];
  rsHtml.push(kv('Status', `${rs.status} ${rs.statusText || ''}`));
  rsHtml.push(kv('HTTP Version', rs.httpVersion));
  rsHtml.push(kv('Cookies', JSON.stringify(rs.cookies || [], null, 2)));
  rsHtml.push(kv('Content-Type', (rs.content && rs.content.mimeType) || ''));
  rsHtml.push(kv('Body Size', rs.bodySize));
  // Body preview (image/text)
  rsHtml.push(`<div id="resp-body"></div>`);
  $('#tab-response').innerHTML = rsHtml.join('');
  renderResponseBody(detail.summary.id);

  // Timing
  const tm = detail.timings || {};
  const tmHtml = [];
  Object.keys(tm).forEach(k => tmHtml.push(kv(k, `${tm[k]} ms`)));
  tmHtml.push(kv('Total', `${Math.round(detail.time || 0)} ms`));
  $('#tab-timing').innerHTML = tmHtml.join('');
  // 接收字节图
  const hs = detail.response.headersSize ?? 0;
  const bs = detail.response.bodySize ?? 0;
  const cs = (detail.response.content && detail.response.content.size) ?? 0;
  const sum = Math.max(hs + bs, cs);
  const pct = v => (sum ? Math.round((v / sum) * 100) : 0);
  const bytesHtml = `<div class="mono">接收字节图 (headers/body/content)：${hs} / ${bs} / ${cs}</div>`
    + `<div style="height:12px;background:#f3f4f6;border-radius:4px;overflow:hidden;margin-top:4px;display:flex;">`
    + `<span style="width:${pct(hs)}%;background:#60a5fa"></span>`
    + `<span style="width:${pct(bs)}%;background:#34d399"></span>`
    + `<span style="width:${pct(cs)}%;background:#f59e0b"></span>`
    + `</div>`;
  $('#tab-timing').insertAdjacentHTML('beforeend', bytesHtml);

  // Cookies
  const ckHtml = [];
  ckHtml.push(`<h3>Request Cookies</h3>`);
  (rq.cookies || []).forEach(c => ckHtml.push(kv(c.name, c.value)));
  ckHtml.push(`<h3>Response Cookies</h3>`);
  (rs.cookies || []).forEach(c => ckHtml.push(kv(c.name, c.value)));
  $('#tab-cookies').innerHTML = ckHtml.join('');
}

function kv(k, v) {
  return `<div class="kv"><div class="mono">${escapeHtml(k)}</div><div class="mono">${escapeHtml(String(v ?? ''))}</div></div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[s]));
}

function renderWaterfall() {
  const container = $('#waterfall');
  container.innerHTML = '';
  if (!state.filtered.length) return;

  const maxEnd = Math.max(...state.filtered.map(e => (e.started_ms + (e.time || 0))));
  state.filtered.forEach(e => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const percentStart = (e.started_ms / maxEnd) * 100;
    const percentWidth = ((e.time || 0) / maxEnd) * 100;
    bar.style.paddingLeft = percentStart + '%';

    const segs = e.timingSegments || {};
    const total = Object.values(segs).reduce((a,b)=>a+(b||0), 0) || (e.time || 0);
    const addSeg = (name, val) => {
      const span = document.createElement('span');
      span.className = `seg-${name}`;
      span.style.width = ((val / total) * percentWidth) + '%';
      bar.appendChild(span);
    };
    ['blocked','dns','connect','ssl','send','wait','receive'].forEach(k => addSeg(k, segs[k] || 0));
    container.appendChild(bar);
  });
}

function bindTabs() {
  $all('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $all('.tab-btn').forEach(b => b.classList.remove('active'));
      $all('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.dataset.tab;
      $(`#tab-${id}`).classList.add('active');
    });
  });
}

function bindUpload() {
  $('#uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#fileInput').files[0];
    if (!file) return alert('请选择 .har 文件');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    // After upload, reload with pagination
    state.offset = 0;
    await loadEntries(true);
  });
  $('#loadSampleBtn').addEventListener('click', async () => {
    const res = await fetch('/api/load-sample');
    const data = await res.json();
    state.offset = 0;
    await loadEntries(true);
  });
}

function bindSearch() {
  $('#searchInput').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    state.offset = 0;
    loadEntries(true);
  });
  $('#domainInput').addEventListener('input', (e) => {
    state.filters.domain = e.target.value.trim();
    state.offset = 0;
    loadEntries(true);
  });
  $('#priorityInput').addEventListener('input', (e) => {
    state.filters.priority = e.target.value.trim();
    state.offset = 0;
    loadEntries(true);
  });
  const mSel = document.getElementById('methodSelect');
  if (mSel) mSel.addEventListener('change', (e) => {
    state.filters.method = e.target.value;
    state.offset = 0;
    loadEntries(true);
  });
  const tSel = document.getElementById('typeSelect');
  if (tSel) tSel.addEventListener('change', (e) => {
    state.filters.type = e.target.value;
    state.offset = 0;
    loadEntries(true);
  });
  const sMin = document.getElementById('statusMin');
  if (sMin) sMin.addEventListener('input', (e) => {
    state.filters.statusMin = e.target.value;
    state.offset = 0;
    loadEntries(true);
  });
  const sMax = document.getElementById('statusMax');
  if (sMax) sMax.addEventListener('input', (e) => {
    state.filters.statusMax = e.target.value;
    state.offset = 0;
    loadEntries(true);
  });
  const gSel = document.getElementById('groupSelect');
  if (gSel) gSel.addEventListener('change', (e) => {
    state.groupBy = e.target.value;
    renderList2();
    renderWaterfallCanvas();
  });
  const sortSel = document.getElementById('sortSelect');
  if (sortSel) sortSel.addEventListener('change', (e) => {
    state.sortKey = e.target.value;
    renderList2();
    renderWaterfallCanvas();
  });
  const orderSel = document.getElementById('orderSelect');
  if (orderSel) orderSel.addEventListener('change', (e) => {
    state.sortOrder = e.target.value;
    renderList2();
    renderWaterfallCanvas();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindUpload();
  bindSearch();
  await loadEntries(true);
  bindInfiniteScroll();
  bindKeyboard();
  renderWaterfallCanvas();
});

function maybeLoadMore() {
  // If list has fewer than total and not loading, fetch more
  if (state.entries.length < state.total && !state.loading) {
    const sidebar = document.querySelector('.sidebar');
    const nearBottom = sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 200;
    if (nearBottom) loadEntries(false);
  }
}

function bindInfiniteScroll() {
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('scroll', () => {
    maybeLoadMore();
  });
}

async function renderResponseBody(id) {
  const r = await fetch(`/api/entries/${id}/body`);
  const data = await r.json();
  const container = document.getElementById('resp-body');
  const dl = `<a class="mono" href="/api/entries/${id}/download" target="_blank">下载响应体</a>`;
  if (data.dataUrl) {
    container.innerHTML = `${dl}<br/><img src="${data.dataUrl}" alt="image preview"/>` + (data.truncated ? '<div class="mono">[预览已截断]</div>' : '');
  } else if (data.previewText) {
    const mime = state.entries.find(e => e.id === id)?.mimeType || '';
    if (mime.includes('json')) {
      container.innerHTML = `${dl}` + highlightJson(data.previewText) + (data.truncated ? '<div class="mono">[预览已截断]</div>' : '');
    } else {
      container.innerHTML = `${dl}<pre class="mono code">${escapeHtml(data.previewText)}</pre>` + (data.truncated ? '<div class="mono">[预览已截断]</div>' : '');
    }
  } else {
    container.innerHTML = `${dl}<div class="mono">无可预览的响应体</div>`;
  }
}

function highlightJson(text) {
  try {
    const obj = JSON.parse(text);
    const json = JSON.stringify(obj, null, 2);
    const html = json
      .replace(/(&)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"(.*?)\"(?=\s*:)/g, '<span class="hl-key">"$1"</span>')
      .replace(/:\s*\"([^\"]*)\"/g, ': <span class="hl-string">"$1"</span>')
      .replace(/:\s*(\d+(?:\.\d+)?)/g, ': <span class="hl-number">$1</span>')
      .replace(/:\s*(true|false)/g, ': <span class="hl-bool">$1</span>')
      .replace(/:\s*(null)/g, ': <span class="hl-null">$1</span>');
    return `<pre class="mono code">${html}</pre>`;
  } catch {
    return `<pre class="mono code">${escapeHtml(text)}</pre>`;
  }
}

function sortComparator() {
  const key = state.sortKey;
  const order = state.sortOrder === 'asc' ? 1 : -1;
  return (a, b) => {
    const va = a[key] || 0; const vb = b[key] || 0;
    return va === vb ? 0 : (va < vb ? -order : order);
  };
}

function groupEntries(list) {
  if (state.groupBy === 'none') return list;
  const keyFn = state.groupBy === 'domain'
    ? (e) => { try { return new URL(e.url).host || ''; } catch { return ''; } }
    : (e) => e.resourceType || '';
  const map = new Map();
  list.forEach(e => {
    const k = keyFn(e) || '(unknown)';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  });
  const out = [];
  for (const [k, arr] of map.entries()) {
    out.push({ __group: true, label: `${k} (${arr.length})` });
    out.push(...arr);
  }
  return out;
}

function renderWaterfallCanvas() {
  const canvas = document.getElementById('waterfallCanvas');
  const ruler = document.getElementById('waterfallRuler');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const pad = 8;
  const list = state.filtered.slice().sort(sortComparator());
  const totalRows = list.length;
  // 固定高度视口：按当前 CSS 高度作为可视窗口，仅绘制窗口内的行
  const viewH = canvas.clientHeight || 240;
  const minRowH = Math.max(4, Math.floor((viewH - pad * 2) / Math.max(1, totalRows)));
  const vZoomEl = document.getElementById('wfVZoom');
  const zoomVal = vZoomEl ? parseInt(vZoomEl.value || '16') : (state.wfRowH || 16);
  const zoomMin = vZoomEl ? parseInt(vZoomEl.min || '8') : 8;
  const rowH = (vZoomEl && zoomVal === zoomMin) ? minRowH : zoomVal;
  const maxVisible = Math.max(1, Math.floor((viewH - pad * 2) / rowH));
  const vScrollEl = document.getElementById('wfVScroll');
  const vRatio = vScrollEl ? (parseInt(vScrollEl.value || '0') / 100) : 0;
  const startIndex = Math.min(Math.max(0, Math.floor((totalRows - maxVisible) * vRatio)), Math.max(0, totalRows - maxVisible));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(viewH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, canvas.height / dpr);

  const maxEnd = Math.max(...list.map(e => (e.started_ms + (e.time || 0))), 0);
  if (state.wfMax <= 0) { state.wfMin = 0; state.wfMax = maxEnd || 1; }
  const t2x = (t) => {
    const span = state.wfMax - state.wfMin || 1;
    return ((t - state.wfMin) / span) * width;
  };
  const wfRects = new Map();
  list.slice(startIndex, startIndex + maxVisible).forEach((e, i) => {
    const y = pad + i * rowH;
    // background
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, y, width, rowH - 2);
    // bar
    const xStart = t2x(e.started_ms);
    const xEnd = t2x(e.started_ms + (e.time || 0));
    const wTotal = Math.max(0, xEnd - xStart);
    const segs = e.timingSegments || {};
    const total = Object.values(segs).reduce((a,b)=>a+(b||0),0) || (e.time || 0);
    const palette = { blocked: '#d1d5db', dns: '#f59e0b', connect: '#22c55e', ssl: '#7c3aed', send: '#3b82f6', wait: '#f97316', receive: '#10b981' };
    let offset = 0;
    ['blocked','dns','connect','ssl','send','wait','receive'].forEach(k => {
      const segW = (total ? (segs[k] || 0) / total : 0) * wTotal;
      ctx.fillStyle = palette[k];
      ctx.fillRect(xStart + offset, y, segW, rowH - 2);
      offset += segW;
    });
    wfRects.set(e.id, { x: xStart, y, w: wTotal, h: rowH - 2, segs, total });
    if (e.id === state.selectedId || (state.selectedIds && state.selectedIds.includes(e.id))) {
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.strokeRect(xStart, y, wTotal, rowH - 2);
    }
  });
  state.wfRects = wfRects;
  // ruler（自适应刻度 + 可点击）
  ruler.innerHTML = '';
  const tickList = computeTicks(state.wfMin, state.wfMax, 8);
  tickList.forEach((t, i) => {
    const spanEl = document.createElement('span');
    spanEl.textContent = Math.round(t) + 'ms';
    spanEl.dataset.time = String(t);
    spanEl.style.cursor = 'pointer';
    spanEl.style.marginRight = '8px';
    spanEl.addEventListener('click', () => selectNearestAtTime(t));
    ruler.appendChild(spanEl);
    if (i < tickList.length - 1) { const sep = document.createElement('span'); sep.textContent = '|'; sep.style.margin = '0 4px'; ruler.appendChild(sep); }
  });
  // 同步水平滑动条位置
  const hScrollEl = document.getElementById('wfHScroll');
  const span = (state.wfMax - state.wfMin) || 1;
  if (hScrollEl && maxEnd > span) {
    const maxMin = Math.max(0, maxEnd - span);
    const val = Math.round((state.wfMin / maxMin) * 100);
    hScrollEl.value = String(Math.max(0, Math.min(100, val)));
  }

  // click select
  canvas.onclick = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
    const ctx2 = canvas.getContext('2d');
    renderWaterfallCanvas();
    for (const [id, r] of state.wfRects.entries()) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        selectEntry(id);
        ctx2.strokeStyle = '#111827'; ctx2.lineWidth = 2; ctx2.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }
    }
  };

  // hover tooltip
  const tip = document.getElementById('wfTooltip');
  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
    let found = null;
    for (const [id, r] of state.wfRects.entries()) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { found = { id, r }; break; }
    }
    if (found) {
      const segs = found.r.segs || {};
      const rowsHtml = ['blocked','dns','connect','ssl','send','wait','receive'].map(k =>
        `<div class="row"><span class="label">${k}</span><span class="value">${Math.round(segs[k]||0)} ms</span></div>`
      ).join('');
      tip.innerHTML = rowsHtml + `<div class="row"><span class="label">total</span><span class="value">${Math.round(found.r.total||0)} ms</span></div>`;
      tip.style.left = (ev.clientX - rect.left + 12) + 'px';
      tip.style.top = (ev.clientY - rect.top + 12) + 'px';
      tip.style.display = 'block';
    } else {
      tip.style.display = 'none';
    }
  };
  canvas.onmouseleave = () => { const tip2 = document.getElementById('wfTooltip'); tip2.style.display = 'none'; };

  // zoom & wheel pan
  canvas.onwheel = (ev) => {
    ev.preventDefault();
    const span2 = (state.wfMax - state.wfMin) || 1;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const cursorTime = state.wfMin + ((x / width) * span2);
    if (ev.ctrlKey) { selectPrevNext(ev.deltaY > 0 ? 1 : -1); return; }
    if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      const shift = (ev.deltaX / width) * span2;
      let newMin = Math.max(0, state.wfMin + shift);
      let newMax = Math.min(maxEnd, state.wfMax + shift);
      const win = newMax - newMin; if (win < 50) { newMax = newMin + 50; }
      state.wfMin = newMin; state.wfMax = newMax;
      renderWaterfallCanvas();
      return;
    }
    const factor = ev.deltaY < 0 ? 0.9 : 1.11;
    const newSpan = Math.max(50, span2 * factor);
    const half = newSpan / 2;
    let newMin = Math.max(0, cursorTime - half);
    let newMax = Math.min(maxEnd, cursorTime + half);
    if (newMax - newMin < 50) { newMax = newMin + 50; }
    state.wfMin = newMin; state.wfMax = newMax;
    renderWaterfallCanvas();
  };

  // pan (drag)
  canvas.onmousedown = (ev) => { state.wfDragging = true; state.wfLastX = ev.clientX; };
  window.onmouseup = () => { state.wfDragging = false; };
  window.onmousemove = (ev) => {
    if (!state.wfDragging) return;
    const dx = ev.clientX - state.wfLastX; state.wfLastX = ev.clientX;
    const span3 = (state.wfMax - state.wfMin) || 1;
    const shift = (dx / width) * span3;
    let newMin = Math.max(0, state.wfMin - shift);
    let newMax = Math.min(maxEnd, state.wfMax - shift);
    const win = newMax - newMin; if (win < 50) { newMax = newMin + 50; }
    state.wfMin = newMin; state.wfMax = newMax;
    renderWaterfallCanvas();
  };

  // range highlight
  if (state.wfSelRange) {
    const sel = state.wfSelRange;
    const ctx2 = canvas.getContext('2d');
    ctx2.save();
    ctx2.strokeStyle = '#ef4444';
    ctx2.lineWidth = 2;
    state.selectedIds = [];
    for (const [id, r] of state.wfRects.entries()) {
      const s = state.wfMin + ((r.x / width) * ((state.wfMax - state.wfMin) || 1));
      const e = s + ((r.w / width) * ((state.wfMax - state.wfMin) || 1));
      const overlap = (e >= sel.min) && (s <= sel.max);
      if (overlap) { ctx2.strokeRect(r.x, r.y, r.w, r.h); state.selectedIds.push(id); }
    }
    ctx2.restore();
  }
  renderSelectionStats();
}

function selectNearestAtTime(t) {
  // 在时间 t 处选择覆盖该时间的条目，否则选最近开始的条目
  let best = null; let bestDist = Infinity;
  state.filtered.forEach(e => {
    const s = e.started_ms; const eEnd = e.started_ms + (e.time || 0);
    if (t >= s && t <= eEnd) { best = e; bestDist = 0; }
    const d = Math.abs(s - t); if (d < bestDist) { best = e; bestDist = d; }
  });
  if (best) selectEntry(best.id);
}

function computeTicks(min, max, target) {
  const span = Math.max(1, max - min);
  const rough = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const base = rough / pow;
  const niceBase = base < 1.5 ? 1 : base < 3 ? 2 : base < 7 ? 5 : 10;
  const step = niceBase * pow;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let t = start; t <= max + 1e-6; t += step) ticks.push(t);
  return ticks.length ? ticks : [min, max];
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const span = (state.wfMax - state.wfMin) || 1;
    const panDelta = span * 0.1; // 10% 微移
    if (e.key === 'ArrowLeft') {
      state.wfMin = Math.max(0, state.wfMin - panDelta);
      state.wfMax = Math.max(state.wfMin + 50, state.wfMax - panDelta);
      renderWaterfallCanvas();
    } else if (e.key === 'ArrowRight') {
      state.wfMin = Math.min(state.wfMin + panDelta, state.wfMax - 50);
      state.wfMax = state.wfMin + Math.max(50, span);
      renderWaterfallCanvas();
    } else if (e.key === 'ArrowUp') {
      selectPrevNext(-1);
    } else if (e.key === 'ArrowDown') {
      selectPrevNext(1);
    } else if (e.key === '+' || e.key === '=') {
      // 精确缩放 in
      const center = state.wfMin + span / 2;
      const newSpan = Math.max(50, span * 0.9);
      state.wfMin = Math.max(0, center - newSpan / 2);
      state.wfMax = Math.min(center + newSpan / 2, state.filtered.reduce((m,e)=>Math.max(m, e.started_ms + (e.time||0)), 0));
      renderWaterfallCanvas();
    } else if (e.key === '-' || e.key === '_') {
      // 精确缩放 out
      const center = state.wfMin + span / 2;
      const fullMax = state.filtered.reduce((m,e)=>Math.max(m, e.started_ms + (e.time||0)), 0);
      const newSpan = Math.max(50, Math.min(span * 1.11, fullMax));
      state.wfMin = Math.max(0, center - newSpan / 2);
      state.wfMax = Math.min(center + newSpan / 2, fullMax);
      renderWaterfallCanvas();
    }
  });

  // 标尺框选：按住修饰键（Shift/Alt/Ctrl）拖拽选择时间范围
  const ruler = document.getElementById('waterfallRuler');
  const canvas = document.getElementById('waterfallCanvas');
  if (!ruler || !canvas) return;
  let selecting = false; let startX = 0;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const x2t = (x) => state.wfMin + ((x / width) * ((state.wfMax - state.wfMin) || 1));
  ruler.addEventListener('mousedown', (ev) => {
    if (!(ev.shiftKey || ev.altKey || ev.ctrlKey)) return; // 需要修饰键
    selecting = true; startX = ev.offsetX; state.wfSelRange = null;
  });
  ruler.addEventListener('mousemove', (ev) => {
    if (!selecting) return;
    const x1 = Math.min(startX, ev.offsetX);
    const x2 = Math.max(startX, ev.offsetX);
    state.wfSelRange = { min: x2t(x1), max: x2t(x2) };
    renderWaterfallCanvas();
  });
  const endSel = () => { selecting = false; };
  ruler.addEventListener('mouseup', endSel);
  ruler.addEventListener('mouseleave', endSel);
}

function selectPrevNext(delta) {
  const list = state.filtered.slice().sort(sortComparator());
  let idx = list.findIndex(e => e.id === state.selectedId);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(list.length - 1, idx + delta));
  const target = list[idx];
  if (target) selectEntry(target.id);
}

function formatBytes(n) {
  const units = ['B','KB','MB','GB'];
  let i = 0; let v = n || 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i ? v.toFixed(1) + units[i] : v + units[i];
}

function renderSelectionStats() {
  const el = document.getElementById('selStats'); if (!el) return;
  const ids = (state.selectedIds && state.selectedIds.length) ? state.selectedIds : (state.selectedId != null ? [state.selectedId] : []);
  if (!ids.length) { el.textContent = '已选: 0'; return; }
  const allMap = new Map(state.filtered.map(e => [e.id, e]));
  const selected = ids.map(id => allMap.get(id)).filter(Boolean);
  const count = selected.length;
  const totalSize = selected.reduce((a,e)=>a + (e.size || 0), 0);
  const totalTime = selected.reduce((a,e)=>a + (e.time || 0), 0);
  const avgTime = count ? (totalTime / count) : 0;
  el.textContent = `已选: ${count} | 总大小: ${formatBytes(totalSize)} | 总耗时: ${Math.round(totalTime)}ms | 平均耗时: ${Math.round(avgTime)}ms`;
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// 初始化瀑布图滑动导轨与纵向缩放控件
function initWfControls() {
  const hScroll = document.getElementById('wfHScroll');
  const vScroll = document.getElementById('wfVScroll');
  const vZoom = document.getElementById('wfVZoom');
  if (vZoom) {
    vZoom.addEventListener('input', () => { state.wfRowH = parseInt(vZoom.value || '16'); renderWaterfallCanvas(); });
  }
  if (vScroll) {
    vScroll.addEventListener('input', () => { renderWaterfallCanvas(); });
  }
  if (hScroll) {
    hScroll.addEventListener('input', () => {
      const list = state.filtered.slice().sort(sortComparator());
      const fullMax = Math.max(...list.map(e => (e.started_ms + (e.time || 0))), 0);
      const span = (state.wfMax - state.wfMin) || Math.max(50, fullMax);
      const ratio = parseInt(hScroll.value || '0') / 100;
      const maxMin = Math.max(0, fullMax - span);
      const newMin = Math.round(ratio * maxMin);
      state.wfMin = newMin;
      state.wfMax = Math.min(fullMax, newMin + span);
      renderWaterfallCanvas();
    });
  }
}

window.addEventListener('load', initWfControls);