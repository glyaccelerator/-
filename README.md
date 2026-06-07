# 习思题库采集工具

这个工具会打开一个真实浏览器，由你手动登录雨课堂/习思并正常进入题目页面。脚本只监听和整理你登录后能正常看到的数据，不处理验证码、不绕过权限、不破解接口。

## 安装

```powershell
npm install
npm run install-browsers
```

## 开始采集

```powershell
npm run capture
```

浏览器打开后：

1. 手动登录并进入 10 题页面。
2. 题目加载出来后回到终端按 Enter，脚本会采集题干和选项。
3. 在网页里正常提交/查看结果。
4. 结果或解析出现后回到终端按 Enter，脚本会补充答案和解析。
5. 继续下一轮，直到连续多轮没有新增题目，或在终端输入 `q` 结束。

## 自动监听采集

如果你想自己在浏览器里连续操作，让脚本一直在旁边自动整理：

```powershell
npm run watch
```

浏览器打开后手动登录。之后你只需要在页面里点击开始答题、翻页、提交或重新进入下一组题，脚本会每隔几秒自动抓取当前页面和相关接口数据，并持续更新 Word。

## 导出

采集过程中会自动导出：

- `question_bank.json`：结构化题库缓存，支持断点续采。
- `习思题库.docx`：Word 题库。
- `capture.log`：采集日志。

只重新导出 Word：

```powershell
npm run export
```

## 可选参数

```powershell
node scripts/capture-xisi.mjs --url "考试入口URL" --stale-rounds 5 --max-rounds 50
```

- `--url`：入口地址，默认使用当前习思入口。
- `--stale-rounds`：连续多少轮没有新增题后停止，默认 `4`。
- `--max-rounds`：最多采集多少轮，默认不限制。
- `--export-only`：只用 `question_bank.json` 重新生成 Word。
- `--watch`：自动监听模式，不需要每轮回终端按 Enter。
