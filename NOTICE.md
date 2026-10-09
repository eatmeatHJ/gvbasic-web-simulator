# 第三方資料與致謝

本專案（MIT 授權，見 [LICENSE](LICENSE)）是文曲星／哈電族 GVBASIC 的非官方瀏覽器模擬器。**本倉庫不含任何遊戲、拿來測試的程式、音樂、韌體或 ROM 映像。** 要試的程式請自己準備（放在任何資料夾，用「選擇資料夾…」開啟）。下面是用到、但不屬於本專案原創的東西。

## 隨本倉庫發佈的

- **機器的點陣字型**（`web/fonts.js`、`web/font.js`）：ASCII、GB2312 漢字、527 個圖形字與 12×12 小字。資料取自 [arucil/gvbasic-simulator4cpp](https://github.com/arucil/gvbasic-simulator4cpp) 的 `res/`（MIT 授權，全文在下面）；那些資料原本出自機器的 ROM，所以請把它們當成參考資料看待。若你是權利人、希望移除，請開 issue，我們會處理。
- **語言行為**：`INKEY$`、數字格式、`RND`、`LSET`／`FIELD` 等的行為是在 NC3000 真機韌體上實測得來（只記錄事實，見 `docs/NC3000韌體.md`），並參考 arucil 的模擬器與 [fancyblock/GVBASIC](https://github.com/fancyblock/GVBASIC)（MIT）的文件與測試筆記。沒有複製它們的原始碼。

### arucil/gvbasic-simulator4cpp 的授權（MIT）

```
The MIT License (MIT)

Copyright (m_c) 2015 plodsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 不隨本倉庫發佈、但測試或文件會提到的

- **Klaus Dormann 的 6502 功能測試**（GPL v3，<https://github.com/Klaus2m5/6502_65C02_functional_tests> 的 `bin_files/6502_functional_test.bin`）：`web/test_cpu.js` 用它；沒有這個檔就略過那一項。要跑的話下載後放在 `ref/cputest/`。
- **WQXEmu**（GPL v3）：只參考它文件裡的記憶體配置等事實，沒有使用它的程式碼。
- **NC3000 韌體與官方仿真器**：用來分析與驗證行為。本專案不含也不散布它們；`tools/nc3000/` 只有我們自己寫的分析工具，韌體要自己從官方安裝檔取出（見 `tools/nc3000/README.md`）。
- **任何遊戲或程式**：模擬器能不能執行某個程式，不代表該程式可以任意散布；請尊重各程式作者的授權。

## 商標

「文曲星」、「哈電族」等名稱屬於各自的權利人；本專案與它們沒有隸屬關係，也不是官方產品。
