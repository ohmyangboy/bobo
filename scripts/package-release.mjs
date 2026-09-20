// 发布打包：构建 bobo.app（Developer ID 签名）→ Apple 公证 → staple → 输出 dist/bobo.app.zip + sha256。
// 用法：node scripts/package-release.mjs
//   NOTARY_PROFILE    钥匙串里的 notarytool profile（默认 paperrss-notary）
//   NOTARY_API_KEY / NOTARY_API_KEY_ID / NOTARY_API_ISSUER_ID  用 App Store Connect API Key 代替 profile
//   BOBO_SKIP_NOTARY=1   跳过公证（只做签名与打包，用于本机验证）
//   BOBO_ALLOW_ADHOC=1   没有 Developer ID 证书时允许 ad-hoc 打包（CI 未配置签名时用）
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const app = path.join(dist, 'bobo.app');
const zip = path.join(dist, 'bobo.app.zip');
const submitZip = path.join(dist, 'bobo-notarize.zip');
const skipNotary = process.env.BOBO_SKIP_NOTARY === '1';
const allowAdhoc = process.env.BOBO_ALLOW_ADHOC === '1';
const notaryProfile = process.env.NOTARY_PROFILE || 'paperrss-notary';

const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
const capture = (file, args) => {
 const r = spawnSync(file, args, { encoding: 'utf8' });
 return { status: r.status, text: (r.stdout || '') + (r.stderr || '') };
};

execFileSync('bash', [path.join(here, 'build-app.sh'), dist], { stdio: 'inherit' });

// 1. 校验签名：发布包必须是 Developer ID + 硬化运行时。
const signature = capture('codesign', ['-dv', '--verbose=4', app]).text;
const developerId = /Authority=Developer ID Application/.test(signature);
const hardened = /flags=0x[0-9a-f]+\(runtime\)/.test(signature);
if (developerId && !hardened) throw Error('发布包缺少硬化运行时（Hardened Runtime），无法公证');
if (!developerId && !allowAdhoc) throw Error('没有 Developer ID 签名，拒绝发布（本机验证可用 BOBO_ALLOW_ADHOC=1）');
if (!developerId) console.warn('警告：使用 ad-hoc 签名打包，别人下载后会被 Gatekeeper 拦下');

// 2. Apple 公证 + 钉票据（公证修改不了已发布的 zip，必须先 staple 再重新打包）。
if (!skipNotary && developerId) {
 run('ditto', ['-c', '-k', '--keepParent', app, submitZip]);
 const notaryArgs = ['notarytool', 'submit', submitZip, '--wait'];
 if (process.env.NOTARY_API_KEY) {
  notaryArgs.push('--key', process.env.NOTARY_API_KEY, '--key-id', process.env.NOTARY_API_KEY_ID, '--issuer', process.env.NOTARY_API_ISSUER_ID);
 } else {
  notaryArgs.push('--keychain-profile', notaryProfile);
 }
 console.log(`正在提交 Apple 公证（${process.env.NOTARY_API_KEY ? 'API Key' : 'profile ' + notaryProfile}）…`);
 const result = capture('xcrun', notaryArgs);
 process.stdout.write(result.text);
 if (result.status !== 0 || !/status:\s*Accepted/i.test(result.text)) throw Error('公证未通过（状态不是 Accepted），详见上面的 notarytool 输出');
 await fs.rm(submitZip, { force: true });
 run('xcrun', ['stapler', 'staple', app]);
 run('xcrun', ['stapler', 'validate', app]);
 const gate = capture('spctl', ['-a', '-vv', '--type', 'execute', app]);
 if (gate.status !== 0 || !/Notarized Developer ID/.test(gate.text)) throw Error('Gatekeeper 评估未通过：' + gate.text.trim());
 console.log('公证与 Gatekeeper 验证通过');
}

// 3. 最终 zip（保留 App bundle 结构与扩展属性，解压即得 bobo.app）。
await fs.rm(zip, { force: true });
run('ditto', ['-c', '-k', '--keepParent', app, zip]);

const hash = createHash('sha256');
for await (const chunk of createReadStream(zip)) hash.update(chunk);
const digest = hash.digest('hex');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.writeFile(`${zip}.sha256`, `${digest}  bobo.app.zip\n`);

console.log(`已打包 bobo v${version}：${zip}`);
console.log(`sha256: ${digest}`);
