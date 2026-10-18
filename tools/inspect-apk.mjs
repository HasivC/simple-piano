/**
 * APK 体检：直接读 zip 的本地文件头，检查三件事
 *   1. 条目名有没有被写成反斜杠（Windows 版 aapt2 的坑，写反了 Android 就找不到 assets/icons/...）
 *   2. resources.arsc 是否以 STORED 存放（targetSdk >= 30 时必须是未压缩）
 *   3. resources.arsc 的数据偏移是否 4 字节对齐（同上，否则安装直接失败）
 *
 *   node tools/inspect-apk.mjs dist\PIANO-1.0.apk
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('用法: node tools/inspect-apk.mjs <apk>'); process.exit(2); }
const buf = fs.readFileSync(file);

let bad = 0;
const rows = [];
let i = 0;
const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);   /* PK\x03\x04 */

while (true) {
  const at = buf.indexOf(SIG, i);
  if (at < 0) break;
  const method = buf.readUInt16LE(at + 8);
  const compSize = buf.readUInt32LE(at + 18);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const name = buf.toString('utf8', at + 30, at + 30 + nameLen);
  const dataAt = at + 30 + nameLen + extraLen;
  rows.push({ name, method: method === 0 ? 'STORED' : ('DEFLATE(' + method + ')'), dataAt, compSize });
  i = dataAt + compSize;
}

console.log('条目数：' + rows.length + '\n');

const backslash = rows.filter(r => r.name.includes('\\'));
if (backslash.length) {
  bad++;
  console.log('✗ 条目名用了反斜杠（Android 会找不到）：');
  backslash.forEach(r => console.log('    ' + r.name));
} else {
  console.log('✓ 所有条目名都用 / 分隔');
}

const arsc = rows.find(r => r.name === 'resources.arsc');
if (!arsc) {
  bad++;
  console.log('✗ 找不到 resources.arsc');
} else {
  if (arsc.method === 'STORED') console.log('✓ resources.arsc 未压缩 (STORED)');
  else { bad++; console.log('✗ resources.arsc 被压缩了 (' + arsc.method + ')，Android 11+ 会拒绝安装'); }
  if (arsc.dataAt % 4 === 0) console.log('✓ resources.arsc 数据偏移 4 字节对齐 (' + arsc.dataAt + ')');
  else { bad++; console.log('✗ resources.arsc 未 4 字节对齐 (偏移 ' + arsc.dataAt + ')'); }
}

const need = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/index.html', 'assets/app.js', 'assets/audio.js'];
const names = new Set(rows.map(r => r.name));
const missing = need.filter(n => !names.has(n));
if (missing.length) { bad++; console.log('✗ 缺少必要条目：' + missing.join(', ')); }
else console.log('✓ 关键条目齐全（manifest / dex / resources.arsc / assets）');

/* assets 必须全平铺：带子目录时 Windows 版 aapt2 会写成反斜杠（见上） */
const nested = rows.filter(r => /^assets\/.+\//.test(r.name));
if (nested.length) {
  bad++;
  console.log('✗ assets 下存在子目录，Windows 版 aapt2 会写坏路径：' + nested.map(r => r.name).join(', '));
} else {
  console.log('✓ assets 全平铺，无子目录');
}

const needIcons = ['assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png',
  'assets/apple-touch-icon.png', 'assets/favicon-32.png'];
const missIcons = needIcons.filter(n => !names.has(n));
if (missIcons.length) { bad++; console.log('✗ 缺少图标：' + missIcons.join(', ')); }
else console.log('✓ 5 个图标都在 assets 根目录');

/* 确认 APK 里的 index.html 已经把 icons/ 前缀去掉（否则图标路径对不上） */
const idx = rows.find(r => r.name === 'assets/index.html');
if (idx) {
  const raw = buf.slice(idx.dataAt, idx.dataAt + idx.compSize);
  let text;
  if (idx.method === 'STORED') text = raw.toString('utf8');
  else {
    const zlib = await import('node:zlib');
    try { text = zlib.inflateRawSync(raw).toString('utf8'); } catch (e) { text = ''; }
  }
  if (/icons\//.test(text)) { bad++; console.log('✗ APK 内 index.html 仍引用 icons/ 前缀'); }
  else console.log('✓ APK 内 index.html 的图标路径已拍平');
}

/* 资源图标 + dex + 签名条目一览 */
const misc = rows.filter(r => /^res\/mipmap|^META-INF/.test(r.name));
console.log('  资源与签名：' + misc.map(m => path.basename(m.name)).join(', '));

console.log('\n' + (bad ? '发现 ' + bad + ' 个问题' : 'APK 结构检查全部通过'));
process.exit(bad ? 1 : 0);
