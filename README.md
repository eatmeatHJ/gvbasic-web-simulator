# GVBASIC 模擬器

在瀏覽器裡執行 GVBASIC 程式（`.BAS`、`.txt`）的純前端模擬器：不用安裝、不需要伺服器，直接開 `web/index.html` 就能用。本倉庫只有模擬器本身，**不含任何遊戲或程式**（見 [NOTICE.md](NOTICE.md)）。開發時拿網路上公開流傳的遊戲與程式實際跑過，用來檢驗模擬器的相容性；這些程式不隨本倉庫發佈。

## 使用

1. 開 [web/index.html](web/index.html)（或執行 [serve.bat](serve.bat)，用 `http://localhost:8765/` 開啟）。
2. 按「**選擇資料夾…**」，挑一個放有 `.BAS` 的資料夾（要先試試的話，[demo/](demo/) 有幾個小示範）。
3. LCD 上會出現檔案選單：`↑` `↓` 選擇、`Enter` 開啟／執行、`←` 或 `Esc` 回上層。右邊面板是同一份清單，也可以用滑鼠點。
4. 程式結束後按任意鍵回到選單；按「■ 停止」也會回到選單。

資料夾與檔案：**BAS** 是程式，**DAT** 是資料檔；程式 `OPEN "名稱"` 時檔名會自動補上 `.DAT`，並且在「程式所在的資料夾」裡讀寫。Chrome／Edge 可以把存檔直接寫回實體資料夾（第一次需要授權）；其他瀏覽器只能讀取，寫出的 DAT 暫存在瀏覽器，可以用「下載」取出。

## 支援什麼

- **GVBASIC 語言**：`.BAS` 的 token 位元組直接解析執行（沒有轉換步驟）。運算式與數字格式、字串函式、`FOR`／`WHILE`／`GOSUB`／`DEF FN`、`DATA`／`READ`、循序檔與隨機檔（`OPEN`／`INPUT#`／`WRITE#`／`FIELD`／`LSET`／`RSET`／`GET`／`PUT`）、繪圖（`GRAPH`／`BOX`／`LINE`／`CIRCLE`／`DRAW`…）、`PLAY`／`BEEP`、`RND`，以及 `INKEY$` 的按鍵碼。
- **編輯**：像真機的行編輯器（`F4` 修改、`F1` 新增、`F2` 刪除），支援 Big5 與 GBK 的中文；沒改的行存檔時原封不動，只有改過的行才重新轉成 token。
- **文字檔**：行號加敘述的 `.txt` 程式可以「轉成 BAS」（存成同名 `.BAS`）、「試跑（不存檔）」；`.BAS` 也能「存成 TXT」，轉回來得到同一支程式。命令列版：`node tools/txt2bas.js <檔案或資料夾> -o 輸出資料夾`（`--charset auto|big5|gbk`）。用到擴充語法（`SLEEP`、`PAINT`、`FREAD`、`OPEN … FOR BINARY` 等，標準 GVBASIC 沒有）的文字檔，網頁轉換前會先確認、命令列要加 `--ext`；轉出的 `.BAS` 只能在這個模擬器執行，載入與編輯時會自動認得這些語法。
- **機器碼**：`CALL` 會在模擬的 6502 上執行（CPU 通過 Klaus Dormann 的標準功能測試，系統常式用 JS 重寫）；小型 `.BIN` 可以直接執行，大型機器碼映像（整數頁 × 32 KB 的 `.bin`）可以「安裝」，程式存進快閃的存檔會留在瀏覽器裡。
- **畫面與字型**：英數字、GB2312 中文字、圖形字和小字用機器的點陣字型畫；Big5 的字用系統字型；圖形字有兩種編號，會依程式自動判斷（[docs/圖形字編號.md](docs/圖形字編號.md)）。
- **鍵盤與輸入**：按鍵碼表見 [docs/按鍵碼.md](docs/按鍵碼.md)；鍵盤預設「直接輸入」（不受系統輸入法影響），要打中文時切到中文輸入法；`INPUT` 進行中顯示大小寫；執行中或編輯時誤按 `F5` 會被攔下。
- **速度與聲音**：BASIC 速度、機器碼速度、影格率都可以在側欄調整；`BEEP`／`PLAY` 用 Web Audio 發聲。

## 目錄

| 路徑 | 內容 |
|---|---|
| `web/index.html`, `app.js` | 介面：LCD、按鍵、檔案選單、側邊面板 |
| `web/gvb.js` | 直譯器 + 虛擬裝置（螢幕、按鍵、DAT 儲存區、原始碼還原、文字 ↔ token） |
| `web/editor.js` | 行編輯器（與介面無關的純邏輯） |
| `web/cpu6502.js`, `syscalls.js`, `hwlayer.js`, `flash.js`, `asm6502.js` | 6502 CPU、系統常式（JS 版）、直接操作硬體的程式、大型映像的分頁與按鍵、小組譯器 |
| `web/fsys.js` | 資料夾存取層（實體資料夾／瀏覽器唯讀後端、DAT 載入與寫回） |
| `web/tokens.js`, `web/font.js`, `web/fonts.js` | 由 `tools/build_web.py` 產生：token 表與點陣字型資料（來源見 [NOTICE.md](NOTICE.md)；重新產生需要 arucil 專案的 `res/`） |
| `tools/` | `txt2bas.js`（文字 → `.BAS`）、`gvb_tokens.json`（token 表）、`gvb_detok.py`（`.BAS` → 文字）、`build_web.py`、`make_demo.js` |
| `docs/` | 按鍵碼、圖形字編號、官方轉換程式的 token 表 |
| `demo/` | 三個小示範（`HELLO.BIN`、`DRAW.BIN`、`CALLDEMO.BAS`） |

## 測試

都是 Node，不需要瀏覽器：

```
node web/test_compat.js        # 語言細節：運算子優先順序、數字格式、RND、隨機檔、檔案錯誤名稱、按鍵碼……
node web/test_txt2bas.js       # 文字 <-> BAS 轉換、編碼、錯誤收集
node web/test_editor_charset.js# 編輯器照檔案的字集（Big5／GBK）顯示與重新編碼
node web/test_extensions.js    # 其他模擬器的擴充語法（SLEEP、PAINT…）：轉換與執行
node web/test_machinecode.js   # 機器碼、系統調用、與 BASIC 共用記憶體、小型 BIN
node web/test_flash.js         # 大型映像的分頁、系統常式、快閃指令、字集轉換
node web/test_hw.js            # 直接操作硬體的程式（計時器旗標、鍵盤矩陣、CPU 休眠）
node web/test_lcdfont.js       # 點陣字型的索引與字形、圖形字編號
node web/test_timing.js        # 執行速度、PLAY 字串、BEEP／PLAY 與主機音訊
node web/test_cpu.js           # 6502 CPU（完整功能測試需要另外下載測試檔，見 NOTICE.md）
```

需要真實程式或映像的部分（例如 `test_txt2bas.js` 的整支程式往返比對、`test_cpu.js` 的完整功能測試）在找不到那些檔案時會自動略過。

## 授權

MIT，見 [LICENSE](LICENSE)；用到的第三方資料與致謝見 [NOTICE.md](NOTICE.md)。這是非官方的模擬器，與任何硬體或軟體廠商沒有隸屬關係。
