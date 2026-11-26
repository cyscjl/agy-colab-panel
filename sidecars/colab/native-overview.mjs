import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getDevToolsPortFile() {
  if (process.env.ANTIGRAVITY_CDP_PORT_FILE) return process.env.ANTIGRAVITY_CDP_PORT_FILE;
  if (process.env.AGY_BROWSER_ACTIVE_PORT_FILE) return process.env.AGY_BROWSER_ACTIVE_PORT_FILE;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.win32.join(process.env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  return path.posix.join(process.env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'Antigravity', 'DevToolsActivePort');
}

const HUB_TITLE_RE = /(?:(?:^| - |\(\d+\) )Antigravity(?:\s*(?:\([^)]+\)|\[[^\]]+\]))?|(?:\s|^)(?:\((?:SSH|WSL):\s*[^)]+\)|\[(?:SSH|WSL):\s*[^\]]+\]))$/;
const HUB_PATH_RE = /^\/(?:c\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}|powertools|customizations|automations)(?:\/|$)/;

function isLoopbackHttpsPage(target) {
  try {
    const url = new URL(target.url);
    return target.type === 'page' && url.protocol === 'https:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isHubTarget(target) {
  if (!isLoopbackHttpsPage(target)) return false;
  try {
    return HUB_TITLE_RE.test(target.title || '') || HUB_PATH_RE.test(new URL(target.url).pathname);
  } catch {
    return false;
  }
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    const listeners = new Set();
    const timeout = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error('CDP connect timeout'));
    }, 4000);

    const close = () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP closed'));
      }
      pending.clear();
    };

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('CDP error'));
    });
    socket.addEventListener('close', close);
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const p = pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve({
        socket,
        onEvent: (listener) => listeners.add(listener),
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not open'));
          return new Promise((res, rej) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timeout`));
            }, 8000);
            pending.set(id, { resolve: res, reject: rej, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    });
  });
}

function buildInjectedScript(origin) {
  const version = '1.8.2';
  return `(() => {
  if (location.origin !== ${JSON.stringify(origin)} || window !== window.top) return;
  if (globalThis.__colabOverviewPanel?.version === ${JSON.stringify(version)} && globalThis.__colabOverviewPanel?.active) return;
  globalThis.__colabOverviewPanel?.dispose?.();

  let seq = 0;
  const pending = new Map();
  globalThis.__colabPanelReceive = (id, reply) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (reply && reply.error) p.reject(new Error(reply.error));
    else p.resolve(reply);
  };

  function callHost(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (typeof globalThis.__colabPanelHost !== 'function') {
        reject(new Error('Colab Host 未连接'));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('请求超时'));
      }, 22000);
      pending.set(id, { resolve, reject, timer });
      try {
        globalThis.__colabPanelHost(JSON.stringify({ id, method, ...params }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  const STYLE_ID = 'colab-overview-panel-style';
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = \`
      .cb-ov-sec { padding: 4px; border-top: 1px solid var(--border); display: flex; flex-direction: column; font-size: 12px; color: var(--foreground); }
      .cb-ov-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px 4px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--foreground); font: inherit; text-align: left; cursor: pointer; outline: none; }
      .cb-ov-toggle:focus-visible { box-shadow: 0 0 0 1px var(--ring, var(--primary)); }
      .cb-ov-title { font-size: 12px; line-height: 16px; font-weight: 500; opacity: .5; user-select: none; transition: opacity 150ms ease; }
      .cb-ov-badge { font-size: 10px; line-height: 1; font-weight: 500; padding: 2px 6px; border-radius: 9999px; background: var(--border); color: var(--foreground); opacity: .5; font-variant-numeric: tabular-nums; white-space: nowrap; transition: opacity 150ms ease; }
      .cb-ov-badge[data-tone=active] { background: color-mix(in srgb, var(--primary) 18%, transparent); color: var(--primary); opacity: .95; }
      .cb-ov-badge[data-tone=success] { background: rgba(52, 211, 153, 0.16); color: #34d399; opacity: .95; }
      .cb-ov-badge[data-tone=warning] { background: rgba(251, 191, 36, 0.18); color: #fbbf24; opacity: .95; }
      .cb-ov-badge[data-tone=critical] { background: rgba(248, 113, 113, 0.18); color: #f87171; opacity: .95; }
      .cb-ov-chev { margin-left: auto; color: var(--muted-foreground); opacity: 0; transform: rotate(0deg); transition: color 150ms ease, opacity 150ms ease, transform 150ms ease; flex-shrink: 0; display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
      .cb-ov-toggle[aria-expanded=true] .cb-ov-chev { transform: rotate(90deg); }
      .cb-ov-toggle:hover .cb-ov-title, .cb-ov-toggle:focus-visible .cb-ov-title,
      .cb-ov-toggle:hover .cb-ov-badge, .cb-ov-toggle:focus-visible .cb-ov-badge { opacity: 1; }
      .cb-ov-toggle:hover .cb-ov-chev, .cb-ov-toggle:focus-visible .cb-ov-chev { opacity: 1; color: var(--secondary-foreground); }
      .cb-ov-body { padding: 4px 8px 6px; display: flex; flex-direction: column; gap: 6px; }
      .cb-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
      .cb-muted { color: var(--muted-foreground); font-size: 11px; }
      .cb-pill { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border-radius: 6px; font-size: 11px; font-weight: 500; background: color-mix(in srgb, var(--secondary) 85%, transparent); color: var(--foreground); white-space: nowrap; }
      .cb-pill[data-tone=pro] { background: rgba(251, 191, 36, 0.16); color: #fbbf24; }
      .cb-pill[data-tone=proplus] { background: rgba(52, 211, 153, 0.16); color: #34d399; }
      .cb-pill[data-tone=cu] { background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--primary); font-variant-numeric: tabular-nums; }
      .cb-pill[data-tone=cu-warn] { background: rgba(251, 191, 36, 0.16); color: #fbbf24; font-variant-numeric: tabular-nums; }
      .cb-btn { height: 22px; min-width: 38px; padding: 0 7px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--border) 90%, transparent); background: color-mix(in srgb, var(--secondary) 75%, transparent); color: var(--foreground); font: inherit; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap; box-sizing: border-box; transition: background 120ms ease, opacity 120ms ease; }
      .cb-btn:hover:not(:disabled) { background: var(--secondary); }
      .cb-btn:disabled { opacity: 0.55; cursor: default; }
      .cb-btn-primary { background: var(--primary); color: var(--primary-foreground, #fff); border-color: transparent; font-weight: 500; }
      .cb-btn-primary:hover:not(:disabled) { opacity: 0.9; background: var(--primary); }
      .cb-btn-danger { background: rgba(248, 113, 113, 0.15); color: #f87171; border-color: rgba(248, 113, 113, 0.28); }
      .cb-btn-danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.24); }
      .cb-rt-item { display: flex; flex-direction: column; gap: 5px; padding: 6px 7px; border-radius: 7px; background: color-mix(in srgb, var(--secondary) 60%, transparent); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
      .cb-res-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; font-variant-numeric: tabular-nums; }
      .cb-res-pill { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 4px; height: 21px; padding: 0 6px; border-radius: 6px; font-size: 10.5px; white-space: nowrap; box-sizing: border-box; background: color-mix(in srgb, var(--secondary) 92%, transparent); color: var(--foreground); }
      .cb-res-bar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--primary); transition: width 200ms ease; }
      .cb-res-pill[data-tone=warning] .cb-res-bar { background: #fbbf24; }
      .cb-res-pill[data-tone=critical] .cb-res-bar { background: #f87171; }
      .cb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); flex-shrink: 0; }
      .cb-dot.online { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.5); }
      .cb-dot.queuing { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.6); }
      .cb-input, .cb-select, .cb-textarea { width: 100%; border-radius: 6px; border: 1px solid var(--border); background: color-mix(in srgb, var(--secondary) 75%, transparent); color: var(--foreground); font: inherit; font-size: 11px; padding: 4px 6px; outline: none; box-sizing: border-box; }
      .cb-select option { background: var(--background, #121216); color: var(--foreground, #f4f4f6); }
      .cb-textarea { min-height: 52px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; }
      .cb-err { padding: 4px 6px; border-radius: 6px; background: rgba(248, 113, 113, 0.14); color: #f87171; font-size: 11px; word-break: break-word; }
      .cb-toast { font-size: 11px; color: #34d399; }
      .cb-queue-box { display: flex; flex-direction: column; gap: 5px; padding-top: 4px; border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent); }
    \`;

  const STORAGE_OPEN_KEY = 'colab-overview-sec-open';
  const STORAGE_SPEC_KEY = 'colab-overview-selected-spec';
  const readOpen = () => {
    try { return localStorage.getItem(STORAGE_OPEN_KEY) !== '0'; } catch { return true; }
  };
  const writeOpen = (val) => {
    try { localStorage.setItem(STORAGE_OPEN_KEY, val ? '1' : '0'); } catch {}
  };

  const state = {
    open: readOpen(),
    showSettings: false,
    loading: false,
    authenticated: false,
    hasClientId: false,
    clientIdPreview: '',
    quotaProjectId: '',
    loginState: 'idle',
    authUrl: '',
    error: '',
    toastMsg: '',
    subscription: {},
    ccuInfo: null,
    hasBalanceScope: false,
    runtimes: [],
    specs: [],
    keepAliveEnabled: true,
    selectedSpecKey: (() => { try { return localStorage.getItem(STORAGE_SPEC_KEY) || ''; } catch { return ''; } })(),
    intervalSec: 30,
    queue: { running: false, attempts: 0, status_text: '空闲', logs: [] },
    wasQueueRunning: false,
  };

  let mountEl = null;
  let toastTimer = null;
  let queuePollTimer = null;
  let authPollTimer = null;

  function showToast(msg) {
    state.toastMsg = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toastMsg = '';
      render();
    }, 2400);
  }

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.16);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.36);
    } catch {}
  }

  function specKey(s) {
    return \`\${s.variant}|\${s.accelerator}|\${s.shape}\`;
  }

  function formatTier(sub = {}) {
    const raw = String(sub.tier || sub.subscriptionTier || sub.plan || '').toUpperCase();
    if (raw.includes('PRO_PLUS') || raw.includes('PRO+')) return { label: 'PRO+', tone: 'proplus' };
    if (raw.includes('PRO')) return { label: 'PRO', tone: 'pro' };
    if (raw.includes('FREE')) return { label: 'FREE', tone: 'free' };
    return { label: raw || '已登录', tone: 'free' };
  }

  function formatShapeLabel(rawShape) {
    const s = String(rawShape || 'STANDARD').replace(/^SHAPE_/, '');
    return s === 'HIGHMEM' ? '高内存' : s === 'STANDARD' ? '标准' : s;
  }

  function parseRegionFromUrl(url = '') {
    const m = String(url).match(/\\.([a-z]+-[a-z]+\\d+)\\.prod\\.r\\.colab\\.dev/i);
    if (!m) return null;
    const code = m[1].toLowerCase();
    const map = {
      'asia-southeast1': '新加坡',
      'asia-east1': '台湾',
      'asia-northeast1': '东京',
      'asia-northeast3': '首尔',
      'asia-south1': '孟买',
      'us-central1': '美中',
      'us-west1': '美西',
      'us-west4': '美西',
      'us-east1': '美东',
      'us-east4': '美东',
      'europe-west1': '比利时',
      'europe-west4': '荷兰',
    };
    return { code, label: map[code] || code };
  }

  function formatDurationShort(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0m';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return '<1m';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? \`\${h}h \${m}m\` : \`\${m}m\`;
  }

  function formatClockTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function formatGiB(bytes, digits = 1) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    const gib = bytes / (1024 ** 3);
    return gib >= 10 && digits === 1 ? gib.toFixed(0) : gib.toFixed(digits);
  }

  function toneForPct(pct) {
    if (!Number.isFinite(pct)) return 'ok';
    return pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'ok';
  }

  // Google Colab 各规格参考算力消耗率 (CU/h) 与折算美元单价 ($9.99 / 100 CU ≈ $0.10 / CU)
  const USD_PER_CU = 0.0999;
  function estimateSpecRate(accelRaw, shapeRaw) {
    const accel = String(accelRaw || 'NONE').replace(/^ACCELERATOR_TYPE_/, '').toUpperCase();
    const shape = String(shapeRaw || 'STANDARD').replace(/^SHAPE_/, '').toUpperCase();
    const high = shape === 'HIGHMEM';
    const table = {
      NONE: high ? 0.11 : 0.07,
      CPU: high ? 0.11 : 0.07,
      T4: high ? 1.58 : 1.47,
      L4: high ? 2.45 : 2.32,
      G4: high ? 2.65 : 2.50,
      V100: high ? 5.36 : 5.05,
      A100: high ? 13.11 : 6.86,
      H100: high ? 16.50 : 15.30,
      V28: 1.76,
      V5E1: 1.61,
      V6E1: 2.10,
    };
    const cuPerHour = table[accel] ?? (high ? 2.0 : 1.5);
    const usdPerHour = cuPerHour * USD_PER_CU;
    return { cuPerHour, usdPerHour };
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function syncAll({ refreshOverview = true, silent = false } = {}) {
    try {
      const st = await callHost('status');
      const prevLoginState = state.loginState;
      state.authenticated = Boolean(st.authenticated);
      state.hasBalanceScope = Boolean(st.has_balance_scope);
      state.hasClientId = Boolean(st.has_client_id);
      state.clientIdPreview = st.client_id_preview || '';
      state.quotaProjectId = st.quota_project_id || '';
      state.loginState = st.login_state || 'idle';
      state.authUrl = st.auth_url || '';
      if (st.login_error) state.error = st.login_error;
      if (!state.hasClientId) state.showSettings = true;

      if (state.authenticated) {
        if (refreshOverview || (prevLoginState === 'pending' && state.loginState === 'idle')) {
          if (!silent) {
            state.loading = true;
            const refreshBtn = mountEl?.querySelector('[data-action="refresh"]');
            if (refreshBtn) refreshBtn.disabled = true;
          }
          const ov = await callHost('overview');
          state.loading = false;
          if (ov.ok) {
            state.subscription = ov.subscription || {};
            state.ccuInfo = ov.ccu_info || null;
            state.runtimes = ov.runtimes || [];
            state.specs = ov.specs || [];
            if (typeof ov.keep_alive_enabled === 'boolean') state.keepAliveEnabled = ov.keep_alive_enabled;
            const sorted = [...state.specs].sort((a, b) => (a.eligible === b.eligible ? 0 : a.eligible ? -1 : 1));
            if (!state.selectedSpecKey || !sorted.some(s => specKey(s) === state.selectedSpecKey && s.eligible)) {
              const firstOk = sorted.find(s => s.eligible);
              if (firstOk) {
                state.selectedSpecKey = specKey(firstOk);
                try { localStorage.setItem(STORAGE_SPEC_KEY, state.selectedSpecKey); } catch {}
              }
            }
            if (ov.errors && ov.errors.length) state.error = ov.errors.join(' | ');
            else state.error = '';
          } else if (ov.error) {
            state.error = ov.error;
          }
        }
        await pollQueueStatus({ silent: true });
      } else {
        state.loading = false;
      }

      clearTimeout(authPollTimer);
      if (state.loginState === 'pending') {
        authPollTimer = setTimeout(() => syncAll({ refreshOverview: true, silent: true }), 1800);
      }
    } catch (e) {
      state.loading = false;
      state.error = e.message || String(e);
    }
    render();
  }

  async function pollQueueStatus({ silent = false } = {}) {
    try {
      const res = await callHost('queue.status');
      if (res && res.queue) {
        const q = res.queue;
        const prevRunning = state.wasQueueRunning;
        state.queue = q;
        clearTimeout(queuePollTimer);
        if (q.running) {
          state.wasQueueRunning = true;
          queuePollTimer = setTimeout(() => pollQueueStatus({ silent: false }), 1500);
        } else {
          if (prevRunning && q.acquired_runtime && q.target) {
            state.wasQueueRunning = false;
            playBeep();
            const label = q.target.accelerator === 'NONE' ? 'CPU' : q.target.accelerator;
            showToast(\`已抢到 \${label}!\`);
            syncAll({ refreshOverview: true, silent: true });
          } else {
            state.wasQueueRunning = false;
          }
        }
        if (!silent) render();
      }
    } catch {}
  }

  function insertTextToComposer(text) {
    const input = document.querySelector('[aria-label="Message input"], [data-agy-original-aria-label="Message input"], textarea');
    if (input) {
      input.focus();
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const nextVal = input.value ? input.value + '\\n' + text : text;
      if (setter) setter.call(input, nextVal);
      else input.value = nextVal;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('已填入输入框');
      return;
    }
    navigator.clipboard?.writeText(text).then(() => showToast('已复制到剪贴板'));
  }

  function computeBadge() {
    if (!state.hasClientId) return { text: '待配置', tone: 'warning' };
    if (!state.authenticated) return { text: state.loginState === 'pending' ? '授权中' : '未登录', tone: state.loginState === 'pending' ? 'active' : undefined };
    if (state.queue?.running) return { text: \`排队 #\${state.queue.attempts || 1}\`, tone: 'warning' };
    if (state.runtimes?.length > 0) {
      const firstSpec = state.runtimes[0]?.runtimeSpec || {};
      const accel = firstSpec.accelerator && firstSpec.accelerator !== 'NONE' ? firstSpec.accelerator : 'CPU';
      return { text: state.runtimes.length === 1 ? accel : \`\${state.runtimes.length} 台 (\${accel})\`, tone: 'success' };
    }
    const tier = formatTier(state.subscription);
    return { text: tier.label, tone: tier.tone === 'proplus' ? 'success' : tier.tone === 'pro' ? 'active' : undefined };
  }

  let lastRenderedSig = '';

  function render() {
    if (!mountEl || !mountEl.isConnected) return;
    const activeTag = document.activeElement;
    if (activeTag && mountEl.contains(activeTag) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag.tagName)) {
      const badgeEl = mountEl.querySelector('[data-role="cb-badge"]');
      if (badgeEl) {
        const b = computeBadge();
        badgeEl.textContent = b.text;
        if (b.tone) badgeEl.setAttribute('data-tone', b.tone);
        else badgeEl.removeAttribute('data-tone');
      }
      return;
    }

    const badge = computeBadge();
    const tier = formatTier(state.subscription);

    let bodyHtml = '';
    if (state.open) {
      let balanceHtml = '';
      if (state.authenticated) {
        const ccu = state.ccuInfo;
        if (ccu?.ok && ccu.balance != null) {
          const bal = Number(ccu.balance);
          const balStr = bal >= 100 ? bal.toFixed(1) : bal.toFixed(2);
          const rate = Number(ccu.hourly_rate || 0);
          const etaPart = rate > 0 && bal > 0 ? \` · 预计还可用 \${(bal / rate).toFixed(1)}h\` : '';
          const tip = \`剩余计算单元: \${bal.toFixed(2)} CU | 当前消耗速率: \${rate.toFixed(2)} CU/h\${etaPart}\${ccu.stale ? ' (缓存)' : ''}\`;
          balanceHtml = \`<span class="cb-pill" data-tone="\${bal < 10 ? 'cu-warn' : 'cu'}" title="\${escapeHtml(tip)}">剩余 \${escapeHtml(balStr)} CU</span>\`;
        } else if (ccu?.needs_reauth || !state.hasBalanceScope) {
          balanceHtml = \`<span class="cb-muted" title="请退出后重新登录即可显示精确剩余 CU 余额">需重登查余额</span>\`;
        } else if (ccu?.error) {
          balanceHtml = \`<span class="cb-muted" title="\${escapeHtml(ccu.error)}">余额未返回</span>\`;
        }
      }

      const topRow = \`
        <div class="cb-row">
          <div style="display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap;">
            <span class="cb-dot \${state.queue?.running ? 'queuing' : state.authenticated ? 'online' : ''}"></span>
            \${state.authenticated ? \`<span class="cb-pill" data-tone="\${tier.tone}">\${escapeHtml(tier.label)}</span>\${balanceHtml}\` : \`<span class="cb-muted">\${state.hasClientId ? '未登录 OAuth' : '需配置 OAuth'}</span>\`}
            \${state.toastMsg ? \`<span class="cb-toast">\${escapeHtml(state.toastMsg)}</span>\` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex:none;">
            <button type="button" class="cb-btn" data-action="refresh" \${state.loading || !state.authenticated ? 'disabled' : ''}>刷新</button>
            <button type="button" class="cb-btn" data-action="toggle-settings">\${state.showSettings ? '收起' : '配置'}</button>
          </div>
        </div>
      \`;

      const errHtml = state.error ? \`<div class="cb-err">\${escapeHtml(state.error)}</div>\` : '';

      const settingsHtml = state.showSettings ? \`
        <div class="cb-rt-item">
          <div class="cb-row">
            <span style="font-weight:500;font-size:11px;">OAuth 凭证 (\${escapeHtml(state.hasClientId ? state.clientIdPreview : '未配置')})</span>
            \${state.authenticated ? \`<button type="button" class="cb-btn cb-btn-danger" data-action="logout">退出</button>\` : ''}
          </div>
          <div class="cb-muted" style="font-size:10.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span>申请直达:</span>
            <a href="https://console.cloud.google.com/apis/library/colaboratory.googleapis.com" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:none;">1.启用API</a>
            <span>·</span>
            <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:none;">2.测试用户</a>
            <span>·</span>
            <a href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:none;">3.桌面凭证</a>
          </div>
          <textarea class="cb-textarea" data-field="secret-json" placeholder="粘贴 client_secret.json 全文"></textarea>
          <input class="cb-input" data-field="project-id" type="text" placeholder="Quota Project ID (可选)" value="\${escapeHtml(state.quotaProjectId)}" />
          <div class="cb-row" style="justify-content:flex-end;">
            <button type="button" class="cb-btn cb-btn-primary" data-action="save-config">保存配置</button>
          </div>
        </div>
      \` : '';

      let mainHtml = '';
      if (!state.authenticated) {
        mainHtml = \`
          <div class="cb-row" style="padding-top:2px;">
            <button type="button" class="cb-btn cb-btn-primary" style="width:100%;height:26px;" data-action="login" \${!state.hasClientId || state.loginState === 'pending' ? 'disabled' : ''}>
              \${state.loginState === 'pending' ? '等待浏览器授权...' : '使用 Google 账号登录'}
            </button>
          </div>
          \${state.authUrl ? \`
            <div class="cb-row">
              <span class="cb-muted">浏览器未弹出？</span>
              <button type="button" class="cb-btn" data-action="copy-auth-url">复制授权链接</button>
            </div>
          \` : ''}
        \`;
      } else {
        const rtHtml = state.runtimes.length === 0
          ? \`<div class="cb-row"><span class="cb-muted">当前无运行中实例</span><span class="cb-muted">0 台</span></div>\`
          : state.runtimes.map((rt, idx) => {
              const spec = rt.runtimeSpec || {};
              const conn = rt.connectionInfo || {};
              const jst = rt.jupyterStatus || {};
              const res = rt.resources || {};
              const rawAccel = String(spec.accelerator || 'NONE').replace(/^ACCELERATOR_TYPE_/, '');
              const accel = rawAccel && rawAccel !== 'NONE' ? rawAccel : 'CPU';
              const shape = formatShapeLabel(spec.shape);
              const region = parseRegionFromUrl(conn.url);
              const shortId = String(rt.name || '').replace(/^runtimes\\//, '').slice(0, 12);

              const now = Date.now();
              const startedMs = jst.started ? new Date(jst.started).getTime() : NaN;
              const lastActMs = jst.last_activity ? new Date(jst.last_activity).getTime() : NaN;
              const expireMs = conn.expireTime ? new Date(conn.expireTime).getTime() : NaN;

              const upMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
              const idleMs = Number.isFinite(lastActMs) ? Math.max(0, now - lastActMs) : null;
              const maxLifeHours = tier.label.includes('PRO') ? 24 : 12;
              const idleReleaseMs = idleMs != null ? Math.max(0, 90 * 60000 - idleMs) : null;
              const lifeReleaseMs = upMs != null ? Math.max(0, maxLifeHours * 3600000 - upMs) : null;
              const idleWarn = idleMs != null && idleMs >= 20 * 60000 && !(jst.kernels > 0 && jst.connections > 0);
              const kernels = Number(jst.kernels || 0);
              const conns = Number(jst.connections || 0);

              // 解析内存、GPU 显存/核心占用、磁盘
              const memTotal = Number(res.memory?.totalBytes || 0);
              const memFree = Number(res.memory?.freeBytes || 0);
              const memUsed = memTotal > 0 ? Math.max(0, memTotal - memFree) : 0;
              const memPct = memTotal > 0 ? Math.min(100, Math.round((memUsed / memTotal) * 100)) : null;

              const gpu = Array.isArray(res.gpus) && res.gpus.length ? res.gpus[0] : null;
              const vramTotal = Number(gpu?.memoryTotalBytes || 0);
              const vramUsed = Number(gpu?.memoryUsedBytes || 0);
              const vramPct = vramTotal > 0 ? Math.min(100, Math.round((vramUsed / vramTotal) * 100)) : null;
              const gpuUtilRaw = typeof gpu?.gpuUtilization === 'number' ? gpu.gpuUtilization : null;
              const gpuUtilPct = gpuUtilRaw != null ? Math.min(100, Math.round(gpuUtilRaw <= 1 && gpuUtilRaw > 0 ? gpuUtilRaw * 100 : gpuUtilRaw)) : null;

              const disk = Array.isArray(res.disks) && res.disks.length ? res.disks[0]?.filesystem || res.disks[0] : null;
              const diskTotal = Number(disk?.totalBytes || 0);
              const diskUsed = Number(disk?.usedBytes || 0);
              const diskPct = diskTotal > 0 ? Math.min(100, Math.round((diskUsed / diskTotal) * 100)) : null;

              const resPills = [];
              if (memPct != null) {
                const diskTip = diskTotal > 0 ? \` | 磁盘: \${formatGiB(diskUsed, 1)} / \${formatGiB(diskTotal, 0)} GB (\${diskPct}%)\` : '';
                resPills.push(\`
                  <div class="cb-res-pill" data-tone="\${toneForPct(memPct)}" title="系统内存 (RAM): \${formatGiB(memUsed, 2)} / \${formatGiB(memTotal, 1)} GB (\${memPct}%)\${escapeHtml(diskTip)}">
                    <span class="cb-muted" style="font-size:10px;">RAM</span>
                    <span>\${escapeHtml(formatGiB(memUsed, 1))}/\${escapeHtml(formatGiB(memTotal, 0))}G</span>
                    <span class="cb-res-bar" style="width:\${memPct}%"></span>
                  </div>
                \`);
              }
              if (gpu && vramPct != null) {
                const gpuName = gpu.name || accel;
                const utilLabel = gpuUtilPct != null ? \` · \${gpuUtilPct}%\` : '';
                const barPct = Math.max(vramPct, gpuUtilPct || 0);
                resPills.push(\`
                  <div class="cb-res-pill" data-tone="\${toneForPct(barPct)}" title="\${escapeHtml(gpuName)} 显存: \${formatGiB(vramUsed, 2)} / \${formatGiB(vramTotal, 1)} GB (\${vramPct}%) | GPU 算力负载: \${gpuUtilPct ?? 0}%">
                    <span class="cb-muted" style="font-size:10px;">GPU\${escapeHtml(utilLabel)}</span>
                    <span>\${escapeHtml(formatGiB(vramUsed, 1))}/\${escapeHtml(formatGiB(vramTotal, 1))}G</span>
                    <span class="cb-res-bar" style="width:\${barPct}%"></span>
                  </div>
                \`);
              } else if (diskPct != null) {
                resPills.push(\`
                  <div class="cb-res-pill" data-tone="\${toneForPct(diskPct)}" title="磁盘占用: \${formatGiB(diskUsed, 2)} / \${formatGiB(diskTotal, 1)} GB (\${diskPct}%)">
                    <span class="cb-muted" style="font-size:10px;">Disk</span>
                    <span>\${escapeHtml(formatGiB(diskUsed, 1))}/\${escapeHtml(formatGiB(diskTotal, 0))}G</span>
                    <span class="cb-res-bar" style="width:\${diskPct}%"></span>
                  </div>
                \`);
              }

              const rate = estimateSpecRate(accel, spec.shape);
              const hoursRun = upMs != null ? upMs / 3600000 : null;
              const usedCu = hoursRun != null ? hoursRun * rate.cuPerHour : null;
              const usedUsd = hoursRun != null ? hoursRun * rate.usdPerHour : null;

              const timeBadges = [];
              if (upMs != null) {
                const startClock = formatClockTime(jst.started);
                const lifeTip = lifeReleaseMs != null ? \`，上限剩余约 \${formatDurationShort(lifeReleaseMs)} (最长 \${maxLifeHours}h)\` : '';
                timeBadges.push(\`<span title="启动于 \${escapeHtml(startClock)}\${escapeHtml(lifeTip)}">运行 \${escapeHtml(formatDurationShort(upMs))}</span>\`);
              }
              if (usedCu != null) {
                const cuStr = usedCu < 10 ? usedCu.toFixed(2) : usedCu.toFixed(1);
                const usdStr = usedUsd < 0.01 && usedUsd > 0 ? '<$0.01' : \`$\${usedUsd.toFixed(2)}\`;
                timeBadges.push(\`<span style="color:var(--foreground);font-weight:500;" title="参考消耗速率: ~\${rate.cuPerHour.toFixed(2)} CU/h ($\${rate.usdPerHour.toFixed(2)}/h，按 $9.99/100 CU 折算)">~\${escapeHtml(cuStr)} CU (\${escapeHtml(usdStr)})</span>\`);
              } else {
                timeBadges.push(\`<span title="参考消耗速率 (按 $9.99/100 CU 折算)">~\${rate.cuPerHour.toFixed(2)} CU/h ($\${rate.usdPerHour.toFixed(2)}/h)</span>\`);
              }
              if (idleReleaseMs != null) {
                const actClock = formatClockTime(jst.last_activity);
                const idleStyle = idleWarn ? 'color:#fbbf24;font-weight:500;' : '';
                timeBadges.push(\`<span style="\${idleStyle}" title="最后活跃 \${escapeHtml(actClock)}（已空闲 \${escapeHtml(formatDurationShort(idleMs))}，Colab 空闲约 90m 自动释放）">闲置 ~\${escapeHtml(formatDurationShort(idleReleaseMs))}</span>\`);
              } else if (Number.isFinite(expireMs) && expireMs > now) {
                timeBadges.push(\`<span title="连接 Token 刷新时间 \${escapeHtml(formatClockTime(conn.expireTime))}">凭证 \${escapeHtml(formatDurationShort(expireMs - now))}</span>\`);
              }
              if (jst.started) {
                const kStyle = kernels > 0 ? 'color:#34d399;' : '';
                timeBadges.push(\`<span style="\${kStyle}" title="Jupyter 活跃内核数: \${kernels}，连接数: \${conns}">内核 \${kernels}</span>\`);
              }

              return \`
                <div class="cb-rt-item">
                  <div class="cb-row">
                    <div style="display:flex;align-items:center;gap:5px;font-weight:600;min-width:0;flex-wrap:wrap;" title="实例 ID: \${escapeHtml(shortId || rt.name || '-')} | 费率: ~\${rate.cuPerHour.toFixed(2)} CU/h ($\${rate.usdPerHour.toFixed(2)}/h)">
                      <span class="cb-dot online"></span>
                      <span>\${escapeHtml(accel)}</span>
                      <span class="cb-pill">\${escapeHtml(shape)}</span>
                      \${region ? \`<span class="cb-pill" style="opacity:0.8;font-weight:400;" title="机房区域: \${escapeHtml(region.code)}">\${escapeHtml(region.label)}</span>\` : ''}
                      <span class="cb-pill" style="opacity:0.85;font-weight:400;" title="每小时消耗约 \${rate.cuPerHour.toFixed(2)} 算力单元 (约 $\${rate.usdPerHour.toFixed(2)}/h)">\${rate.cuPerHour.toFixed(1)} CU/h</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;">
                      <button type="button" class="cb-btn" data-action="keepalive-now" title="立即刷新连接 Token (顺延 60m) 并激活 Jupyter 内核重置 90m 闲置释放倒计时（当前已默认开启后台自动保活）">续期</button>
                      <button type="button" class="cb-btn cb-btn-danger" data-action="delete-rt" data-idx="\${idx}">释放</button>
                    </div>
                  </div>
                  \${resPills.length ? \`<div class="cb-res-grid">\${resPills.join('')}</div>\` : ''}
                  \${timeBadges.length ? \`
                    <div class="cb-row cb-muted" style="font-size:10.5px;justify-content:flex-start;gap:6px;flex-wrap:wrap;">
                      \${timeBadges.join('<span>·</span>')}
                    </div>
                  \` : ''}
                </div>
              \`;
            }).join('');

        const sortedSpecs = [...state.specs].sort((a, b) => {
          if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
          const aCpu = a.accelerator === 'NONE' ? 1 : 0;
          const bCpu = b.accelerator === 'NONE' ? 1 : 0;
          return aCpu - bCpu;
        });

        const optionsHtml = sortedSpecs.length
          ? sortedSpecs.map(s => {
              const k = specKey(s);
              const rawAccel = String(s.accelerator || 'NONE').replace(/^ACCELERATOR_TYPE_/, '');
              const accel = rawAccel === 'NONE' ? 'CPU' : rawAccel;
              const rawShape = String(s.shape || 'STANDARD').replace(/^SHAPE_/, '');
              const shape = rawShape === 'HIGHMEM' ? '高内存' : rawShape === 'STANDARD' ? '标准' : rawShape;
              const rate = estimateSpecRate(accel, rawShape);
              const priceTag = \`~\${rate.cuPerHour.toFixed(1)}CU/h ($\${rate.usdPerHour.toFixed(2)}/h)\`;
              const disabled = !s.eligible ? 'disabled' : '';
              const selected = k === state.selectedSpecKey ? 'selected' : '';
              return \`<option value="\${escapeHtml(k)}" \${selected} \${disabled}>\${escapeHtml(accel)} (\${escapeHtml(shape)}) · \${escapeHtml(priceTag)}\${!s.eligible ? ' [无权限]' : ''}</option>\`;
            }).join('')
          : '<option value="">默认规格 (GPU/CPU)</option>';

        const q = state.queue || {};
        const lastLog = q.logs && q.logs.length ? q.logs[0] : null;

        const queueHtml = \`
          <div class="cb-queue-box">
            <div class="cb-row">
              <select class="cb-select" data-field="spec-select" style="flex:1;min-width:0;" \${q.running ? 'disabled' : ''}>
                \${optionsHtml}
              </select>
              <input class="cb-input" data-field="interval-sec" type="number" min="15" max="300" value="\${escapeHtml(state.intervalSec)}" title="轮询间隔(秒)" style="width:46px;text-align:center;flex:none;" \${q.running ? 'disabled' : ''} />
              \${q.running
                ? \`<button type="button" class="cb-btn cb-btn-danger" data-action="stop-queue" style="flex:none;">停止</button>\`
                : \`<button type="button" class="cb-btn cb-btn-primary" data-action="start-queue" style="flex:none;">抢算力</button>\`
              }
            </div>
            \${(q.running || q.attempts > 0) ? \`
              <div class="cb-row cb-muted">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${escapeHtml(q.status_text || '空闲')}</span>
                <span style="flex:none;">#\${escapeHtml(q.attempts || 0)}</span>
              </div>
            \` : ''}
            \${lastLog ? \`
              <div class="cb-muted" style="font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${escapeHtml(lastLog.message)}">
                [\${escapeHtml(lastLog.time)}] \${escapeHtml(String(lastLog.message || '').replace(/SHAPE_STANDARD/g, '标准').replace(/SHAPE_HIGHMEM/g, '高内存'))}
              </div>
            \` : ''}
          </div>
        \`;

        mainHtml = rtHtml + queueHtml;
      }

      bodyHtml = \`<div class="cb-ov-body">\${topRow}\${errHtml}\${settingsHtml}\${mainHtml}</div>\`;
    }

    const nextHtml = \`
      <section data-testid="colab-overview-section" class="cb-ov-sec pt-ov-sec">
        <button type="button" class="cb-ov-toggle pt-ov-toggle" aria-expanded="\${state.open}" data-action="toggle-section">
          <span class="cb-ov-title pt-ov-title">Colab 算力</span>
          \${badge.text ? \`<span data-role="cb-badge" class="cb-ov-badge pt-ov-badge" \${badge.tone ? \`data-tone="\${badge.tone}"\` : ''}>\${escapeHtml(badge.text)}</span>\` : ''}
          <span class="cb-ov-chev pt-ov-chev" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </span>
        </button>
        \${bodyHtml}
      </section>
    \`;
    if (nextHtml === lastRenderedSig && mountEl.childElementCount > 0) return;
    lastRenderedSig = nextHtml;
    mountEl.innerHTML = nextHtml;
  }

  function handleMountClick(e) {
    const btn = e.target.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'toggle-section') {
      state.open = !state.open;
      writeOpen(state.open);
      render();
    } else if (action === 'toggle-settings') {
      state.showSettings = !state.showSettings;
      render();
    } else if (action === 'refresh') {
      syncAll({ refreshOverview: true, silent: false });
    } else if (action === 'keepalive-now') {
      btn.disabled = true;
      callHost('runtime.keepalive', { enabled: true })
        .then((res) => {
          if (res?.runtimes) state.runtimes = res.runtimes;
          showToast('已续期保活');
        })
        .catch((err) => {
          state.error = err.message;
          render();
        })
        .finally(() => {
          btn.disabled = false;
        });
    } else if (action === 'save-config') {
      const rawJson = mountEl.querySelector('[data-field="secret-json"]')?.value?.trim() || '';
      const projId = mountEl.querySelector('[data-field="project-id"]')?.value?.trim() || '';
      callHost('config.save', { raw_secret_json: rawJson, quota_project_id: projId })
        .then((res) => {
          if (res.ok === false) throw new Error(res.error || '保存失败');
          state.showSettings = false;
          state.error = '';
          showToast('配置已保存');
          syncAll({ refreshOverview: true });
        })
        .catch((err) => {
          state.error = err.message;
          render();
        });
    } else if (action === 'login') {
      state.error = '';
      state.loginState = 'pending';
      render();
      callHost('auth.login')
        .then((res) => {
          if (res.ok === false) throw new Error(res.error || '登录失败');
          if (res.auth_url) state.authUrl = res.auth_url;
          render();
          clearTimeout(authPollTimer);
          authPollTimer = setTimeout(() => syncAll({ refreshOverview: true, silent: true }), 1800);
        })
        .catch((err) => {
          state.loginState = 'idle';
          state.error = err.message;
          render();
        });
    } else if (action === 'copy-auth-url') {
      if (state.authUrl) {
        navigator.clipboard?.writeText(state.authUrl).then(() => showToast('已复制链接'));
      }
    } else if (action === 'logout') {
      callHost('auth.logout').then(() => {
        state.authenticated = false;
        state.ccuInfo = null;
        state.hasBalanceScope = false;
        state.runtimes = [];
        state.showSettings = false;
        showToast('已退出');
        syncAll({ refreshOverview: false });
      });
    } else if (action === 'delete-rt') {
      const idx = Number(btn.getAttribute('data-idx'));
      const rt = state.runtimes[idx];
      if (!rt || !rt.name) return;
      callHost('runtime.delete', { name: rt.name })
        .then((res) => {
          if (res.ok === false) throw new Error(res.error || '释放失败');
          showToast('已释放');
          syncAll({ refreshOverview: true });
        })
        .catch((err) => {
          state.error = err.message;
          render();
        });
    } else if (action === 'copy-rt') {
      const idx = Number(btn.getAttribute('data-idx'));
      const field = btn.getAttribute('data-field');
      const val = state.runtimes[idx]?.connectionInfo?.[field];
      if (val) navigator.clipboard?.writeText(val).then(() => showToast(\`已复制 \${field.toUpperCase()}\`));
    } else if (action === 'send-rt') {
      const idx = Number(btn.getAttribute('data-idx'));
      const rt = state.runtimes[idx];
      if (!rt) return;
      const spec = rt.runtimeSpec || {};
      const conn = rt.connectionInfo || {};
      const accel = spec.accelerator && spec.accelerator !== 'NONE' ? spec.accelerator : 'CPU';
      const summary = [
        '我已分配好一个 Google Colab 实例：',
        \`- 实例名：\${rt.name || '未知'}\`,
        \`- 算力规格：\${accel} (\${spec.shape || 'STANDARD'} / \${spec.variant || 'DEFAULT'})\`,
        conn.url ? \`- 代理地址：\${conn.url}\` : null,
      ].filter(Boolean).join('\\n');
      insertTextToComposer(summary);
    } else if (action === 'start-queue') {
      const selKey = mountEl.querySelector('[data-field="spec-select"]')?.value || state.selectedSpecKey;
      const intervalVal = Number(mountEl.querySelector('[data-field="interval-sec"]')?.value || state.intervalSec || 30);
      state.selectedSpecKey = selKey;
      state.intervalSec = Math.max(15, Math.min(300, intervalVal));
      const target = state.specs.find(s => specKey(s) === selKey) || { variant: 'DEFAULT', accelerator: 'NONE', shape: 'STANDARD' };
      state.error = '';
      callHost('queue.start', {
        variant: target.variant,
        accelerator: target.accelerator,
        shape: target.shape,
        interval: state.intervalSec,
      })
        .then((res) => {
          if (res.ok === false) throw new Error(res.error || '启动排队失败');
          state.wasQueueRunning = true;
          pollQueueStatus();
        })
        .catch((err) => {
          state.error = err.message;
          render();
        });
    } else if (action === 'stop-queue') {
      callHost('queue.stop').then(() => pollQueueStatus());
    }
  }

  function handleMountChange(e) {
    const el = e.target;
    if (!el) return;
    const field = el.getAttribute?.('data-field');
    if (field === 'spec-select') {
      state.selectedSpecKey = el.value;
      try { localStorage.setItem(STORAGE_SPEC_KEY, state.selectedSpecKey); } catch {}
    } else if (field === 'interval-sec') {
      state.intervalSec = Math.max(15, Math.min(300, Number(el.value || 30)));
    }
  }

  function ensureMounted() {
    const overview = document.querySelector('[data-testid="overview-panel"]');
    const container = overview?.parentElement || overview;
    if (!container) return;
    if (!mountEl || !mountEl.isConnected || mountEl.parentElement !== container) {
      if (mountEl) mountEl.remove();
      mountEl = document.createElement('div');
      mountEl.setAttribute('data-colab-overview-mount', 'true');
      mountEl.className = 'block w-full shrink-0';
      mountEl.addEventListener('click', handleMountClick);
      mountEl.addEventListener('change', handleMountChange);
      lastRenderedSig = '';
      container.appendChild(mountEl);
      render();
    }
  }

  const observer = new MutationObserver(() => ensureMounted());
  observer.observe(document.body, { childList: true, subtree: true });
  ensureMounted();
  syncAll({ refreshOverview: true });

  const periodicTimer = setInterval(() => {
    ensureMounted();
    if (state.authenticated && state.open) {
      syncAll({ refreshOverview: true, silent: true });
    }
  }, 45000);

  globalThis.__colabOverviewPanel = {
    version: ${JSON.stringify(version)},
    active: true,
    refresh: () => syncAll({ refreshOverview: true }),
    dispose() {
      this.active = false;
      observer.disconnect();
      clearInterval(periodicTimer);
      clearTimeout(queuePollTimer);
      clearTimeout(authPollTimer);
      clearTimeout(toastTimer);
      if (mountEl) {
        mountEl.remove();
        mountEl = null;
      }
    },
  };
})();`;
}

export function startNativeOverviewIntegration(handlers) {
  const portFile = getDevToolsPortFile();
  const clients = new Map();
  let polling = false;
  let stopped = false;

  async function attach(target) {
    const origin = new URL(target.url).origin;
    const client = await connectCdp(target.webSocketDebuggerUrl);
    const contexts = new Set();
    const tree = await client.send('Page.getFrameTree');
    const mainFrame = tree.frameTree?.frame?.id;

    clients.set(target.id, client);
    client.socket.addEventListener('close', () => {
      if (clients.get(target.id) === client) clients.delete(target.id);
    });

    client.onEvent(async (event) => {
      if (event.method === 'Runtime.executionContextCreated') {
        const ctx = event.params.context;
        if (ctx.origin === origin && ctx.auxData?.isDefault && ctx.auxData.frameId === mainFrame) {
          contexts.add(ctx.id);
        }
        return;
      }
      if (event.method === 'Runtime.executionContextDestroyed') {
        contexts.delete(event.params.executionContextId);
        return;
      }
      if (event.method === 'Runtime.executionContextsCleared') {
        contexts.clear();
        return;
      }
      if (event.method !== 'Runtime.bindingCalled' || event.params.name !== '__colabPanelHost') return;

      let req;
      try {
        req = JSON.parse(event.params.payload);
      } catch {
        return;
      }
      if (!Number.isInteger(req.id)) return;

      let reply;
      try {
        reply = await handlers.dispatch(req.method, req);
      } catch (err) {
        reply = { error: err.message || String(err) };
      }

      try {
        await client.send('Runtime.evaluate', {
          expression: `globalThis.__colabPanelReceive?.(${JSON.stringify(req.id)}, ${JSON.stringify(reply)})`,
          contextId: event.params.executionContextId,
        });
      } catch {}
    });

    await client.send('Runtime.enable');
    await client.send('Runtime.addBinding', { name: '__colabPanelHost' });

    const probeRes = await client.send('Runtime.evaluate', {
      expression: `Boolean(/Antigravity\\//.test(navigator.userAgent||'')||globalThis.electronNative||globalThis.sshRemote||globalThis.createFileRoute)`,
      returnByValue: true,
    });
    if (probeRes.result?.value === false) {
      client.socket.close();
      clients.delete(target.id);
      return;
    }

    const source = buildInjectedScript(origin);
    client.origin = origin;
    client.endpoint = target.webSocketDebuggerUrl;
    await client.send('Page.enable');
    const installed = await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    client.scriptId = installed.identifier;
    await client.send('Runtime.evaluate', { expression: source });
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      if (!fs.existsSync(portFile)) return;
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;

      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const targets = await res.json();
      if (!Array.isArray(targets)) return;

      const hubs = targets.filter((t) => isHubTarget(t) || (isLoopbackHttpsPage(t) && clients.get(t.id)?.origin === new URL(t.url).origin));
      for (const target of hubs) {
        let client = clients.get(target.id);
        try {
          if (client && (client.origin !== new URL(target.url).origin || client.endpoint !== target.webSocketDebuggerUrl)) {
            client.socket.close();
            clients.delete(target.id);
            client = null;
          }
          if (!client) {
            await attach(target);
          } else {
            const check = await client.send('Runtime.evaluate', {
              expression: `Boolean(globalThis.__colabOverviewPanel?.active)`,
              returnByValue: true,
            });
            if (check.result?.value !== true) {
              await client.send('Runtime.evaluate', { expression: buildInjectedScript(client.origin) });
            }
          }
        } catch {
          clients.get(target.id)?.socket.close();
          clients.delete(target.id);
        }
      }

      const activeIds = new Set(hubs.map((t) => t.id));
      for (const [id, client] of clients) {
        if (!activeIds.has(id)) {
          client.socket.close();
          clients.delete(id);
        }
      }
    } catch {
      // Wait for next poll
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(poll, 3500);
  poll();

  return async function stop() {
    stopped = true;
    clearInterval(timer);
    for (const client of clients.values()) {
      try {
        if (client.scriptId) {
          await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: client.scriptId });
        }
        await client.send('Runtime.evaluate', { expression: 'globalThis.__colabOverviewPanel?.dispose?.()' });
      } catch {}
      try { client.socket.close(); } catch {}
    }
    clients.clear();
  };
}
