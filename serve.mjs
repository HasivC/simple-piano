#!/usr/bin/env node
/**
 * 零依赖静态服务器：把本目录跑在局域网里，手机连同一个 Wi-Fi 就能打开。
 *
 *   node serve.mjs           # 默认 8080 端口
 *   node serve.mjs 5173      # 指定端口
 *
 * 终端会打印 http://<你的电脑IP>:<端口>/  —— 在手机浏览器里输入即可。
 * 提示：手机浏览器里选择「添加到主屏幕」，就能像 App 一样全屏打开。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(here, url === '/' ? 'index.html' : url);

  if (!file.startsWith(here)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) {
      file = path.join(here, 'index.html');
    }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
    });
  });
});

function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(i => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}

server.listen(port, '0.0.0.0', () => {
  console.log('PIANO 已启动：');
  console.log('  本机：  http://localhost:' + port + '/');
  lanIPs().forEach(ip => console.log('  手机：  http://' + ip + ':' + port + '/'));
  console.log('\n（手机需与本机在同一 Wi-Fi；按 Ctrl+C 停止）');
});
