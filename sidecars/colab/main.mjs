import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';
import { startNativeOverviewIntegration } from './native-overview.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

const DATA_DIR =
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
  path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-colab-panel');

fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TOKEN_PATH = path.join(DATA_DIR, 'token.json');

const COLAB_API_BASE = 'https://colaboratory.googleapis.com';
const COLAB_CCU_INFO_URL = 'https://colab.research.google.com/tun/m/ccu-info?authuser=0';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/colaboratory',
].join(' ');

// ==================== 配置与 Token 持久化 ====================

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function parseClientSecretJson(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return null;
  const section = rawObj.installed || rawObj.web || rawObj;
  if (!section.client_id) return null;
  return {
    client_id: String(section.client_id || '').trim(),
    client_secret: String(section.client_secret || '').trim(),
    quota_project_id: String(section.project_id || '').trim(),
  };
}

function loadConfig() {
  const saved = readJsonSafe(CONFIG_PATH, {}) || {};
  const cfg = {
    client_id: saved.client_id || '',
    client_secret: saved.client_secret || '',
    quota_project_id: saved.quota_project_id || '',
  };

  if (!cfg.client_id) {
    const candidates = [
      path.join(PLUGIN_ROOT, 'client_secret.json'),
      path.join(__dirname, 'client_secret.json'),
      path.join(DATA_DIR, 'client_secret.json'),
    ];
    for (const file of candidates) {
      const parsed = parseClientSecretJson(readJsonSafe(file));
      if (parsed && parsed.client_id) {
        cfg.client_id = parsed.client_id;
        cfg.client_secret = parsed.client_secret;
        if (!cfg.quota_project_id && parsed.quota_project_id) {
          cfg.quota_project_id = parsed.quota_project_id;
        }
        writeJsonSafe(CONFIG_PATH, cfg);
        break;
      }
    }
  }
  return cfg;
}

function saveConfig(partial) {
  const current = loadConfig();
  const next = {
    client_id: partial.client_id !== undefined ? String(partial.client_id).trim() : current.client_id,
    client_secret: partial.client_secret !== undefined ? String(partial.client_secret).trim() : current.client_secret,
    quota_project_id:
      partial.quota_project_id !== undefined ? String(partial.quota_project_id).trim() : current.quota_project_id,
  };
  writeJsonSafe(CONFIG_PATH, next);
  return next;
}

function loadToken() {
  return readJsonSafe(TOKEN_PATH, null);
}

function saveToken(tokenObj) {
  writeJsonSafe(TOKEN_PATH, tokenObj);
}

function clearToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  } catch {}
}

// ==================== 浏览器拉起与 OAuth 2.0 PKCE ====================

function openExternalUrl(url) {
  try {
    if (process.platform === 'win32') {
      const escaped = url.replace(/'/g, "''");
      spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${escaped}'`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const authState = {
  status: 'idle', // idle | pending | error
  error: '',
  authUrl: '',
  server: null,
};

function stopPendingOAuthServer() {
  if (authState.server) {
    try {
      authState.server.close();
    } catch {}
    authState.server = null;
  }
}

async function startOAuthFlow() {
  const cfg = loadConfig();
  if (!cfg.client_id) {
    throw new Error('请先在设置中导入 client_secret.json（或填写 Client ID / Client Secret）。');
  }

  stopPendingOAuthServer();
  authState.status = 'pending';
  authState.error = '';

  const state = base64Url(crypto.randomBytes(20));
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());

  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const errParam = reqUrl.searchParams.get('error');
        const retState = reqUrl.searchParams.get('state');
        const code = reqUrl.searchParams.get('code');

        if (errParam) {
          authState.status = 'error';
          authState.error = `Google 拒绝授权: ${errParam}`;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<body style="background:#000;color:#f87171;font-family:sans-serif;padding:32px;text-align:center">' +
              '<h2>授权已取消</h2><p style="color:#8b8b94">可关闭此页面并返回 Antigravity。</p></body>'
          );
          stopPendingOAuthServer();
          return;
        }

        if (!code || retState !== state) {
          authState.status = 'error';
          authState.error = 'OAuth 回调校验失败（state 不匹配）';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<body style="background:#000;color:#f87171;font-family:sans-serif;padding:32px;text-align:center">' +
              '<h2>回调校验失败</h2><p style="color:#8b8b94">请关闭页面后重新发起登录。</p></body>'
          );
          stopPendingOAuthServer();
          return;
        }

        const addr = server.address();
        const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

        const form = new URLSearchParams({
          code,
          client_id: cfg.client_id,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        });
        if (cfg.client_secret) {
          form.set('client_secret', cfg.client_secret);
        }

        const tokenRes = await fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const tokenJson = await tokenRes.json();

        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(tokenJson.error_description || tokenJson.error || '换取访问令牌失败');
        }

        const existing = loadToken() || {};
        saveToken({
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token || existing.refresh_token || '',
          token_type: tokenJson.token_type || 'Bearer',
          scope: tokenJson.scope || OAUTH_SCOPE,
          expiry_date: Date.now() + Number(tokenJson.expires_in || 3600) * 1000 - 60_000,
        });

        authState.status = 'idle';
        authState.error = '';
        authState.authUrl = '';

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<body style="background:#000;color:#f4f4f6;font-family:sans-serif;padding:40px;text-align:center">' +
            '<h2 style="color:#34d399;margin-bottom:8px">Google Colab 授权成功</h2>' +
            '<p style="color:#8b8b94">现在可以关闭此标签页，返回 Antigravity 右侧面板。</p></body>'
        );
        stopPendingOAuthServer();
      } catch (e) {
        authState.status = 'error';
        authState.error = String(e.message || e);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<body style="background:#000;color:#f87171;font-family:sans-serif;padding:32px">授权失败: ${authState.error}</body>`
        );
        stopPendingOAuthServer();
      }
    });

    server.on('error', (err) => {
      authState.status = 'error';
      authState.error = err.message;
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      const params = new URLSearchParams({
        client_id: cfg.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      const authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`;
      authState.server = server;
      authState.authUrl = authUrl;
      openExternalUrl(authUrl);

      setTimeout(() => {
        if (authState.server === server) {
          stopPendingOAuthServer();
          if (authState.status === 'pending') {
            authState.status = 'idle';
          }
        }
      }, 5 * 60_000).unref();

      resolve({ authUrl });
    });
  });
}

async function getValidAccessToken() {
  const token = loadToken();
  if (!token || !token.access_token) return null;

  if (token.expiry_date && Date.now() < token.expiry_date) {
    return token.access_token;
  }

  if (!token.refresh_token) return null;

  const cfg = loadConfig();
  const form = new URLSearchParams({
    client_id: cfg.client_id,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  if (cfg.client_secret) {
    form.set('client_secret', cfg.client_secret);
  }

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    return null;
  }

  const updated = {
    ...token,
    access_token: data.access_token,
    scope: data.scope || token.scope || '',
    expiry_date: Date.now() + Number(data.expires_in || 3600) * 1000 - 60_000,
  };
  saveToken(updated);
  return updated.access_token;
}

// ==================== Colab REST API 客户端 ====================

async function colabRequest(method, apiPath, body = null) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    const err = new Error('尚未登录或凭证已过期，请先完成 Google OAuth 登录。');
    err.status = 401;
    throw err;
  }

  const cfg = loadConfig();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (cfg.quota_project_id) {
    headers['X-Goog-User-Project'] = cfg.quota_project_id;
  }

  const res = await fetch(`${COLAB_API_BASE}${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const apiErr = json.error || {};
    const msg = apiErr.message || text || `HTTP ${res.status}`;
    const codeStr = apiErr.status || String(res.status);
    const err = new Error(`[${codeStr}] ${msg}`);
    err.status = res.status;
    throw err;
  }

  return json;
}

function normalizeSpec(item) {
  const inner = item.key || item.spec || item.runtimeSpec || item;
  return {
    variant: inner.variant || item.variant || 'DEFAULT',
    accelerator: inner.accelerator || item.accelerator || 'NONE',
    shape: inner.shape || item.shape || 'STANDARD',
    eligible: item.eligible !== undefined ? Boolean(item.eligible) : true,
  };
}

function formatShapeShort(shape) {
  const raw = String(shape || 'STANDARD').replace(/^SHAPE_/, '');
  return raw === 'HIGHMEM' ? '高内存' : raw === 'STANDARD' ? '标准' : raw;
}

// 缓存每台实例的 Jupyter 状态与硬件资源，防止偶发网络抖动导致指标消失
const runtimeMetricsCache = new Map();
let lastCcuInfo = null;
let keepAliveEnabled = true;

async function fetchCcuInfo() {
  const tokenObj = loadToken();
  const hasBalanceScope = String(tokenObj?.scope || '').includes('userinfo.email');
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { ok: false, needs_reauth: true, has_scope: hasBalanceScope, error: '未登录' };
  }

  try {
    const res = await fetch(COLAB_CCU_INFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'X-Colab-Client-Agent': 'colab-cli',
        'X-Colab-Tunnel': 'Google',
      },
      signal: AbortSignal.timeout(8000),
    });

    const rawText = await res.text();
    if (!res.ok) {
      const needsReauth = res.status === 401 || res.status === 403 || !hasBalanceScope;
      return {
        ok: false,
        needs_reauth: needsReauth,
        has_scope: hasBalanceScope,
        status: res.status,
        error: hasBalanceScope ? `HTTP ${res.status}` : '当前授权缺少 userinfo.email 权限',
      };
    }

    const cleanText = rawText.replace(/^\)\]\}'\s*/, '');
    const json = JSON.parse(cleanText);
    const balanceRaw = json.currentBalance ?? json.paidComputeUnitsBalance ?? json.paidBalance;
    const balance = Number.isFinite(Number(balanceRaw)) ? Number(balanceRaw) : null;
    const hourlyRateRaw = json.consumptionRateHourly;
    const hourlyRate = Number.isFinite(Number(hourlyRateRaw)) ? Number(hourlyRateRaw) : null;
    const assignmentsCount = Number.isFinite(Number(json.assignmentsCount))
      ? Number(json.assignmentsCount)
      : null;

    lastCcuInfo = {
      ok: true,
      has_scope: true,
      needs_reauth: false,
      balance,
      hourly_rate: hourlyRate,
      assignments_count: assignmentsCount,
      fetched_at: new Date().toISOString(),
    };
    return lastCcuInfo;
  } catch (err) {
    if (lastCcuInfo && hasBalanceScope) {
      return { ...lastCcuInfo, stale: true };
    }
    return {
      ok: false,
      needs_reauth: !hasBalanceScope,
      has_scope: hasBalanceScope,
      error: err.message || String(err),
    };
  }
}

async function pingRuntimeKeepAlive(conn) {
  if (!conn?.url || !conn?.token) return null;
  const base = String(conn.url).replace(/\/$/, '');
  const headers = {
    'X-Colab-Runtime-Proxy-Token': conn.token,
    'Content-Type': 'application/json',
  };
  try {
    // 1. 获取现有 kernels，若无内核则自动启动一个保活 python3 内核以刷新 last_activity
    const kRes = await fetch(`${base}/api/kernels`, {
      headers,
      signal: AbortSignal.timeout(7000),
    });
    if (kRes.ok) {
      const kernels = await kRes.json().catch(() => []);
      if (!Array.isArray(kernels) || kernels.length === 0) {
        await fetch(`${base}/api/kernels`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'python3' }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }
    }
    const stRes = await fetch(`${base}/api/status`, {
      headers,
      signal: AbortSignal.timeout(7000),
    });
    if (stRes.ok) {
      return await stRes.json().catch(() => null);
    }
  } catch {}
  return null;
}

async function enrichRuntimesWithStatus(runtimes = [], { triggerKeepAlive = false } = {}) {
  return await Promise.all(
    runtimes.map(async (rt) => {
      const key = rt?.name || '';
      const cached = runtimeMetricsCache.get(key) || {};
      const conn = rt?.connectionInfo || {};
      let jupyterStatus = null;
      let resources = null;
      if (conn.url && conn.token) {
        const base = String(conn.url).replace(/\/$/, '');
        const headers = { 'X-Colab-Runtime-Proxy-Token': conn.token };
        const [stRes, resRes] = await Promise.allSettled([
          fetch(`${base}/api/status`, { headers, signal: AbortSignal.timeout(8000) }),
          fetch(`${base}/api/colab/resources`, { headers, signal: AbortSignal.timeout(8000) }),
        ]);
        if (stRes.status === 'fulfilled' && stRes.value.ok) {
          jupyterStatus = await stRes.value.json().catch(() => null);
        }
        if (resRes.status === 'fulfilled' && resRes.value.ok) {
          try {
            const rawText = await resRes.value.text();
            const cleanText = rawText.replace(/^\)\]\}'\s*/, '');
            resources = JSON.parse(cleanText);
          } catch {}
        }

        // 如果开启了自动保活且当前无活跃内核或空闲超过 10 分钟，主动触发一次保活续期
        const curStatus = jupyterStatus || cached.jupyterStatus;
        const lastActMs = curStatus?.last_activity ? new Date(curStatus.last_activity).getTime() : 0;
        const idleMs = lastActMs ? Date.now() - lastActMs : 0;
        if (triggerKeepAlive || (keepAliveEnabled && (!curStatus || curStatus.kernels === 0 || idleMs > 10 * 60000))) {
          const refreshedStatus = await pingRuntimeKeepAlive(conn);
          if (refreshedStatus) jupyterStatus = refreshedStatus;
        }
      }

      const finalStatus = jupyterStatus || cached.jupyterStatus || null;
      const finalResources = resources || cached.resources || null;
      if (key && (finalStatus || finalResources)) {
        runtimeMetricsCache.set(key, {
          jupyterStatus: finalStatus,
          resources: finalResources,
          updatedAt: Date.now(),
        });
      }

      return {
        ...rt,
        ...(finalStatus ? { jupyterStatus: finalStatus } : {}),
        ...(finalResources ? { resources: finalResources } : {}),
        keepAliveEnabled,
      };
    })
  );
}

// ==================== 后台排队抢算力调度器 ====================

const queueState = {
  running: false,
  runId: 0,
  target: null,
  interval: 30,
  attempts: 0,
  status_text: '空闲',
  last_error: '',
  acquired_runtime: null,
  logs: [],
};

function pushLog(message, level = 'info') {
  const time = new Date().toTimeString().slice(0, 8);
  queueState.logs.unshift({ time, level, message });
  if (queueState.logs.length > 40) queueState.logs.length = 40;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitOperation(opName, runId, timeoutMs = 180_000) {
  const opPath = opName.startsWith('/') ? `/v1${opName}` : `/v1/${opName}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!queueState.running || queueState.runId !== runId) {
      return { cancelled: true };
    }
    const op = await colabRequest('GET', opPath);
    if (op.done) return op;
    await sleep(2500);
  }
  throw new Error('等待机房分配超时');
}

async function runSniperLoop(spec, baseInterval, runId) {
  let currentInterval = baseInterval;
  const accelLabel = spec.accelerator === 'NONE' ? 'CPU' : spec.accelerator;
  const shapeLabel = formatShapeShort(spec.shape);
  pushLog(`开始排队：${accelLabel} · ${shapeLabel}，间隔 ${baseInterval}s`);

  while (queueState.running && queueState.runId === runId) {
    queueState.attempts += 1;
    const attempt = queueState.attempts;
    queueState.status_text = `第 ${attempt} 次尝试分配...`;

    try {
      let op = await colabRequest('POST', '/v1beta/runtimes', {
        runtimeSpec: {
          variant: spec.variant,
          accelerator: spec.accelerator,
          shape: spec.shape,
        },
      });

      if (op.name && !op.done) {
        queueState.status_text = `第 ${attempt} 次：正在等待机房分配...`;
        op = await waitOperation(op.name, runId);
        if (op.cancelled) return;
      }

      if (op.error) {
        const msg = op.error.message || '当前机房暂无空闲算力';
        queueState.last_error = msg;
        pushLog(`第 ${attempt} 次未抢到：${msg}`, 'warn');
        currentInterval = baseInterval;
      } else {
        queueState.acquired_runtime = op.response || op;
        queueState.running = false;
        queueState.status_text = '已成功抢到算力';
        pushLog(`第 ${attempt} 次成功分配：${accelLabel} (${shapeLabel})`, 'success');
        return;
      }
    } catch (err) {
      const msg = String(err.message || err);
      queueState.last_error = msg;
      if (err.status === 401) {
        queueState.running = false;
        queueState.status_text = '登录失效，已停止';
        pushLog('OAuth 凭证已失效，队列自动停止。', 'error');
        return;
      }
      if (err.status === 429) {
        currentInterval = Math.min(currentInterval * 2, 180);
        pushLog(`触发限流 (429)，退避至 ${currentInterval}s 后重试`, 'warn');
      } else {
        pushLog(`第 ${attempt} 次失败：${msg}`, 'warn');
        currentInterval = baseInterval;
      }
    }

    for (let s = currentInterval; s > 0; s--) {
      if (!queueState.running || queueState.runId !== runId) return;
      queueState.status_text = `等待下一次重试 (${s}s)`;
      await sleep(1000);
    }
  }
}

// ==================== 共享状态与业务处理器 ====================

async function getStatusPayload() {
  const cfg = loadConfig();
  const token = await getValidAccessToken();
  const tokenObj = loadToken();
  return {
    ok: true,
    authenticated: Boolean(token),
    has_balance_scope: String(tokenObj?.scope || '').includes('userinfo.email'),
    has_client_id: Boolean(cfg.client_id),
    client_id_preview: cfg.client_id ? `${cfg.client_id.slice(0, 14)}...` : '',
    quota_project_id: cfg.quota_project_id,
    login_state: authState.status,
    login_error: authState.error,
    auth_url: authState.status === 'pending' ? authState.authUrl : '',
  };
}

async function getOverviewPayload() {
  const [subRes, rtRes, specRes, ccuRes] = await Promise.allSettled([
    colabRequest('GET', '/v1beta/subscription'),
    colabRequest('GET', '/v1beta/runtimes'),
    colabRequest('GET', '/v1beta/runtimespecs'),
    fetchCcuInfo(),
  ]);

  const errors = [];
  const subscription =
    subRes.status === 'fulfilled'
      ? subRes.value
      : (errors.push(`订阅: ${subRes.reason.message}`), {});
  const rawRuntimes =
    rtRes.status === 'fulfilled'
      ? rtRes.value.runtimes || []
      : (errors.push(`实例: ${rtRes.reason.message}`), []);
  const runtimes = await enrichRuntimesWithStatus(rawRuntimes);
  const specs =
    specRes.status === 'fulfilled'
      ? (specRes.value.runtimeSpecs || specRes.value.specs || []).map(normalizeSpec)
      : (errors.push(`规格: ${specRes.reason.message}`), []);
  const ccuInfo =
    ccuRes.status === 'fulfilled'
      ? ccuRes.value
      : { ok: false, error: ccuRes.reason?.message || '查询余额失败' };

  return {
    ok: true,
    subscription,
    ccu_info: ccuInfo,
    runtimes,
    specs,
    errors,
    fetched_at: new Date().toISOString(),
    keep_alive_enabled: keepAliveEnabled,
  };
}

// ==================== 注册 SidecarApp 路由 ====================

const app = new SidecarApp();

app.page('/', () => fs.readFileSync(INDEX_HTML_PATH, 'utf8'));

app.api('/api/status', async () => getStatusPayload());

app.api('/api/config/save', async (data = {}) => {
  try {
    if (data.raw_secret_json && String(data.raw_secret_json).trim()) {
      const parsed = parseClientSecretJson(JSON.parse(String(data.raw_secret_json)));
      if (!parsed || !parsed.client_id) {
        return {
          ok: false,
          error: '无法识别该 JSON，请粘贴从 Google Cloud 下载的桌面端 client_secret.json 全文。',
        };
      }
      const next = saveConfig({
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
        quota_project_id: data.quota_project_id || parsed.quota_project_id,
      });
      return { ok: true, quota_project_id: next.quota_project_id, has_client_id: true };
    }

    const next = saveConfig({
      client_id: data.client_id || undefined,
      client_secret: data.client_secret || undefined,
      quota_project_id: data.quota_project_id !== undefined ? data.quota_project_id : undefined,
    });
    return { ok: true, quota_project_id: next.quota_project_id, has_client_id: Boolean(next.client_id) };
  } catch (e) {
    return { ok: false, error: `配置保存失败: ${e.message}` };
  }
});

app.api('/api/auth/login', async () => {
  try {
    const { authUrl } = await startOAuthFlow();
    return { ok: true, status: 'pending', auth_url: authUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.api('/api/auth/logout', async () => {
  queueState.running = false;
  queueState.runId += 1;
  stopPendingOAuthServer();
  lastCcuInfo = null;
  clearToken();
  return { ok: true };
});

app.api('/api/overview', async () => {
  try {
    return await getOverviewPayload();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.api('/api/runtime/delete', async (data = {}) => {
  try {
    const raw = String(data.name || '').trim();
    if (!raw) return { ok: false, error: '缺少实例名称' };
    const name = raw.startsWith('runtimes/') ? raw : `runtimes/${raw}`;
    await colabRequest('DELETE', `/v1beta/${name}`);
    return { ok: true, deleted: name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.api('/api/queue/start', async (data = {}) => {
  try {
    const token = await getValidAccessToken();
    if (!token) return { ok: false, error: '请先登录 Google 账号' };

    const interval = Math.max(15, Math.min(300, Number(data.interval || 30)));
    const spec = {
      variant: String(data.variant || 'DEFAULT'),
      accelerator: String(data.accelerator || 'NONE'),
      shape: String(data.shape || 'STANDARD'),
    };

    queueState.runId += 1;
    const runId = queueState.runId;
    queueState.running = true;
    queueState.target = spec;
    queueState.interval = interval;
    queueState.attempts = 0;
    queueState.last_error = '';
    queueState.acquired_runtime = null;
    queueState.status_text = '准备排队...';

    runSniperLoop(spec, interval, runId).catch((e) => {
      pushLog(`队列异常退出：${e.message}`, 'error');
      queueState.running = false;
    });

    return { ok: true, queue: queueState };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.api('/api/queue/stop', async () => {
  if (queueState.running) {
    queueState.running = false;
    queueState.runId += 1;
    queueState.status_text = '已手动停止';
    pushLog('已手动停止排队。', 'info');
  }
  return { ok: true, queue: queueState };
});

app.api('/api/queue/status', async () => {
  return { ok: true, queue: queueState };
});

// ==================== 原生右侧「概览」面板直接挂载 ====================

const apiHandlers = {
  async status() {
    return await getStatusPayload();
  },
  async 'config.save'(data = {}) {
    if (data.raw_secret_json && String(data.raw_secret_json).trim()) {
      const parsed = parseClientSecretJson(JSON.parse(String(data.raw_secret_json)));
      if (!parsed || !parsed.client_id) {
        return {
          ok: false,
          error: '无法识别该 JSON，请粘贴从 Google Cloud 下载的桌面端 client_secret.json 全文。',
        };
      }
      const next = saveConfig({
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
        quota_project_id: data.quota_project_id || parsed.quota_project_id,
      });
      return { ok: true, quota_project_id: next.quota_project_id, has_client_id: true };
    }
    const next = saveConfig({
      client_id: data.client_id || undefined,
      client_secret: data.client_secret || undefined,
      quota_project_id: data.quota_project_id !== undefined ? data.quota_project_id : undefined,
    });
    return { ok: true, quota_project_id: next.quota_project_id, has_client_id: Boolean(next.client_id) };
  },
  async 'auth.login'() {
    const { authUrl } = await startOAuthFlow();
    return { ok: true, status: 'pending', auth_url: authUrl };
  },
  async 'auth.logout'() {
    queueState.running = false;
    queueState.runId += 1;
    stopPendingOAuthServer();
    lastCcuInfo = null;
    clearToken();
    return { ok: true };
  },
  async overview() {
    return await getOverviewPayload();
  },
  async 'runtime.keepalive'(data = {}) {
    if (typeof data.enabled === 'boolean') {
      keepAliveEnabled = data.enabled;
    }
    const rtRes = await colabRequest('GET', '/v1beta/runtimes').catch(() => ({ runtimes: [] }));
    const runtimes = await enrichRuntimesWithStatus(rtRes.runtimes || [], { triggerKeepAlive: true });
    return { ok: true, keep_alive_enabled: keepAliveEnabled, runtimes };
  },
  async 'runtime.delete'(data = {}) {
    const raw = String(data.name || '').trim();
    if (!raw) return { ok: false, error: '缺少实例名称' };
    const name = raw.startsWith('runtimes/') ? raw : `runtimes/${raw}`;
    await colabRequest('DELETE', `/v1beta/${name}`);
    return { ok: true, deleted: name };
  },
  async 'queue.start'(data = {}) {
    const token = await getValidAccessToken();
    if (!token) return { ok: false, error: '请先登录 Google 账号' };
    const interval = Math.max(15, Math.min(300, Number(data.interval || 30)));
    const spec = {
      variant: String(data.variant || 'DEFAULT'),
      accelerator: String(data.accelerator || 'NONE'),
      shape: String(data.shape || 'STANDARD'),
    };
    queueState.runId += 1;
    const runId = queueState.runId;
    queueState.running = true;
    queueState.target = spec;
    queueState.interval = interval;
    queueState.attempts = 0;
    queueState.last_error = '';
    queueState.acquired_runtime = null;
    queueState.status_text = '准备排队...';
    runSniperLoop(spec, interval, runId).catch((e) => {
      pushLog(`队列异常退出：${e.message}`, 'error');
      queueState.running = false;
    });
    return { ok: true, queue: queueState };
  },
  async 'queue.stop'() {
    if (queueState.running) {
      queueState.running = false;
      queueState.runId += 1;
      queueState.status_text = '已手动停止';
      pushLog('已手动停止排队。', 'info');
    }
    return { ok: true, queue: queueState };
  },
  async 'queue.status'() {
    return { ok: true, queue: queueState };
  },
  async dispatch(method, payload) {
    const fn = this[method];
    if (typeof fn !== 'function') throw new Error(`未知方法: ${method}`);
    return await fn.call(this, payload);
  },
};

const stopNativeOverview = startNativeOverviewIntegration(apiHandlers);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await stopNativeOverview().catch(() => {});
    process.exit(0);
  });
}

app.run();
