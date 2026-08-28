# 部署說明

這個專案有兩個形態：

| 形態 | 內容 | 放哪裡 |
| --- | --- | --- |
| **靜態單機版** | 對電腦、或多人輪流用同一台裝置 | GitHub Pages（免費、免維護） |
| **連線對戰版** | 房間大廳、最多 3 人線上對戰、觀戰、邀請連結 | Render / Railway / 自架（需要能跑 Node + WebSocket） |

GitHub Pages 只服務靜態檔案，跑不了 Node 伺服器，所以線上對戰、觀戰、邀請連結一定要另外找地方跑。

執行環境一律用 **Node.js 24 LTS**（Dockerfile、render.yaml、GitHub Actions、`.nvmrc` 都已對齊）。

---

## 步驟 1：把程式碼推上 GitHub

1. 到 <https://github.com/new> 建一個**空的** repo，名稱 `chinese-checkers`
   （**不要**勾 Add a README／.gitignore／license，否則第一次 push 會衝突）。
2. 回到專案資料夾，雙擊 **`push-to-github.bat`**。

腳本會自動 `git init` → `commit` → `push`。第一次會跳出 GitHub 登入視窗，或要你輸入
Personal Access Token 當密碼（到 <https://github.com/settings/tokens> 產生，勾 `repo` 權限）。

> 公司 proxy 擋 github.com 的話，先設定：
> ```bat
> git config --global http.proxy http://user:pass@proxy.host:port
> git config --global https.proxy http://user:pass@proxy.host:port
> ```

---

## 步驟 2：開啟 GitHub Pages（靜態單機版）

在 repo 頁面：**Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。

之後每次 push 到 `main`，`.github/workflows/pages.yml` 會自動：

1. 跑 `node build-static.js` 產生 `dist/`（把 `public/` 加上離線旗標，隱藏所有連線功能）
2. 部署到 Pages

網址會是 **<https://pjh-eric.github.io/chinese-checkers/>**

第一次部署約 1～2 分鐘，進度可在 repo 的 **Actions** 分頁看。

---

## 步驟 3（選用）：連線對戰版部署到 Render

Render 免費方案支援 WebSocket，`render.yaml` 已經寫好：

1. 到 <https://render.com> 用 GitHub 帳號登入
2. **New → Blueprint** → 選這個 repo → Apply
3. 等它 build 完，會拿到類似 `https://chinese-checkers-xxxx.onrender.com` 的網址

> 免費方案閒置約 15 分鐘會休眠，第一個人連進來要等幾秒喚醒；喚醒後就正常。
> 休眠時房間會清空（本專案的房間狀態存在記憶體）。

**把兩邊接起來**：`build-static.js` 裡的 `DEFAULT_ONLINE_URL` 已經填好目前的 Render
網址，單機版首頁會自動出現「開啟連線版 →」的連結，不需要額外設定。

換了網址的話，兩種改法擇一：

- 直接改 `build-static.js` 的 `DEFAULT_ONLINE_URL`（最簡單）
- 或在 repo 的 **Settings → Secrets and variables → Actions → Variables → New
  repository variable** 新增 `ONLINE_URL`，值填新網址（會覆蓋上面的預設值）

### 其他選擇

| 平台 | 備註 |
| --- | --- |
| Railway | 同樣支援 WebSocket，`npm ci && node server.js` 即可 |
| Fly.io | 專案已有 `Dockerfile`，`fly launch` 會自動辨識 |
| 自架 / 公司內網 | `docker compose up -d --build`，或直接 `npm ci && node server.js` |

自架時記得設 `PORT`，並讓反向代理（nginx / IIS）**允許 WebSocket 升級**：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

---

## 本機預覽靜態版

```bash
node build-static.js
npx serve dist        # 或任何靜態伺服器
```

直接用 `file://` 開 `dist/index.html` 也可以，功能一樣。
