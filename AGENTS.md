# dsh-recap 开发指南（面向 AI 代理与后续 contributor）

DSH 会话回顾总结插件：把每次模型请求（turn:step）的新增数据总结成一句话，内联渲染在对话流中。本文整理 slot 运行时的硬性规则、渲染路径分工与调试经验，均来自实际排障教训；改动渲染或注册逻辑前，请先阅读「slot 红线」一节。

## 常用命令

```sh
pnpm install && pnpm build   # 构建：rm -rf lib && tsc -p tsconfig.build.json && tsdown
pnpm test                    # vitest（纯 node 环境，无 jsdom）
pnpm typecheck               # tsc --noEmit
```

**修改 `src/` 后必须重新执行 `pnpm build`**：profile 通过 `~/.dsh/profiles/web/package.json` 的 `"dsh-recap": "link:/data/github/dsh-recap"` 挂载本仓库，客户端加载的是 `lib/`（`dsh.plugin.json` 的 `client.main` 指向 `./lib/client-registry.js`），不是 `src/`。

## 发布与安装通道（维护者）

本插件**不发布 npm**；用户安装方式为源码 link 或 GitHub Release 预构建 tarball（README 只保留这两条面向用户的路径）。发布新版本：

```sh
# 1. 修改 package.json 与 dsh.plugin.json 的 version（两处必须一致）
# 2. 构建、打包并发 Release（tgz 内含 lib/ 构建产物；pnpm 安装远程 tarball 时不执行构建脚本）
pnpm build && pnpm pack
gh release create v<version> dsh-recap-<version>.tgz --title v<version>
# 3. push
```

- `prepare: tsdown` / `prepublishOnly: pnpm build` 钩子与 dsh-dashboard 一致（保证 tarball 与本地 link 场景下 `lib/` 产物存在）。
- **不支持 git spec 直接安装**（`dsh plugin add github:...`）：git 安装时 pnpm 会执行 `prepare`，但构建器 tsdown 位于 devDependencies，而 git 依赖不安装 devDependencies，因此必然失败——dsh-dashboard 出于同样的原因只提供 tarball 通道。
- 无 Release 时的本地变体：`pnpm build && pnpm pack && dsh plugin --profile web add ./dsh-recap-<version>.tgz`。
- pack 产物由 package.json 的 `files` 字段限定：四个 lib bundle、`lib/types/**/*.d.ts`、src、`dsh.plugin.json`、`cordis.patch.yml`、README、LICENSE（可用 `pnpm pack --dry-run` 核对）。

## 架构地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 宿主端：捕获（只读监听 `session/event`）、队列、生成、`~/.dsh/recap/sessions/*.jsonl` 持久化 |
| `src/client/index.ts` | 客户端 `apply()`：slot 接管编排、设置分区注册、DOM 渲染器启停（三路分支见下） |
| `src/client/stepview.tsx` | React 委托包装（assistant-step 接管、tool-call 接管、turnTail 链） |
| `src/client/SettingsSection.tsx` | 设置页组件（`settings.section` 槽，读写走插件自有的 `/recap/api/settings*` 路由） |
| `src/client/RoutePicker.tsx` | 总结路由的级联下拉（经 `/recap/api/providers` 获取列表、按 provider 缓存、加载失败时降级为手动输入） |
| `src/client/SelectMenu.tsx` | 通用下拉组件（`Button` outline 锚点 + `Menu` 弹层，替代原生 `<select>` 以贴合主题设计令牌） |
| `src/client/settings-style.ts` | 设置页样式表与 class 常量（独立于行内样式 `style.ts`） |
| `src/client/inline.ts` | DOM 锚定渲染器，两种 scope：`'all'`（全量后备）与 `'calls-only'`（降级补充） |
| `src/client/store.ts` | 视图 store 与纯函数放置规则（`recapAtStep`/`recapsAfterCall`/`recapOfTurnTail` 等） |
| `src/context-types.ts` | 插件自带的 ctx 服务类型门面（含 `RecapSlotsService.spec`） |

## 设置机制（0.1.x 的经验结论）

- **设置界面只渲染 `settings.section` 注册的条目**（`dsh-client-ui-settings-general` 的 README 明确说明）——不存在「设置界面按 schema 自动渲染已注册命名空间」的机制。宿主侧 `settings.register(NS, schema)` 只负责持久化、校验与 watch；要出现在设置界面，必须在客户端 `ctx.slots.inject('settings.section', ...)` 注册条目（`id`/`order`/`label`，无 children 表，不触犯 slot 红线）。
- **第三方命名空间不走 settings RPC**：DSH 的 settings RPC 只对配置客户端放行允许清单（allowlist）内的命名空间，客户端**不能**通过 `ctx.settingsScope` 读写 `recap`——必须走插件自有的带信任校验路由（`/recap/api/settings`、`/recap/api/settings.update`；与 dsh-dashboard 的 side-card 分区受同一约束）。
- **客户端不要从 `src/config.ts` 导入值**：该文件顶部 `import z from 'schemastery'`，任何值导入都会把 schemastery 打进浏览器 bundle。设置组件只使用 `import type`，并在本地用 `parseSettings` 做防御性归一化（与 dsh-dashboard 的 `SIDEBAR_PREFS_DEFAULTS` 采用同一拆分方式）。
- **vitest 需要 css inline 配置**：`dsh-client-ui-primitives` 的构建产物顶部 import `katex/dist/katex.min.css`，node 测试环境下需要 `server.deps.inline`（见 `vitest.config.ts`）。

## slot 红线（运行时硬规则，违反即加载失败）

以下规则出自 `@deepseek-ai/dsh-client-ui-slots` 的 `SlotCore.register`（0.1.0-rc.6），源码位于 `~/.bun/install/global/node_modules/@deepseek-ai/`：

1. **子槽声明全局独占**。一个子槽（如 `tool.call.toolview`）全局只能被一个条目的 `children` 表声明——只要该条目仍在注册表中，任何第二个条目再次声明（即使规格逐字相同），`register()` 都会**同步抛出异常**，loader 会使整个插件条目加载失败（历史事故：`failed to apply loader entry ... (dsh-recap): slot "tool.call.toolview" is already declared`）。
2. **shadow 不等于注销**。因 priority 较低而未胜出的条目仍保留在注册表中，其 children 声明持续有效。因此「原生 tool-call 条目已被我们 shadow，子槽需要由我们重新声明」是**错误推理**——该子槽始终处于已声明状态。
3. **同步原子不变量**。`register()` 中「条目注册」与「children 声明」在同一次调用内完成，因此「captureChatNode('tool-call') 捕获成功」与「`tool.call.toolview` 已被声明」是同一事实；不存在只完成声明而不使宿主抛错的时序窗口。
4. **renderSlot 授权绑定条目自身**。kit 仅在条目自带 `children` 表时注入 `renderSlot` prop（`dsh-client-web-react` 的 `standardKit`），调用时校验 `entry.children?.[key]`。推论：**第三方无法干净地接管一个「带子槽声明」的原生条目**——接管条目要么重复声明（触犯红线 1，加载失败），要么缺少 `renderSlot`（被委托的原生组件（如 `ToolCallTree`）在顶层解构该 prop，渲染时抛出 TypeError，条目被错误边界弃用（abdicate））。
5. **正确做法**：注册带 `children` 的接管条目前，先用 `ctx.slots.spec?.(key)` 探测（它与运行时抛错判定读取的是同一份记录）；若已声明则降级处理，不要强行注册。

## 渲染路径与行归属（避免双渲染）

- **React 路径**：assistant-step 接管（不带调用的行渲染在助手行下方）＋ turnTail 链（轮末输入行）。
- **DOM 路径**（`inline.ts`，按 callId 精确锚定到 `9:tool-call<callId>` 的最后一行，回退目标为助手行或 turn tail）：`'all'` 仅在 assistant-step 捕获失败时启用；`'calls-only'` 在 tool-call 槽位不可用时启用（捕获失败，或子槽已被其他条目声明——后者是常态）。
- **归属划分**：条目或待处理项的 `callIds` 非空时走 DOM 路径，为空时走 React 路径。合并型条目（step 为 null 且带 calls）按带调用处理，在 DOM 路径中渲染在 turn tail 元素之后。
- **状态标识（chip）格式统一**：两条路径的标识一律显示持久日志坐标 `[T<turn>:S<step>]`（step 为 null 的合并/轮末输入行显示 `[T<turn>]`），条目行与待处理标识同格式；不存在按 turn 计数的序号（ordinal）概念，因此 calls-only 模式的过滤顺序不影响标识显示。

## 测试注意事项

- `tests/client-apply.spec.ts` 的 slots mock **没有实现**运行时的重复声明探针——单测全部通过不代表真机可以正常加载。凡注册路径依赖该校验的，必须显式编写「已声明/未声明」两类用例（现有测试已包含）。
- mock 参数化的陷阱：显式传入 `undefined` 会命中 JS 默认参数的默认值，导致该场景被静默跳过。应使用显式的开关对象，如 `mockCtx(step, tool, { toolViewChildDeclared: false })`。
- 含 hooks 的包装组件只能通过 React 渲染验证（`renderToStaticMarkup`），不能当作普通函数直接调用。

## 调试技巧

- **运行时源码就在本地**：`~/.bun/install/global/node_modules/@deepseek-ai/` 下——`dsh-client-ui-slots`（SlotCore/声明探针）、`dsh-client-web-react`（standardKit/boundRenderSlot）、`dsh-client-ui-tool`（原生 tool-call 条目）、`dsh-client-ui-conversation`（chat node 槽位宿主）、`dsh-client-runtime`（服务面：`spec`/`entries`/`inject`/`onEntryError`）。行为异常时直接阅读这些源码。
- 报错中出现的奇怪 registrant（如 `(x6)`）是服务层自动附加的 `ctx.fiber?.name`（浏览器压缩构建的 fiber 名），不是插件 id，不要去查找名为 x6 的插件。
- 条目崩溃后被错误边界弃用（abdicate）会**静默不渲染**——`src/client/index.ts` 中的 `onEntryError` 镜像会将错误输出到 console；排查「行消失」先看这里。
- **官方在线文档**（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库 `docs/`，均有 `.zh.md` 中文版）：`architecture`（插件哲学、bundle/profile/patch 分层叠加）、`cordis-tutorial/`（7 章插件开发入门）、`cordis-primer`（cordis 核心机制：事件派发、waterfall、loader）、`subsystems/*`（各子系统的深入解析，如 `core`、`client-modules`）。
- **在线文档不覆盖 slot 系统**（已逐一核实上述各篇）——slot 注册协议、children 子槽声明、renderSlot 授权均无在线文档，成文规范仅存在于下面这份本地文件中，其余以运行时源码为准。
- **官方本地文档（slot 的唯一成文规范）**：dsh 包内 `config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md`（slot 协议查询、`Slots.listSubTree` 用法、各扩展点的规范）。
