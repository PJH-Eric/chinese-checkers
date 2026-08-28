# 跳棋 · 網頁版

六角星 121 格中國跳棋，標準跳法。兩種玩法：

- **線上對戰**：房間配對，**最多 3 人**連線對局，人數不足可用電腦 AI 補位（需要跑 Node 伺服器）
- **本機對戰**：對電腦，或多人輪流用同一台裝置（純前端，靜態網頁就能跑）

[![Tests](https://github.com/PJH-Eric/chinese-checkers/actions/workflows/test.yml/badge.svg)](https://github.com/PJH-Eric/chinese-checkers/actions/workflows/test.yml)

線上試玩：

- **單機版**（對電腦 / 同裝置輪流）：<https://pjh-eric.github.io/chinese-checkers/>
- **連線對戰版**（最多 3 人）：<https://chinese-checkers-7p4g.onrender.com/>

> 連線版跑在 Render 免費方案，閒置約 15 分鐘會休眠，第一個連進來的人要等幾秒喚醒。

部署方式見 [DEPLOY.md](DEPLOY.md)。

- 前端：原生 HTML / CSS / SVG，無前端框架
- 後端：Node.js + Express + `ws`（WebSocket），**權威式伺服器**，所有走法都在伺服器驗證
- 規則引擎 `public/game.js` 前後端共用，前端只用它做走法提示，不影響勝負判定

## 快速開始

```bash
npm install
npm start
# 開啟 http://localhost:3000
```

Windows 可以直接雙擊 `start.bat`（會自動安裝相依套件、啟動伺服器並開啟瀏覽器）。

> `start.bat` 內容刻意全部使用英文 ASCII。cmd.exe 是以系統預設編碼（繁中 Windows 為 CP950）逐行讀取批次檔的，
> 批次檔若含 UTF-8 中文會被解碼成亂碼，連 `echo`、`if` 等指令都可能被吃掉導致整段流程失效。
> 其他檔案（`.js` / `.md` / `.html` / `.css`）維持無 BOM UTF-8，不受影響。

若批次檔在你的環境仍有問題，手動兩行也一樣：

```bat
cd /d "C:\Eric\AI Agent\chinese-checkers"
npm install
npm start
```

公司 proxy 擋住 npm 時，先設定：

```bat
npm config set proxy http://user:pass@proxy.host:port
npm config set https-proxy http://user:pass@proxy.host:port
```

想讓同區網的朋友連進來，用你的內網 IP，例如 `http://192.168.1.20:3000`。

### Docker

```bash
docker compose up -d --build
# 或
docker build -t checkers . && docker run -p 3000:3000 checkers
```

### 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `3000` | 監聽埠 |
| `HOST` | `0.0.0.0` | 監聽位址 |
| `AI_DELAY_MS` | `700` | 電腦思考後的落子延遲（毫秒） |
| `MAX_ROOMS` | `500` | 同時存在的房間數上限 |

## 怎麼玩

1. 首頁輸入暱稱 → **建立房間**（選 3 人局或 2 人局），拿到 4 碼房號。
2. 朋友可以用兩種方式進來：在首頁 **公開房間** 列表直接點「加入」，或輸入 4 碼房號。
3. 人數不夠時，房主可在空位按 **加入電腦**，並選擇簡單 / 普通 / 困難。
4. 座位滿了之後房主按 **開始遊戲**。
5. 輪到你時，點自己的棋子會亮出所有合法落點（白點＝單步，黃點＝跳躍），滑過落點會顯示連跳路徑，點下去就走。

## 多房間

一台伺服器可以同時開很多間房，彼此完全獨立：

- 房號為 4 碼（`A–Z` 去掉易混淆字母 + `2–9`），約 100 萬種組合，預設同時最多 `MAX_ROOMS`（500）間。
- 首頁的 **公開房間** 列表即時推播（WebSocket），有人開房、加入、補 AI 都會立刻更新；也可以用 `GET /api/rooms` 查詢。
- 建房時勾 **不公開**，房間就不會出現在列表上，只有拿到房號的人進得來。
- 開局後房間自動從列表移除；未開局的房間所有人離開後立即回收，已開局的房間保留 30 分鐘供斷線重連。
- 若房主在開局前離開，會自動由還在線上的玩家遞補為房主，不會卡住。

## 斷線與離線

斷線會自動重連並回到原座位（座位憑證存在瀏覽器 localStorage）。若有人長時間離線，房主可按 **AI 接手** 讓棋局繼續。

## 規則

**棋盤**：六角星 121 格，六個角各 10 格為陣營；中央正六邊形 61 格。
`121 = 91 + 91 − 61`（兩個邊長 13 的大三角形聯集）。

**佈局**：每人 10 顆棋子，一律使用**相間**的角——3 人局用上、右下、左下；2 人局用上、右下。
目標是自己**正對面**的三角形，因此每個人的目標三角形開局時都是空的，不會是別人的出發陣營。

**走法**（一回合擇一）：

- **單步**：往六個相鄰方向之一走到空格。
- **跳躍**：緊鄰有一顆棋子（敵我皆可），且其正後方為空格時可跳過去；沒有吃子。跳完若還能跳可以**連跳**，連跳算同一步。
- 單步與跳躍不可混用。

**限制**：

- 連跳途中**可以經過**其他玩家的出發／目標陣營（中繼落點允許落在裡面），但**不能停**在裡面。
- 棋子進入自己的目標陣營後不得再離開（仍可在陣營內移動）。

**勝負**：先把 10 顆全部送進對面三角形者獲勝。若目標陣營被對手卡住無法清空，只要 10 格全滿且其中至少有你一顆棋子，同樣算達陣。其餘玩家繼續比名次。

## 專案結構

```
public/game.js       規則引擎（立方座標棋盤、走法生成、勝負判定）— 前後端共用
public/ai.js         電腦對手（貪婪指派評估 + 難度擾動）— 前後端共用
public/local.js      本機對戰引擎：在瀏覽器內模擬伺服器，吐同樣的 sync 快照
public/client.js     前端：大廳、房間、SVG 棋盤與互動（連線／本機共用同一套 UI）
public/index.html
public/style.css
server.js            Express + WebSocket，多房間配對、大廳列表與權威式對局
build-static.js      產生 GitHub Pages 用的靜態單機版到 dist/
start.bat            Windows 一鍵啟動（自動 npm install 並開瀏覽器）
push-to-github.bat   Windows 一鍵推上 GitHub
test/rules.test.js   規則與 AI 自我對弈測試
.github/workflows/   Pages 自動部署、CI 測試
render.yaml          Render 一鍵部署連線版
```

## 為什麼同一套 UI 能跑兩種模式

`public/local.js` 實作了跟 WebSocket 伺服器**完全相同的訊息協定**——吃 `move` / `restart`，
吐 `welcome` / `sync` 快照。`client.js` 的 `send()` 只是判斷要送去 WebSocket 還是本機引擎，
棋盤渲染、走法提示、動畫、棋譜全部共用。靜態版由 `build-static.js` 注入 `window.OFFLINE_ONLY`，
把所有連線相關的 UI 隱藏起來。

## 測試

```bash
npm test
```

涵蓋棋盤結構、開局合法走法數、跳躍與陣營限制、勝負判定，以及 AI 三人／兩人自我對弈能否正常收官。

## 技術筆記

棋盤用立方座標 `(x, y, z)`，`x + y + z = 0`：

- 大三角形 A：`x ≤ 4 && y ≤ 4 && z ≤ 4`（91 格）
- 大三角形 B：`x ≥ −4 && y ≥ −4 && z ≥ −4`（91 格）
- 兩者交集為半徑 4 的正六邊形（61 格），聯集即六角星 121 格

相鄰方向為 6 個立方向量；跳躍即同方向 2 格。連跳用 BFS 展開，走子時起點視為空格。

AI 評估採**貪婪指派**：把目標三角形「最深的格子」配給距離它最近的棋子，總距離為 0 時剛好全部歸位。這讓殘局仍有明確梯度，AI 不會卡在 8/10 來回震盪。
