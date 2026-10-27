# dsh-cot-flow

让展开的长思维链（reasoning）在流式输出时不再越流越卡。

## 它做什么

官方思考体每来一个 delta 就把**整段**思考重新交给 Markdown 解析，成本对文本长度是平方级的。
本插件按「围栏外的空行」把思考切成段落：**已定稿的段落只解析一次**，每帧只解析最后那一小截
还没写完的尾巴。去掉多余空行与孤立分隔线，段间距交给 CSS。

渲染内容与官方一致——每段还是走官方注册的 `conversation.chat.reasoning.content`
Factory（通过 `renderFactorySlot`），不自己实现 Markdown。

设计与推导见 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

```bash
# 在 DSH profile 目录下，直接从 GitHub 装
pnpm add github:yutaosheng004-bit/dsh-cot-flow

# 或者从本地克隆装
pnpm add link:<path-to-this-repo>
```

然后把它加进 `package.json` 的 `dsh.profile.bundles`，重启 DSH。

手工挂载（本机当前用法）：把包目录 junction 到 `<profile>/node_modules/dsh-cot-flow`，
并在 profile 的 `dependencies` 里写 `"dsh-cot-flow": "link:<path>"`、`dsh.profile.bundles` 末尾加上
`"dsh-cot-flow"`。

## 验证是否生效

打开开发者工具，控制台输入：

```js
__dshCotFlow
```

看到 `{ renders, scans, scanMs, lastScanMs, segs, chars }` 即为接管成功。判据是
`lastScanMs` 不随 `chars` 增长而增长。

元素检查器里 `<div data-cot-flow data-cot-flow-segments="N">` 也是接管标记。

开不了控制台时（比如从外部查），读持久探针——最初几次渲染会写进 localStorage：

```
%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb\*.log   → 搜 dsh-cot-flow:probe
```

实测样本：`{"at":"2026-10-27T09:45:52.573Z","renders":394,"scans":387,"segs":3,"chars":333,"lastScanMs":0,"scanMs":3.7}`
——387 次扫描累计 3.7ms。

## 关掉它

从 `dsh.profile.bundles` 里删掉 `"dsh-cot-flow"` 并重启，或临时把本包 `cordis.patch.yml` 的
insert 项注释掉。插件任何一步失败都会静默降级回官方渲染，不会白屏。

## 已知边界

- 缩进代码块、HTML 块、引用块、松散列表项内部允许空行，会被切成相邻两段（内容不丢，结构被拆）。
- 没有任何空行的超长单段、或尚未闭合的超长代码围栏：尾巴无界，退化为官方行为（不会更坏）。

## 复杂度

| | 每帧 | 全程 |
|---|---|---|
| 官方 | `O(n_k)` | `O(N²/Δ)` |
| 本插件 | `O(δ + tail)` | `O(N) + O(D·t̄)` |

## 测试

```bash
npm test                     # 两套一起跑
node test/scan.test.mjs      # 分段、围栏闭合、续写判定：25 项
node test/render.test.mjs    # 装配、渲染树、流式稳定性、持久探针：30 项
```

两套都只依赖 node，不需要 React 运行时：`render.test.mjs` 用一个极小的 hooks/jsx 桩把
`lib/client.js` 当真浏览器 bundle 加载，再按 React 的方式展开组件树。

## License

MIT