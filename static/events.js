function $(sel) { return document.querySelector(sel); }

function setActiveTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const target = document.getElementById('tab-' + name);
  if (target) target.style.display = 'block';
  const btn = document.querySelector('.tab-btn[data-tab="' + name + '"]');
  if (btn) btn.classList.add('active');
}

async function loadSample() {
  const r = await fetch('/api/load-sample');
  if (!r.ok) {
    alert('加载示例失败');
    return;
  }
  const data = await r.json();
  $('#evtSummary').textContent = `示例已加载，共 ${data.entries.length} 条目`;
}

// ===== 图形化关系图状态（D3力导向） =====
const GraphState = {
  nodes: [], edges: [],
  fNodes: [], fEdges: [],
  adj: new Map(),
  scale: 1.0, tx: 0, ty: 0,
  draggingNode: null,
  draggingCanvas: false,
  dragStart: null,
  snapshots: { A: null, B: null },
  selectedNode: null,
  selectionRect: null,
  selection: new Set(),
  compare: { onlyChanges: false, addedNodes: new Set(), removedNodes: new Set(), addedEdges: new Set(), removedEdges: new Set() },
  sim: null,
  params: { repulsion: -150, linkDistance: 80, collide: 16 },
  // 群拖拽快照（记录开始拖拽时的多选初始位置）
  dragGroupSnapshot: null,
  dragNodeStartWorld: null,
};
// 阶段统计缓存
const PhaseCache = { last: null };
// 阶段统计图的几何缓存，用于悬停提示与坐标轴缩放
const PhaseGeom = { rects: [], pad: { l: 80, r: 20, t: 20, b: 60 }, chartW: 0, chartH: 0, types: [], phases: [], maxSum: 0, grouped: false, scaleMode: 'linear' };

function canvasEl() { return $('#evtCanvas'); }
function getCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  // 将显示尺寸同步到实际像素，且仅在变化时调整，避免非绘制场景导致清空
  const dpr = window.devicePixelRatio || 1;
  const desiredW = Math.max(300, Math.floor(rect.width * dpr));
  const desiredH = Math.max(200, Math.floor(rect.height * dpr));
  const changed = (canvas.width !== desiredW || canvas.height !== desiredH);
  if (changed) {
    canvas.width = desiredW;
    canvas.height = desiredH;
    // 尺寸变化会清空画布；若仿真停止，主动重绘以避免“消失”
    try { draw(); } catch (e) {}
  }
  return { w: canvas.width, h: canvas.height, dpr };
}

function buildAdj(edges) {
  GraphState.adj.clear();
  for (const e of edges) {
    if (!GraphState.adj.has(e.source)) GraphState.adj.set(e.source, []);
    GraphState.adj.get(e.source).push(e.target);
  }
}

function initPositions(nodes) {
  // 初始随机散布以加速收敛
  const R = 100;
  nodes.forEach(nd => { nd.x = (Math.random()-0.5)*2*R; nd.y = (Math.random()-0.5)*2*R; });
  GraphState.scale = 1.0; GraphState.tx = 0; GraphState.ty = 0;
}

function applyFilter() {
  const host = $('#filterHost').value.trim();
  const type = $('#filterType').value;
  const status = $('#filterStatus').value;
  const rootId = $('#rootDocSelect').value ? Number($('#rootDocSelect').value) : null;

  let nodes = GraphState.nodes.slice();
  let edges = GraphState.edges.slice();
  if (host) nodes = nodes.filter(n => (n.host || '').includes(host));
  if (type) nodes = nodes.filter(n => (n.type || '') === type);
  if (status) nodes = nodes.filter(n => String(n.status || '') === status);

  const keep = new Set(nodes.map(n => n.id));
  edges = edges.filter(e => keep.has(e.source) && keep.has(e.target));
  if (rootId && keep.has(rootId)) {
    // 子树：从 rootId 出发的可达集合
    const reach = new Set();
    const q = [rootId]; reach.add(rootId);
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    while (q.length) {
      const u = q.shift();
      const vs = adj.get(u) || [];
      for (const v of vs) if (!reach.has(v)) { reach.add(v); q.push(v); }
    }
    nodes = nodes.filter(n => reach.has(n.id));
    const rset = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => rset.has(e.source) && rset.has(e.target));
  }

  GraphState.fNodes = nodes;
  GraphState.fEdges = edges;
  buildAdj(edges);
  initPositions(nodes);
  startD3Sim();
  fitToView();
  renderGraphText();
}

async function buildGraph() {
  const r = await fetch('/api/event-graph');
  if (!r.ok) {
    $('#evtSummary').textContent = '生成失败：请先上传或加载示例';
    return;
  }
  const data = await r.json();
  const nodes = data.nodes || []; const edges = data.edges || [];
  GraphState.nodes = nodes; GraphState.edges = edges;
  // 填充 rootDocSelect 选项
  const rootSel = $('#rootDocSelect');
  rootSel.innerHTML = '<option value="">从 document 开始聚焦子树</option>';
  for (const n of nodes) {
    if ((n.type || '') === 'document') {
      const opt = document.createElement('option');
      opt.value = String(n.id);
      opt.textContent = `[${n.id}] ${n.host || ''} ${n.path || ''}`;
      rootSel.appendChild(opt);
    }
  }
  $('#evtSummary').textContent = `节点 ${nodes.length}，关系 ${edges.length}`;
  applyFilter();
  bindCanvasInteractions();
}

// ===== D3 力导向仿真 =====
function startD3Sim() {
  if (GraphState.sim) GraphState.sim.stop();
  const nodes = GraphState.fNodes; const edges = GraphState.fEdges.map(e => ({...e}));
  const link = d3.forceLink(edges).id(d => d.id).distance(GraphState.params.linkDistance).strength(0.7);
  // 按度调整斥力，孤立点弱斥力以避免散得太远
  const deg = new Map();
  for (const e of edges) { deg.set(e.source, (deg.get(e.source)||0)+1); deg.set(e.target, (deg.get(e.target)||0)+1); }
  const many = d3.forceManyBody().strength(d => (deg.get(d.id)||0) > 0 ? GraphState.params.repulsion : 0);
  // 将孤立点拉向中心，以更聚集显示
  const fx = d3.forceX(0).strength(d => (deg.get(d.id)||0) > 0 ? 0 : 0.4);
  const fy = d3.forceY(0).strength(d => (deg.get(d.id)||0) > 0 ? 0 : 0.4);
  const col = d3.forceCollide(GraphState.params.collide);
  GraphState.sim = d3.forceSimulation(nodes)
    .force('link', link)
    .force('charge', many)
    .force('collide', col)
    .force('x', fx)
    .force('y', fy)
    .force('center', d3.forceCenter(0,0))
    .alpha(1)
    .on('tick', () => { draw(); });
}

// 将孤立节点固定到画布左上角的盒子中，并从视图适配中排除

function fitToView() {
  const canvas = canvasEl(); const size = getCanvasSize(canvas);
  const nodes = GraphState.fNodes; if (!nodes.length) return;
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x||0); maxX = Math.max(maxX, n.x||0); minY = Math.min(minY, n.y||0); maxY = Math.max(maxY, n.y||0); }
  const worldW = Math.max(10, maxX - minX); const worldH = Math.max(10, maxY - minY);
  const fit = Math.min(size.w / worldW, size.h / worldH) * 0.85;
  GraphState.scale = fit;
  GraphState.tx = -(minX + maxX)/2 * fit; GraphState.ty = -(minY + maxY)/2 * fit;
  const zoom = $('#evtZoom'); if (zoom) { zoom.min = '0.1'; zoom.max = '6.0'; zoom.value = String(GraphState.scale); }
}

function worldToScreen(x, y, size) {
  return { x: x * GraphState.scale + GraphState.tx + size.w/2, y: y * GraphState.scale + GraphState.ty + size.h/2 };
}
function screenToWorld(x, y, size) {
  return { x: (x - GraphState.tx - size.w/2) / GraphState.scale, y: (y - GraphState.ty - size.h/2) / GraphState.scale };
}

function draw() {
  const canvas = canvasEl(); const ctx = canvas.getContext('2d');
  const size = getCanvasSize(canvas);
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.save();
  ctx.translate(size.w/2 + GraphState.tx, size.h/2 + GraphState.ty);
  ctx.scale(GraphState.scale, GraphState.scale);

  const only = GraphState.compare.onlyChanges;
  const changedNodeSet = new Set([ ...GraphState.compare.addedNodes, ...GraphState.compare.removedNodes ]);
  const changedEdgeSet = new Set([ ...GraphState.compare.addedEdges, ...GraphState.compare.removedEdges ]);

  // 选中节点的邻接集合
  const neighborSet = new Set();
  if (GraphState.selectedNode) {
    const sid = GraphState.selectedNode.id;
    for (const e of GraphState.fEdges) {
      if (e.source === sid) neighborSet.add(e.target);
      if (e.target === sid) neighborSet.add(e.source);
    }
  }

  // 边
  for (const e of GraphState.fEdges) {
    const a = GraphState.fNodes.find(n=>n.id===e.source);
    const b = GraphState.fNodes.find(n=>n.id===e.target);
    if (!a || !b) continue;
    if (only) {
      const key = `${e.source}->${e.target}|${e.reason||''}`;
      if (!changedEdgeSet.has(key)) continue;
    }
    const col = edgeColor(e.reason);
    const isHL = GraphState.selectedNode && (GraphState.selectedNode.id===e.source || GraphState.selectedNode.id===e.target);
    ctx.lineWidth = (isHL ? 3 : 1) / GraphState.scale; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(a.x||0, a.y||0); ctx.lineTo(b.x||0, b.y||0); ctx.stroke();
    drawArrow(ctx, a, b);
  }
  // 节点
  for (const n of GraphState.fNodes) {
    if (only && !changedNodeSet.has((n.url||'')+'|'+(n.type||'')+'|'+String(n.status||''))) continue;
    const r = 6; ctx.fillStyle = colorForType(n.type);
    ctx.beginPath(); ctx.arc((n.x||0), (n.y||0), r, 0, Math.PI*2); ctx.fill();
    const isSelected = (GraphState.selectedNode && GraphState.selectedNode.id===n.id);
    const isNeighbor = neighborSet.has(n.id);
    const isChosen = GraphState.selection.has(n.id);
    if (isSelected || isChosen || isNeighbor) {
      ctx.lineWidth = (isSelected?2:(isNeighbor?1.5:1.5))/GraphState.scale;
      ctx.strokeStyle = isSelected? '#ff9800' : (isNeighbor? '#ffcc80' : '#ffa726');
      ctx.beginPath(); ctx.arc(n.x||0, n.y||0, r+2, 0, Math.PI*2); ctx.stroke();
    }
    if (GraphState.scale > 0.9) { ctx.fillStyle = '#333'; ctx.font = `${12}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const label = (n.host||'') + (n.path?(' '+n.path):''); ctx.fillText(label, (n.x||0) + r + 2, (n.y||0) + 2); }
  }
  // 框选矩形（屏幕坐标）
  ctx.restore();
  // 绘制孤立点盒子（屏幕坐标）
  if (GraphState.isolateBox) {
    const b = GraphState.isolateBox;
    ctx.save();
    ctx.strokeStyle = '#9e9e9e'; ctx.setLineDash([5,3]); ctx.lineWidth = 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = 'rgba(240,240,240,0.45)'; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
  if (GraphState.selectionRect) {
    const rect = GraphState.selectionRect;
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    const ctx2 = canvas.getContext('2d'); ctx2.save(); ctx2.strokeStyle = '#ff9800'; ctx2.setLineDash([6,4]); ctx2.lineWidth = 1; ctx2.strokeRect(x, y, w, h); ctx2.restore();
  }
}

function colorForType(t) {
  switch (t) {
    case 'document': return '#007acc';
    case 'script': return '#e67e22';
    case 'stylesheet': return '#27ae60';
    case 'image': return '#8e44ad';
    case 'xhr': return '#c0392b';
    default: return '#7f8c8d';
  }
}
function edgeColor(reason) {
  switch (reason) {
    case 'parser': return '#607d8b';
    case 'script': return '#c62828';
    case 'redirect': return '#6d4c41';
    case 'prefetch': return '#5e35b1';
    case 'preload': return '#009688';
    case 'xhr': return '#ef6c00';
    default: return '#9e9e9e';
  }
}
function drawArrow(ctx, a, b) {
  const ax = a.x||0, ay = a.y||0; const bx = b.x||0, by = b.y||0;
  const dx = bx-ax, dy = by-ay; const len = Math.hypot(dx,dy) || 1;
  const ux = dx/len, uy = dy/len; const size = 8;
  const px = bx - ux*size, py = by - uy*size;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(px + (-uy)*size*0.6, py + (ux)*size*0.6);
  ctx.lineTo(px + (uy)*size*0.6,  py + (-ux)*size*0.6);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

// ===== 交互：缩放/拖拽/悬停 =====
function bindCanvasInteractions() {
  const canvas = canvasEl();
  const tooltip = $('#evtTooltip');
  function pickNode(mx, my) {
    const size = getCanvasSize(canvas);
    const w = screenToWorld(mx, my, size);
    const radius = 8 / GraphState.scale;
    let hit = null;
    for (const n of GraphState.fNodes) {
      const dx = (n.x||0) - w.x, dy = (n.y||0) - w.y;
      if (dx*dx + dy*dy <= radius*radius) { hit = n; break; }
    }
    return hit;
  }
  canvas.addEventListener('mousedown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const node = pickNode(ev.clientX - rect.left, ev.clientY - rect.top);
    const size = getCanvasSize(canvas);
    const w0 = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, size);
    if (node) {
      if (ev.ctrlKey) {
        // Ctrl + 点击：切换多选集合中的该节点
        if (GraphState.selection.has(node.id)) GraphState.selection.delete(node.id); else GraphState.selection.add(node.id);
        GraphState.selectedNode = node;
        renderGraphText(); draw();
      } else {
        // 普通点击：选中并开始拖拽该节点
        GraphState.draggingNode = node;
        node.fx = node.x; node.fy = node.y; GraphState.selectedNode = node;
        // 记录群拖拽初始位置快照
        const ids = GraphState.selection.size > 0 ? Array.from(GraphState.selection) : [node.id];
        GraphState.dragGroupSnapshot = ids.map(id => {
          const n0 = GraphState.fNodes.find(n=>n.id===id);
          return n0 ? { id, x0: n0.x||0, y0: n0.y||0 } : null;
        }).filter(Boolean);
        GraphState.dragNodeStartWorld = { x: w0.x, y: w0.y };
        renderGraphText();
        if (GraphState.sim) GraphState.sim.alpha(0.2).restart();
        draw();
      }
    } else {
      if (ev.shiftKey) {
        // Shift + 拖拽：框选；结合 Ctrl/Alt 决定添加/移除/替换
        const mode = ev.ctrlKey ? 'add' : (ev.altKey ? 'sub' : 'replace');
        GraphState.selectionRect = { x: ev.clientX - rect.left, y: ev.clientY - rect.top, w: 0, h: 0, mode };
        draw();
      } else {
        GraphState.draggingCanvas = true; GraphState.dragStart = { x: ev.clientX, y: ev.clientY };
        draw();
      }
    }
  });
  window.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const size = getCanvasSize(canvas);
    if (GraphState.draggingNode) {
      const w = screenToWorld(mx, my, size);
      if (GraphState.dragGroupSnapshot && GraphState.dragNodeStartWorld) {
        const dx = w.x - GraphState.dragNodeStartWorld.x;
        const dy = w.y - GraphState.dragNodeStartWorld.y;
        for (const s of GraphState.dragGroupSnapshot) {
          const n = GraphState.fNodes.find(nn=>nn.id===s.id);
          if (n) { n.fx = s.x0 + dx; n.fy = s.y0 + dy; }
        }
      } else {
        const n = GraphState.draggingNode; n.fx = w.x; n.fy = w.y;
      }
      draw();
    } else if (GraphState.draggingCanvas && GraphState.dragStart) {
      GraphState.tx += (ev.clientX - GraphState.dragStart.x);
      GraphState.ty += (ev.clientY - GraphState.dragStart.y);
      GraphState.dragStart = { x: ev.clientX, y: ev.clientY };
      draw();
    } else if (GraphState.selectionRect) {
      GraphState.selectionRect.w = mx - GraphState.selectionRect.x;
      GraphState.selectionRect.h = my - GraphState.selectionRect.y;
      draw();
    } else {
      const node = pickNode(mx, my);
      if (node) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${ev.clientX + 12}px`;
        tooltip.style.top = `${ev.clientY + 12}px`;
        tooltip.innerHTML = `[${node.id}] ${node.type || ''} ${node.status || ''}<br/>${node.method || ''} ${node.url || ''}`;
      } else {
        tooltip.style.display = 'none';
      }
    }
  });
  window.addEventListener('mouseup', () => {
    if (GraphState.draggingNode) {
      if (GraphState.dragGroupSnapshot) {
        for (const s of GraphState.dragGroupSnapshot) {
          const n = GraphState.fNodes.find(nn=>nn.id===s.id);
          if (n) { n.fx = n.x; n.fy = n.y; }
        }
      } else {
        const n = GraphState.draggingNode; n.fx = n.x; n.fy = n.y;
      }
    }
    GraphState.draggingNode = null; GraphState.draggingCanvas = false; GraphState.dragStart = null;
    GraphState.dragGroupSnapshot = null; GraphState.dragNodeStartWorld = null;
    if (GraphState.selectionRect) {
      const size = getCanvasSize(canvas);
      const r = GraphState.selectionRect;
      const x1 = r.w>=0? r.x: r.x+r.w; const y1 = r.h>=0? r.y: r.y+r.h;
      const x2 = r.w>=0? r.x+r.w: r.x; const y2 = r.h>=0? r.y+r.h: r.y;
      const w1 = screenToWorld(x1, y1, size), w2 = screenToWorld(x2, y2, size);
      const minx = Math.min(w1.x, w2.x), maxx = Math.max(w1.x, w2.x), miny = Math.min(w1.y, w2.y), maxy = Math.max(w1.y, w2.y);
      const idsInRect = [];
      for (const n of GraphState.fNodes) {
        const x = n.x||0, y = n.y||0;
        if (x>=minx && x<=maxx && y>=miny && y<=maxy) idsInRect.push(n.id);
      }
      if (r.mode === 'add') {
        for (const id of idsInRect) GraphState.selection.add(id);
      } else if (r.mode === 'sub') {
        for (const id of idsInRect) GraphState.selection.delete(id);
      } else {
        GraphState.selection.clear();
        for (const id of idsInRect) GraphState.selection.add(id);
      }
      GraphState.selectionRect = null;
      renderGraphText();
    }
    draw();
  });
  // 键盘快捷键：Esc 清空选中与多选
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      GraphState.selectedNode = null; GraphState.selection.clear(); GraphState.selectionRect = null; renderGraphText(); draw();
    }
  });
  $('#evtZoom').addEventListener('input', (ev) => {
    GraphState.scale = Number(ev.target.value);
    draw();
  });
  const repEl = document.getElementById('repulsionSlider');
  const distEl = document.getElementById('linkDistanceSlider');
  if (repEl) repEl.addEventListener('input', (e)=>{ GraphState.params.repulsion = Number(e.target.value); startD3Sim(); });
  if (distEl) distEl.addEventListener('input', (e)=>{ GraphState.params.linkDistance = Number(e.target.value); startD3Sim(); });
  const toggleOnly = document.getElementById('onlyChanges');
  if (toggleOnly) toggleOnly.addEventListener('change', (e)=>{ GraphState.compare.onlyChanges = !!e.target.checked; renderGraphText(); draw(); });
}

// ===== 导出与对比 =====
function exportJson() {
  const data = { nodes: GraphState.fNodes, edges: GraphState.fEdges };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'event-graph.json'; a.click();
}
async function importJson() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0]; if (!file) return;
    const text = await file.text();
    let data; try { data = JSON.parse(text); } catch (e) { alert('JSON 解析失败'); return; }
    const nodes = Array.isArray(data.nodes) ? data.nodes : []; const edges = Array.isArray(data.edges) ? data.edges : [];
    GraphState.nodes = nodes.slice(); GraphState.edges = edges.slice();
    GraphState.fNodes = nodes.slice(); GraphState.fEdges = edges.slice();
    buildAdj(edges);
    // 若 JSON 中带有 x/y，尊重其位置；否则初始化位置
    const hasPos = nodes.every(n => typeof n.x === 'number' && typeof n.y === 'number');
    if (!hasPos) initPositions(nodes);
    startD3Sim();
    fitToView();
    // 更新 root 选择
    const rootSel = $('#rootDocSelect'); if (rootSel) {
      rootSel.innerHTML = '<option value="">从 document 开始聚焦子树</option>';
      for (const n of nodes) if ((n.type||'') === 'document') {
        const opt = document.createElement('option'); opt.value = String(n.id); opt.textContent = `[${n.status||''}] ${n.host||''} ${n.path||''}`;
        rootSel.appendChild(opt);
      }
    }
    $('#evtSummary').textContent = `从 JSON 导入：节点 ${nodes.length}，关系 ${edges.length}`;
  };
  input.click();
}
function exportPng() {
  const canvas = canvasEl(); const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png'); link.download = 'event-graph.png'; link.click();
}
function snapshot(tag) {
  GraphState.snapshots[tag] = { nodes: GraphState.fNodes.slice(), edges: GraphState.fEdges.slice() };
  $('#compareOut').textContent = `已保存快照${tag}：节点 ${GraphState.snapshots[tag].nodes.length}，边 ${GraphState.snapshots[tag].edges.length}`;
}
function compareSnapshots() {
  const A = GraphState.snapshots.A, B = GraphState.snapshots.B;
  if (!A || !B) { $('#compareOut').textContent = '请先保存快照A与快照B'; return; }
  const keyNode = n => (n.url || '') + '|' + (n.type || '') + '|' + String(n.status || '');
  const keyEdge = e => `${e.source}->${e.target}|${e.reason || ''}`;
  const setA_nodes = new Set(A.nodes.map(keyNode));
  const setB_nodes = new Set(B.nodes.map(keyNode));
  const setA_edges = new Set(A.edges.map(keyEdge));
  const setB_edges = new Set(B.edges.map(keyEdge));
  const addedNodes = [...setB_nodes].filter(k => !setA_nodes.has(k));
  const removedNodes = [...setA_nodes].filter(k => !setB_nodes.has(k));
  const addedEdges = [...setB_edges].filter(k => !setA_edges.has(k));
  const removedEdges = [...setA_edges].filter(k => !setB_edges.has(k));
  GraphState.compare.addedNodes = new Set(addedNodes);
  GraphState.compare.removedNodes = new Set(removedNodes);
  GraphState.compare.addedEdges = new Set(addedEdges);
  GraphState.compare.removedEdges = new Set(removedEdges);
  let out = '';
  out += `节点新增 ${addedNodes.length}，移除 ${removedNodes.length}\n`; out += `边新增 ${addedEdges.length}，移除 ${removedEdges.length}\n`;
  out += '\n新增节点（最多50）：\n' + addedNodes.slice(0,50).map(s=>`  + ${s}`).join('\n');
  out += '\n移除节点（最多50）：\n' + removedNodes.slice(0,50).map(s=>`  - ${s}`).join('\n');
  out += '\n新增边（最多50）：\n' + addedEdges.slice(0,50).map(s=>`  + ${s}`).join('\n');
  out += '\n移除边（最多50）：\n' + removedEdges.slice(0,50).map(s=>`  - ${s}`).join('\n');
  $('#compareOut').textContent = out;
  renderGraphText();
}

// 右侧文本面板：节点与边概要
function renderGraphText() {
  const pre = document.getElementById('graphText'); if (!pre) return;
  const lines = [];
  lines.push(`节点 (${GraphState.fNodes.length})`);
  const degMap = new Map(); for (const e of GraphState.fEdges) { degMap.set(e.source, (degMap.get(e.source)||0)+1); degMap.set(e.target, (degMap.get(e.target)||0)+1); }
  GraphState.fNodes.slice(0, 200).forEach(n => {
    const deg = degMap.get(n.id)||0; const iso = n.isIsolate? ' iso':'';
    lines.push(`- [${n.id}] ${n.type||''} ${n.status||''} host=${n.host||''} deg=${deg}${iso}`);
  });
  if (GraphState.fNodes.length > 200) lines.push(`... 还有 ${GraphState.fNodes.length-200} 个节点省略`);
  // 多选统计与列表
  const selIds = Array.from(GraphState.selection);
  lines.push('');
  lines.push(`多选 (${selIds.length})`);
  if (selIds.length > 0) {
    const idSet = new Set(selIds);
    const selectedNodes = GraphState.fNodes.filter(n=>idSet.has(n.id)).slice(0, 100);
    selectedNodes.forEach(n => {
      lines.push(`- [${n.id}] ${n.type||''} host=${n.host||''}`);
    });
    if (selIds.length > selectedNodes.length) lines.push(`... 还有 ${selIds.length - selectedNodes.length} 个选中节点省略`);
  }
  lines.push('');
  lines.push(`边 (${GraphState.fEdges.length})`);
  GraphState.fEdges.slice(0, 400).forEach(e => {
    const s = (typeof e.source==='object' ? e.source.id : e.source);
    const t = (typeof e.target==='object' ? e.target.id : e.target);
    lines.push(`- ${s} -> ${t} [${e.reason||''}]`);
  });
  if (GraphState.fEdges.length > 400) lines.push(`... 还有 ${GraphState.fEdges.length-400} 条边省略`);
  pre.textContent = lines.join('\n');
}

// ===== 阶段统计图表 =====
async function loadPhaseStats() {
  const r = await fetch('/api/event-stats');
  if (!r.ok) {
    $('#evtPhase').textContent = '获取失败：请先上传或加载示例';
    return;
  }
  const data = await r.json();
  PhaseCache.last = data;
  renderPhaseChart(data);
}

function renderPhaseChart(data) {
  const canvas = $('#evtPhaseCanvas'); const ctx = canvas.getContext('2d');
  const size = getCanvasSize(canvas);
  const phases = ['blocked','dns','connect','ssl','send','wait','receive'];
  const byType = data.byType || {};
  const types = Object.keys(byType).slice(0, 8); // 最多显示8类
  const pad = PhaseGeom.pad;
  const chartW = size.w - pad.l - pad.r; const chartH = size.h - pad.t - pad.b;
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.fillStyle = '#333'; ctx.font = `${12 * (size.dpr||1)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  // 计算各类型总和以缩放
  let maxSum = 0; const sums = {};
  for (const t of types) {
    let sum = 0; for (const p of phases) sum += (byType[t][p] || 0);
    sums[t] = sum; if (sum > maxSum) maxSum = sum;
  }
  const xStep = chartW / Math.max(1, types.length);
  const color = p => ({
    blocked:'#95a5a6', dns:'#3498db', connect:'#9b59b6', ssl:'#8e44ad', send:'#e67e22', wait:'#2ecc71', receive:'#c0392b'
  }[p] || '#7f8c8d');

  // 绘制柱状（堆叠或分组）
  const grouped = !!document.getElementById('phaseGrouped')?.checked;
  const useLog = !!document.getElementById('phaseLogScale')?.checked;
  const scaleVal = (v) => {
    if (!maxSum || maxSum <= 0) return 0;
    if (useLog) return chartH * (Math.log1p(v) / Math.log1p(maxSum));
    return chartH * (v / maxSum);
  };
  // 缓存几何信息用于悬停提示
  PhaseGeom.rects = []; PhaseGeom.chartW = chartW; PhaseGeom.chartH = chartH; PhaseGeom.types = types; PhaseGeom.phases = phases; PhaseGeom.maxSum = maxSum; PhaseGeom.grouped = grouped; PhaseGeom.scaleMode = useLog ? 'log' : 'linear';
  ctx.save(); ctx.translate(pad.l, pad.t);
  if (!grouped) {
    for (let i=0;i<types.length;i++) {
      const t = types[i]; const x = i * xStep + xStep*0.15; const barW = xStep*0.7;
      let y = chartH;
      for (const p of phases) {
        const val = byType[t][p] || 0;
        const h = scaleVal(val);
        y -= h;
        ctx.fillStyle = color(p);
        ctx.fillRect(x, y, barW, h);
        PhaseGeom.rects.push({ x: pad.l + x, y: pad.t + y, w: barW, h, type: t, phase: p, value: val });
      }
      ctx.fillStyle = '#333'; ctx.textAlign = 'center';
      ctx.fillText(t, x+barW/2, chartH+18);
    }
  } else {
    for (let i=0;i<types.length;i++) {
      const t = types[i]; const x0 = i * xStep + xStep*0.15; const bandW = xStep*0.7;
      const barW = bandW / phases.length;
      for (let k=0;k<phases.length;k++) {
        const p = phases[k]; const val = byType[t][p] || 0;
        const h = scaleVal(val);
        const x = x0 + k * barW; const y = chartH - h;
        ctx.fillStyle = color(p);
        ctx.fillRect(x, y, barW*0.9, h);
        PhaseGeom.rects.push({ x: pad.l + x, y: pad.t + y, w: barW*0.9, h, type: t, phase: p, value: val });
      }
      ctx.fillStyle = '#333'; ctx.textAlign = 'center';
      ctx.fillText(t, x0+bandW/2, chartH+18);
    }
  }
  ctx.restore();

  // Y 轴刻度
  ctx.fillStyle = '#333'; ctx.textAlign = 'right';
  for (let i=0;i<=5;i++) {
    let v;
    if (useLog) {
      // 等距于对数域：v = exp(log1p(maxSum)*i/5)-1
      v = Math.expm1(Math.log1p(maxSum) * (i/5));
    } else {
      v = (i/5) * maxSum;
    }
    const y = pad.t + chartH - scaleVal(v);
    ctx.fillText(String(Math.round(v)), pad.l-6, y);
  }
  // 坐标轴线
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
  ctx.beginPath();
  // Y 轴
  ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + chartH);
  // X 轴
  ctx.moveTo(pad.l, pad.t + chartH); ctx.lineTo(pad.l + chartW, pad.t + chartH);
  ctx.stroke();

  // 坐标轴标题与图例
  ctx.save();
  ctx.fillStyle = '#666';
  // X 轴标题
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('资源类型', pad.l + chartW/2, pad.t + chartH + 28);
  // Y 轴标题旋转
  ctx.save();
  ctx.translate(pad.l - 50, pad.t + chartH/2);
  ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('耗时 (ms)', 0, 0);
  ctx.restore();

  // 图例（阶段颜色说明）
  const legendPhases = phases;
  const legendColor = p => ({
    blocked:'#95a5a6', dns:'#3498db', connect:'#9b59b6', ssl:'#8e44ad', send:'#e67e22', wait:'#2ecc71', receive:'#c0392b'
  }[p] || '#7f8c8d');
  let lx = pad.l + chartW - 220; let ly = pad.t + 8;
  ctx.font = `${12 * (size.dpr||1)}px sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const p of legendPhases) {
    ctx.fillStyle = legendColor(p);
    ctx.fillRect(lx, ly, 12, 12);
    ctx.fillStyle = '#333';
    ctx.fillText(p, lx + 16, ly + 6);
    lx += 70;
    if (lx > pad.l + chartW - 60) { lx = pad.l + chartW - 220; ly += 20; }
  }
  ctx.restore();
}

function exportPhaseCsv() {
  const data = PhaseCache.last; if (!data) { alert('请先加载阶段统计'); return; }
  const phases = ['blocked','dns','connect','ssl','send','wait','receive'];
  const byType = data.byType || {}; const types = Object.keys(byType);
  let csv = 'type,' + phases.join(',') + ',total\n';
  for (const t of types) {
    let row = [t]; let sum = 0;
    for (const p of phases) { const v = byType[t][p]||0; row.push(String(Math.round(v))); sum += v; }
    row.push(String(Math.round(sum))); csv += row.join(',') + '\n';
  }
  const blob = new Blob([csv], {type:'text/csv'}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'phase_stats.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

function exportPhasePng() {
  const canvas = document.getElementById('evtPhaseCanvas'); if (!canvas) return;
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a'); a.href = url; a.download = 'phase_chart.png'; a.click();
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });
  setActiveTab('graph');
}

function initActions() {
  $('#loadSampleBtn').addEventListener('click', loadSample);
  $('#buildGraphBtn').addEventListener('click', async ()=>{ await buildGraph(); bindCanvasInteractions(); });
  $('#applyFilterBtn').addEventListener('click', ()=>{ applyFilter(); });
  $('#exportJsonBtn').addEventListener('click', exportJson);
  $('#importJsonBtn').addEventListener('click', importJson);
  $('#exportPngBtn').addEventListener('click', exportPng);
  $('#snapshotABtn').addEventListener('click', ()=> snapshot('A'));
  $('#snapshotBBtn').addEventListener('click', ()=> snapshot('B'));
  $('#compareBtn').addEventListener('click', compareSnapshots);
  $('#loadPhaseBtn').addEventListener('click', loadPhaseStats);
  const exportPngBtn = document.getElementById('exportPhasePngBtn'); if (exportPngBtn) exportPngBtn.addEventListener('click', exportPhasePng);
  const exportCsvBtn = document.getElementById('exportPhaseCsvBtn'); if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportPhaseCsv);
  const groupedChk = document.getElementById('phaseGrouped'); if (groupedChk) groupedChk.addEventListener('change', ()=>{ if (PhaseCache.last) renderPhaseChart(PhaseCache.last); });
  const logScaleChk = document.getElementById('phaseLogScale'); if (logScaleChk) logScaleChk.addEventListener('change', ()=>{ if (PhaseCache.last) renderPhaseChart(PhaseCache.last); });
  // 阶段统计悬停提示
  const phaseCanvas = document.getElementById('evtPhaseCanvas');
  if (phaseCanvas) {
    phaseCanvas.addEventListener('mousemove', (ev) => {
      const rect = phaseCanvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      let hit = null;
      for (const r of PhaseGeom.rects) {
        if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) { hit = r; break; }
      }
      const tooltip = document.getElementById('phaseTooltip');
      if (hit && tooltip) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${ev.clientX + 12}px`;
        tooltip.style.top = `${ev.clientY + 12}px`;
        tooltip.innerHTML = `类型: ${hit.type}<br/>阶段: ${hit.phase}<br/>值: ${hit.value}`;
      } else if (tooltip) {
        tooltip.style.display = 'none';
      }
    });
    phaseCanvas.addEventListener('mouseleave', () => { const tooltip = document.getElementById('phaseTooltip'); if (tooltip) tooltip.style.display = 'none'; });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initActions();
});