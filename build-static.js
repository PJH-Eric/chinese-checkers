/*
 * build-static.js — 產生 GitHub Pages 用的靜態版本到 dist/
 * 靜態版沒有伺服器，因此只保留「本機對戰」（對電腦 / 同一台裝置輪流）。
 * 用法：node build-static.js [線上版網址]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist');
// 連線對戰版網址（部署在 Render）。可用 CLI 參數或 ONLINE_URL 環境變數覆蓋。
const DEFAULT_ONLINE_URL = 'https://chinese-checkers-7p4g.onrender.com/';
const ONLINE_URL = process.argv[2] || process.env.ONLINE_URL || DEFAULT_ONLINE_URL;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const name of fs.readdirSync(SRC)) {
  fs.copyFileSync(path.join(SRC, name), path.join(OUT, name));
}

let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');

// 注入離線旗標
html = html.replace('<script src="game.js"></script>',
  '<script>window.OFFLINE_ONLY = true;</script>\n<script src="game.js"></script>');

// 標題與說明改成離線版口吻
html = html.replace('<title>跳棋 · 線上對戰</title>', '<title>跳棋 · 單機版</title>');
html = html.replace(
  '<p class="tagline">六角星 121 格 · 標準跳法 · 最多 3 人線上對戰</p>',
  '<p class="tagline">六角星 121 格 · 標準跳法 · 對電腦或多人輪流同一台裝置</p>');

// 有線上版網址的話，補一條連結
if (ONLINE_URL) {
  html = html.replace('<button id="btn-rules-lobby" class="link-btn">查看規則說明</button>',
    '<p class="tagline" style="margin-bottom:10px">想跟朋友<b>線上連線對戰</b>？' +
    '<a href="' + ONLINE_URL + '" style="color:#7aa2ff">開啟連線版 →</a></p>\n' +
    '    <button id="btn-rules-lobby" class="link-btn">查看規則說明</button>');
}

fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log('已產生靜態版本：dist/');
console.log('檔案：', fs.readdirSync(OUT).join(', '));
if (ONLINE_URL) console.log('線上版連結：', ONLINE_URL);
