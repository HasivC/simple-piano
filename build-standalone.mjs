#!/usr/bin/env node
/**
 * 把 index.html / styles.css / audio.js / app.js 打包成一个自包含的 HTML 文件，
 * 方便直接发到手机上（微信、邮件、AirDrop、U 盘）用浏览器打开。
 *
 *   node build-standalone.mjs
 *   -> piano-standalone.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(here, f), 'utf8');

let html = read('index.html');

// 内联样式
html = html.replace(
  /<link rel="stylesheet" href="styles\.css">/,
  () => `<style>\n${read('styles.css')}\n</style>`
);

// 内联脚本（保持顺序）
html = html.replace(
  /<script src="audio\.js"><\/script>\s*<script src="app\.js"><\/script>/,
  () => `<script>\n${read('audio.js')}\n</script>\n<script>\n${read('app.js')}\n</script>`
);

// 单文件里 manifest / service worker 无法工作，去掉引用
html = html.replace(/<link rel="manifest"[^>]*>\s*/, '');

// 图标内联成 data URI：单文件发到手机上，iOS「添加到主屏幕」才能拿到正确图标
const touchIcon = fs.readFileSync(path.join(here, 'icons', 'apple-touch-icon.png')).toString('base64');
html = html.replace(/\s*<link rel="icon"[^>]*>/g, '');
html = html.replace(/\s*<link rel="apple-touch-icon"[^>]*>/g, '');
html = html.replace(
  '</title>',
  '</title>\n<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,' + touchIcon + '">'
);

html = html.replace('<title>PIANO</title>', '<title>PIANO（单文件版）</title>');

if (/<script src=|<link rel="stylesheet"/.test(html)) {
  console.error('打包失败：仍有未内联的外部资源。');
  process.exit(1);
}

const out = path.join(here, 'piano-standalone.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成 ' + out + '  (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
