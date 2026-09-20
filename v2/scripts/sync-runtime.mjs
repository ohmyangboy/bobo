// 把主项目的服务端模块与网页资源复制到 v2/runtime/（构建产物，已在 .gitignore）。
// 主项目保持唯一真源：本脚本只读不写，绝不改动 ../ 下的任何文件。
// 模块清单从 src/server.mjs 的 import 图自动收集，主项目新增服务端模块时不用手工维护（历史上漏过 terminals.mjs）。
// 主项目的 src/ 结构原样保留（runtime/src/），public/ 平铺在 runtime 根，相对引用两边都成立。
import fs from 'node:fs/promises';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'runtime');

// 从入口出发收集所有本地模块；public/ 下的由整目录复制负责，这里跳过。
async function collect(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.includes('public/')) continue;
      const target = path.normalize(path.join(path.dirname(file), spec));
      if (!seen.has(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

const modules = await collect('src/server.mjs');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
for (const name of ['package.json', ...modules]) {
  const dest = path.join(out, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(path.join(root, name), dest);
}
await fs.cp(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
// 记录当前 node 的绝对路径：GUI 应用（尤其 macOS）拿不到用户 shell 的 PATH，
// 打包后据此启动服务；找不到时 Rust 侧还会退回常见安装位置与 PATH 扫描。
await fs.writeFile(path.join(out, 'node-path'), process.execPath, 'utf8');

console.log(`已同步 runtime：${modules.length} 个服务端模块 + public/ → ${path.relative(root, out)}`);
console.log(`模块：${modules.join('、')}`);
console.log(`node: ${process.execPath}`);
