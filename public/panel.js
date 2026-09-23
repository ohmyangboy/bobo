// 通知岛面板：订阅 /api/opencode/stream（NDJSON，每次收到整份快照），驱动胶囊里的头像、额度与设备指示。
// 这里只做「看得见的部分」；窗口尺寸由 Rust 侧按内容回报调整（见 v2/src-tauri/src/island.rs）。
const token = document.querySelector('meta[name=token]').content;
const avatars = document.getElementById('avatars');
const quota = document.getElementById('quota');
const device = document.getElementById('device');
const network = document.getElementById('network');
const hint = document.getElementById('hint');

// 会话状态色：蓝=运行中、橙=等你回答、绿=已结束、红=已终止（与 Swift 版一致）。
const stateColors = { working: '#0a84ff', waiting: '#ff9f0a', idle: '#30d158', error: '#ff453a' };
// 头像底色：由会话 ID 稳定哈希从 8 色板取值，保证同一会话颜色固定。
const palette = ['#ff6b6b', '#f0a04b', '#f2c14e', '#7bc86c', '#4cb3d4', '#7b8ff0', '#b57bec', '#eb7bc0'];
function hash(text) {
  let value = 0;
  for (const char of String(text)) value = (value * 31 + char.codePointAt(0)) >>> 0;
  return value;
}
const compact = value => {
  const n = Number(value) || 0;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return (Math.round(n * 10) / 10).toString();
  return (Math.round(n * 100) / 100).toString();
};
// 速率文案（与网页「设备 → 网络」同一套口径）：1024 进制，B/s / KB/s / MB/s。
const rate = value => {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1024) return Math.round(n) + 'B/s';
  if (n < 1024 * 1024) return compact(n / 1024) + 'KB/s';
  return compact(n / 1024 / 1024) + 'MB/s';
};

function render(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const visible = sessions.filter(s => s.state === 'working' || s.state === 'waiting' || (s.acked !== true && (s.state === 'idle' || s.state === 'error'))).slice(0, 8);
  avatars.replaceChildren(...visible.map(session => {
    const el = document.createElement('span');
    el.className = 'avatar';
    el.style.background = palette[hash(session.id) % palette.length];
    el.textContent = (session.title || '?').trim().slice(0, 1).toUpperCase();
    return el;
  }));
  const waiting = sessions.filter(s => s.state === 'waiting').length;
  const running = sessions.filter(s => s.state === 'working').length;
  hint.textContent = waiting ? `${waiting} 个等你回答` : running ? `${running} 个运行中` : (visible.length ? `${visible.length} 个会话` : 'bobo');
  // 额度与设备指示：数据缺失时整块隐藏（与 Swift 版的 `device` 字段缺失时一致）。
  const provider = (snapshot?.usage?.providers || []).find(p => p.id === snapshot?.usage?.selected && p.available && p.enabled);
  const percent = provider?.windows?.[0]?.usedPercent;
  quota.textContent = percent === undefined || percent === null ? '' : `额度 ${compact(percent)}%`;
  quota.classList.toggle('hidden', quota.textContent === '');
  const memory = snapshot?.device?.memory?.usedPercent;
  const disk = snapshot?.device?.disk?.usedPercent;
  device.textContent = memory === undefined || memory === null ? '' : `内存 ${compact(memory)}% · 磁盘 ${compact(disk)}%`;
  device.classList.toggle('hidden', device.textContent === '');
  // 网络：延迟与上下行速率（macOS 原生面板画的是三枚灯珠，这里是同一份快照的文字版）。
  const latency = snapshot?.network?.latency?.ms;
  network.textContent = latency === undefined || latency === null ? '' : `延迟 ${Math.round(latency)}ms · ↓${rate(snapshot?.network?.download?.bytesPerSec)} ↑${rate(snapshot?.network?.upload?.bytesPerSec)}`;
  network.classList.toggle('hidden', network.textContent === '');
}

// 面板宽度随内容变化：测出 #island 的实际尺寸后回报 Rust（窗口是无边框透明窗，尺寸必须跟着内容走，
// 否则点击区域与画面不一致）。折叠态高度固定，展开态由内容决定。
let fitted = { width: 0, height: 0 };
async function fit() {
  const el = document.getElementById('island');
  const width = Math.ceil(el.getBoundingClientRect().width);
  const height = Math.ceil(el.getBoundingClientRect().height);
  if (width === fitted.width && height === fitted.height) return;
  fitted = { width, height };
  try { await window.__TAURI__?.core?.invoke('island_resize', { width, height }); } catch {}
}

async function watch() {
  try {
    const response = await fetch('/api/opencode/stream', { headers: { 'x-bobo-token': token } });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { render(JSON.parse(line)); } catch {}
        await fit();
      }
    }
  } catch {}
  setTimeout(watch, 2000);
}
watch();
