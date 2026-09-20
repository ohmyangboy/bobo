// dev 模式下由 Tauri CLI 通过 beforeDevCommand 拉起服务；打包后由 Rust 侧的 service::ensure 负责。
// 两边都先探测 4318：已经在跑（例如主项目的 bobo.app，或另一个 dev 实例）就直接复用，不重复启动。
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const PORT = 4318;
const inUse = () => new Promise(resolve => {
  const socket = net.connect(PORT, '127.0.0.1');
  const done = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  setTimeout(() => done(false), 800);
});

if (await inUse()) {
  console.log(`4318 已有服务在跑，dev 直接复用（改了主项目服务端代码的话，要重启那个服务才会生效）`);
  process.exit(0);
}

const runtime = path.resolve(import.meta.dirname, '..', 'runtime');
const child = spawn(process.execPath, [path.join(runtime, 'src', 'server.mjs')], {
  cwd: runtime,
  stdio: 'inherit',
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', code => process.exit(code ?? 0));
