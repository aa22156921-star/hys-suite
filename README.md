# 洪英系統（打卡＋人事建檔＋薪資查詢）

一個網址、一個 App。三個原本的系統（clockin、hr-scan、薪資查詢）原封不動、照常運作；這裡是新的整合版。

| 網址 | 內容 | 來源 |
| --- | --- | --- |
| `/` | 員工打卡、補卡、請假、查薪資單 | `clockin/`（打卡原始碼的副本，之後在這裡改） |
| `/admin` | 整合後台（打卡、排班、核准、人事名冊），上方連到人事建檔、薪資查詢 | `clockin/` |
| `/hr/` | 人事掃描建檔 | `src/hr/`（複製自 hr-scan，API 改走 `/hr/api/`） |
| `/pay` | 薪資查詢 | 服務綁定 `PAY` → 原本的薪資 Worker `honyingsecurity`，每月更新照舊 |

資料庫和舊系統共用（`DB` = clockin-db、`HR` = hr-scan-db），不會分成兩份。

## 改程式
- 打卡：改 `clockin/src/*`，再執行 `cd clockin && node build.mjs && cp dist/_worker.js ../src/clockin.js`
- App：`android/`（沿用洪英打卡同一個 App 與簽章，版本 2.0.x 起跳；推上 main 會自動打包到 `dist` 分支）

## 上線
1. Cloudflare 後台 → Workers & Pages → 建立 → 匯入 Git 存放庫 → 選 `hys-suite`，名稱填 `hys`，部署指令 `npx wrangler deploy`。
   `wrangler.toml` 已寫好兩個資料庫、AI、薪資服務綁定，不用手動加。
2. `hys` → 設定 → 變數和祕密，加祕密：`ADMIN_KEY`（後台密碼）、`ADMIN_CODE`、`EDITOR_CODE`、`VIEWER_CODE`（人事建檔三組通行碼）。
3. 打開 `https://hys.aa22156921.workers.dev/admin` 確認三個系統都能用。
4. 後台 → 員工 → 「上架 GitHub 最新整合版」：已安裝洪英打卡的手機會在背景自動升級成整合版，綁定沿用、不用重綁。
