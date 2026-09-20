// 发布打包：构建 bobo.app → dist/bobo.app.zip（GitHub Release 资产，应用内更新直接下载它）。
// 用法：node scripts/package-release.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');

execFileSync('bash', [path.join(here, 'build-app.sh'), dist], { stdio: 'inherit' });

const app = path.join(dist, 'bobo.app');
const zip = path.join(dist, 'bobo.app.zip');
await fs.rm(zip, { force: true });
// ditto -c -k --keepParent：保留 App bundle 结构与扩展属性，解压即得 bobo.app。
execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip], { stdio: 'inherit' });

const hash = createHash('sha256');
for await (const chunk of createReadStream(zip)) hash.update(chunk);
const digest = hash.digest('hex');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.writeFile(`${zip}.sha256`, `${digest}  bobo.app.zip\n`);

console.log(`已打包 bobo v${version}：${zip}`);
console.log(`sha256: ${digest}`);
