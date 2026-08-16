# dsh-recap 开发指南（给 AI 代理与未来 contributor）

DSH 会话回顾总结插件：把每次模型请求（turn:step）的新增数据总结成一句话，内联渲染在对话流中。本文沉淀 slot 运行时的硬规则、渲染路径分工与调试经验——都是踩过坑换来的，改动渲染/注册逻辑前务必先读「slot 红线」一节。

## 常用命令

```sh
pnpm install && pnpm build   # 构建：rm -rf lib && tsc -p tsconfig.build.json && tsdown
pnpm test                    # vitest（纯 node 环境，无 jsdom）
pnpm typecheck               # tsc --noEmit
```

**改了 src/ 必须重新 `pnpm build`**：profile 通过 `~/.dsh/profiles/web/package.json` 的 `"dsh-recap": "link:/data/github/dsh-recap"` 挂载，客户端加载的是 `lib/`（`dsh.plugin.json` 的 `client.main` 指向 `./lib/client-registry.js`），不是 `src/`。

## 发布与安装通道（维护者）

本插件**不发布 npm**；用户安装走源码 link 或 GitHub Release 预构建 tarball（README 只写面向用户的两条路）。发布新版本：

```sh
# 1. 改 package.json 与 dsh.plugin.json 的 version（两处须一致）
# 2. 构建 + 打包 + 发 Release（tgz 含 lib/ 产物，pnpm 对远程 tarball 不跑构建脚本）
pnpm build && pnpm pack
gh release create v<version> dsh-recap-<version>.tgz --title v<version>
# 3. push
```

- `prepare: tsdown` / `prepublishOnly: pnpm build` 钩子与 dsh-dashboard 一致（tarball/本地 link 场景兜底出 `lib/`）。
- **git spec 直装不可用**（`dsh plugin add github:...`）：git 安装时 pnpm 跑 `prepare`，但构建器 tsdown 在 devDependencies、git 依赖不装 devDeps，必然失败——dsh-dashboard 同因只提供 tarball 通道。
- 无 Release 时的本地变体：`pnpm build && pnpm pack && dsh plugin --profile web add ./dsh-recap-<version>.tgz`。
- pack 产物按 package.json `files` 圈定：四个 lib bundle、`lib/types/**/*.d.ts`、src、`dsh.plugin.json`、`cordis.patch.yml`、README、LICENSE（`pnpm pack --dry-run` 可核对）。

## 架构地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 宿主半区：捕获（只读监听 `session/event`）、队列、生成、`~/.dsh/recap/sessions/*.jsonl` 持久化 |
| `src/client/index.ts` | 客户端 `apply()`：slot 接管编排 + 设置分区注册 + DOM 渲染器启停（三路分支见下） |
| `src/client/stepview.tsx` | React 委托包装（assistant-step 接管、tool-call 接管、turnTail 链） |
| `src/client/SettingsSection.tsx` | 设置页组件（`settings.section` 槽，读写走自有 `/recap/api/settings*` 路由） |
| `src/client/RoutePicker.tsx` | 总结路由级联下拉（`/recap/api/providers` 拉清单、per-provider 缓存、失败降级文本输入） |
| `src/client/SelectMenu.tsx` | 通用下拉（`Button` outline 锚点 + `Menu` 弹层，取代原生 `<select>` 以贴合主题令牌） |
| `src/client/settings-style.ts` | 设置页样式表与 class 常量（独立于 inline 行的 `style.ts`） |
| `src/client/inline.ts` | DOM 锚定渲染器，两种 scope：`'all'`（全量 fallback）与 `'calls-only'`（降级补位） |
| `src/client/store.ts` | 视图 store + 纯函数放置规则（`recapAtStep`/`recapsAfterCall`/`recapOfTurnTail` 等） |
| `src/context-types.ts` | 插件自带的 ctx 服务类型门面（含 `RecapSlotsService.spec`） |

## 设置机制（0.1.x 踩坑结论）

- **设置 shell 只投影 `settings.section` 账本**（`dsh-client-ui-settings-general` 的 README 明说）——不存在「shell 自动按 schema 渲染已注册命名空间」的机制。宿主侧 `settings.register(NS, schema)` 只管持久化/校验/watch；要出现在设置界面必须在客户端 `ctx.slots.inject('settings.section', ...)` 注册条目（`id`/`order`/`label`，无 children 表，不触 slot 红线）。
- **第三方命名空间不走 settings RPC**：DSH 的 settings RPC 域只对配置客户端放行 allowlisted 命名空间，客户端**不能**用 `ctx.settingsScope` 读写 `recap`——必须走插件自己的带 fence 路由（`/recap/api/settings`、`/recap/api/settings.update`，与 dsh-dashboard 的 side-card 分区同一约束）。
- **客户端勿从 `src/config.ts` 值导入**：它顶部 `import z from 'schemastery'`，任何值导入都会把 schemastery 打进浏览器 bundle。设置组件只用 `import type`，本地 `parseSettings` 做防御归一（dsh-dashboard 的 `SIDEBAR_PREFS_DEFAULTS` 同款拆法）。
- **vitest 需要 css inline workaround**：`dsh-client-ui-primitives` 的构建产物顶部 import `katex/dist/katex.min.css`，node 测试下需 `server.deps.inline`（见 `vitest.config.ts`）。

## slot 红线（运行时硬规则，违反即加载失败）

以下规则出自 `@deepseek-ai/dsh-client-ui-slots` 的 `SlotCore.register`（0.1.0-rc.6），源码在 `~/.bun/install/global/node_modules/@deepseek-ai/` 下：

1. **子槽声明终身独占**。一个子槽（如 `tool.call.toolview`）全局只能被一个条目的 `children` 表声明——只要该条目还在账上，任何第二个条目再声明（哪怕逐字复制同规格）都会在 `register()` 时**同步抛错**，loader 会杀掉整个插件条目（历史事故：`failed to apply loader entry ... (dsh-recap): slot "tool.call.toolview" is already declared`）。
2. **shadow ≠ 注销**。低 priority 落选的条目仍留在账上，它的 children 声明持续有效。所以「原生 tool-call 条目被我们 shadow 掉了，子槽需要我们重新声明」是**错误推理**——它一直被声明着。
3. **同步原子不变量**。`register()` 内「条目入账」与「children 声明」同一调用完成，故「captureChatNode('tool-call') 捕获成功」⟺「`tool.call.toolview` 已声明」是同一事实；不存在抢先声明而不炸宿主的窗口。
4. **renderSlot 授权绑定条目自身**。kit 仅在条目自带 `children` 表时注入 `renderSlot` prop（`dsh-client-web-react` 的 `standardKit`），调用时校验 `entry.children?.[key]`。推论：**第三方无法干净接管一个「带子槽声明」的原生条目**——接管条目要么重复声明（红线 1 炸加载），要么缺 `renderSlot`（被委托的原生组件如 `ToolCallTree` 顶层解构它，渲染即 TypeError → 错误边界 abdicate）。
5. **正确姿势**：注册带 `children` 的接管条目前，先用 `ctx.slots.spec?.(key)` 探测（它就是运行时抛错判定读的同一记录）；已声明就降级，别硬注册。

## 渲染路径与行归属（勿双渲染）

- **React 路径**：assistant-step 接管（call-free 行渲染在助手行下方）＋ turnTail 链（input-tail 行）。
- **DOM 路径**（`inline.ts`，按 callId 精确锚定到 `9:tool-call<callId>` 的最后一行，退路是助手行/turn tail）：`'all'` 仅在 assistant-step 捕获失败时启用；`'calls-only'` 在 tool-call 座位不可用时启用（捕获失败**或**子槽已声明——后者是常态）。
- **归属切分**：条目/pending 项 `callIds` 非空 → DOM；为空 → React。merged-delta 条目（step-null 且带 calls）属 call-carrying，DOM 中落位在 turn tail 元素后。
- **芯片坐标统一**：两条路径的芯片一律显示持久日志坐标 `[T<turn>:S<step>]`（step 为 null 的 merged/input-tail 行显示 `[T<turn>]`），entry 行与 pending 芯片同格式；不存在 per-turn 序号（ordinal）概念，calls-only 的过滤顺序因此不影响芯片显示。

## 测试注意事项

- `tests/client-apply.spec.ts` 的 slots mock **没有实现**运行时的重复声明探针——单测全绿不代表真机能加载。凡注册路径依赖该校验，必须显式写「已声明/未声明」两种用例（现已有）。
- mock 参数化坑：显式传 `undefined` 会命中 JS 默认参数默认值，场景被静默吞掉。用显式开关对象，如 `mockCtx(step, tool, { toolViewChildDeclared: false })`。
- 包装组件含 hooks：只能经 React 渲染验证（`renderToStaticMarkup`），不可当函数直接调用。

## 调试技巧

- **运行时源码就在本地**：`~/.bun/install/global/node_modules/@deepseek-ai/` 下——`dsh-client-ui-slots`（SlotCore/声明探针）、`dsh-client-web-react`（standardKit/boundRenderSlot）、`dsh-client-ui-tool`（原生 tool-call 条目）、`dsh-client-ui-conversation`（chat node 座位宿主）、`dsh-client-runtime`（服务面：`spec`/`entries`/`inject`/`onEntryError`）。行为诡异时直接读它们。
- 报错里的怪 registrant（如 `(x6)`）是服务层自动盖章的 `ctx.fiber?.name`（浏览器压缩构建的 fiber 名），不是插件 id，别去找叫 x6 的插件。
- 条目崩溃被错误边界 abdicate 后**静默不渲染**——`src/client/index.ts` 里的 `onEntryError` 镜像会把它打到 console，排查「行消失」先看那里。
- **官方在线文档**（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库 `docs/`，均有 `.zh.md` 中文版）：`architecture`（插件哲学、bundle/profile/patch 分层叠加）、`cordis-tutorial/`（7 章插件开发入门）、`cordis-primer`（cordis 核心机制：事件派发、waterfall、loader）、`subsystems/*`（各子系统深潜，如 `core`、`client-modules`）。
- **在线文档不覆盖 slot 系统**（已逐一核实上述各篇）——slot 注册协议、children 子槽声明、renderSlot 授权没有任何在线文档，成文规范只在下面这份本地文件里，其余以运行时源码为准。
- **官方本地文档（slot 的唯一成文规范）**：dsh 包内 `config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md`（slot 协议查询、`Slots.listSubTree` 用法、各扩展点的规范）。
