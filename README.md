# dsh-recap

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）的会话回顾总结插件：把**每一次模型请求（turn:step）新增的数据**总结成一句话，按时间顺序追加成一条「回顾链」——一眼看清这个会话做了什么，而不必重放整个对话。

技术路线要点：

- **缓存友好的增量生成**。第 k 次总结请求 = 固定 system + 已有句子 1..k-1（逐字作为前缀）+ 本次新增数据 Δk。provider 前缀缓存的分叉点就在最新一句之后——**除 Δk 外的输入几乎全额缓存命中**，且历史以句子形态回灌（斜率 ~40 tok/步，而非原文 ~640 tok/步），长会话不会撑爆上下文。
- **对 agent loop 零侵入**。捕获是 `session/event` 的只读监听；生成是与主循环并行的辅助 `ctx.llm.stream` 调用（`purpose: 'recap'`，可被任何观察者过滤）；**不向会话日志写入任何事件、不注入消息**——持久化走插件自有文件（`~/.dsh/recap/sessions/<sessionId>.jsonl`）。
- **无思考生成**。总结调用默认 `reasoningEffort: 'off'`（DeepSeek 适配器映射为 `thinking: disabled`）；不支持 `off` 的路由自动降级 `low` 并按路由记忆。
- **模型路由用户可指定**。设置页的 `recap` 分区（或侧边栏下拉）可单独指定 provider+model——总结不需要强模型，指个便宜的即可；未指定时跟随会话当前路由，再退到宿主默认模型。

## 界面

- **对话内联回顾行（独立，不依赖任何其他插件）**：每句总结**穿插在模型正式回复之间**——直接插在产生它的那次模型请求（assistant 消息行）之后，而不是全列在轮末。锚点来自对话引擎给每个聊天行盖的稳定属性（assistant 行 `data-chat-anchor-key="14:assistant-step<turn>:<step>"`、轮尾 `data-turn-tail`），MutationObserver 对位注入/回收；某 step 行未渲染（被打断等）时回退到同 turn 更早的 step 行。默认 `step-end` 触发：请求一结束（~1.5s debounce）即总结，下一轮轮询（2.5s）内出现在原位。页面隐藏时轮询暂停。
- **设置页**：客户端在 DSH 设置外壳注册 `settings.section` 分区（「会话回顾」），渲染启用开关 / 总结间隔 / provider / model / 思考等级，经插件自有的 `/recap/api/settings*` 路由读写（DSH 的 settings RPC 不向配置客户端放行第三方命名空间），实时生效。provider/model 为级联下拉（`/recap/api/providers` → `ctx.llm.listProviders/listModels`，按 provider 缓存；清单加载失败时降级为手动输入）。

## 安装（从源码）

前置：DSH 已安装（`dsh web` 可运行），Node.js ≥ 22.13，pnpm ≥ 10。

```sh
# 1. 克隆并构建
git clone https://github.com/Howardzhangdqs/dsh-recap.git ~/Code/dsh-recap
cd ~/Code/dsh-recap && pnpm install && pnpm build

# 2. 依赖指向本地克隆（~/.dsh/profiles/web/package.json 的 dependencies）
#    "dsh-recap": "link:/home/you/Code/dsh-recap"

# 3. 追加挂载行（~/.dsh/profiles/web/cordis.patch.yml）
#    - insert:
#        - id: recap
#          name: 'dsh-recap'

# 4. 安装并重启
cd ~/.dsh/profiles/web && pnpm install
```

完成后重启 DSH 并硬刷新（Cmd/Ctrl+Shift+R）。

### GitHub 通道（`dsh plugin` 一键安装）

`dsh plugin add` 接受任何 pnpm 依赖形式；本插件**不发布 npm**，用 GitHub Release 的预构建 tarball 安装。包内 `dsh.bundle` 声明（cordis.patch.yml）使 `dsh plugin` 自动完成挂载；若 profile 已有手动挂载行（上面的源码方式），先删除避免双挂载。

每个版本随 [GitHub Release](https://github.com/Howardzhangdqs/dsh-recap/releases) 附带 `pnpm pack` 产出的预构建 tarball（含 `lib/` 产物与 `dsh.plugin.json`，无 sourcemap），pnpm 对远程 tarball 不执行构建脚本，装的就是附件里的产物：

```sh
dsh plugin --profile web add https://github.com/Howardzhangdqs/dsh-recap/releases/download/v0.1.0/dsh-recap-0.1.0.tgz
```

升级时改 URL 中的版本号重跑即可。

## 配置

### 挂载行配置（cordis.yml，部署级）

| 键 | 默认 | 说明 |
|---|---|---|
| `trigger` | `step-end` | 触发时机：`step-end`（每个请求结束即触发，句随请求落位）/ `turn-end`（turn 结束后 debounce 攒批）/ `manual`（仅手动） |
| `debounceMs` | `1500` | 触发防抖窗口 |
| `textBlockLimit` | `4096` | Δ 内单消息文本截断（字节，UTF-8 安全） |
| `toolResultLimit` | `2048` | 工具结果截断 |
| `toolArgsLimit` | `1024` | 工具调用参数截断 |
| `historyMaxSentences` | `400` | 提示词携带的最大历史句数（超限折叠最旧） |
| `storeMaxEntries` | `500` | 每会话落盘条数上限（超限压缩文件） |
| `maxPending` | `200` | 待总结 Δ 上限（超限合并最旧，背压） |
| `requestTimeoutMs` | `60000` | 单次总结调用超时 |
| `retryBackoffMs` | `30000` | 限流退避基数：生成遇 `RATE_LIMIT`（如 zai 的 429/1305「访问量过大」）时，该 Δ **原样回到队首**等待重试——不记失败条目、不占覆盖，链条不留永久空洞。等待**指数加宽**（连续限流 ×2，封顶 32× 基数），等待期间该位置的内联芯片显示「限流等待中，Ns 后重试…」 |
| `maxTokens` | `120` | 单句输出上限 |
| `toolsEnabled` | `false` | 是否注册模型工具（默认关：工具 schema 会进入会话请求） |
| `storeDir` | `~/.dsh/recap/sessions` | 存储目录覆盖 |

> ⚠️ 截断/框架类参数构成缓存前缀的一部分——链条中途修改会重热前缀缓存（一次性代价）。

### 用户设置（设置页 `recap` 分区，实时生效）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（false 时暂停生成，Δ 继续积累） |
| `interval` | `1` | 总结粒度：每 N 个请求的新增数据合并总结成**一句**（1 = 每请求一句）。加宽后每句的坐标为 `[T<turn>]`（覆盖请求区间）；改小后下一个请求立即恢复细粒度 |
| `provider` + `model` | 未设置 | 总结专用路由（两者须成对设置）；未设置时跟随会话路由 → 宿主默认模型 |
| `effort` | `off` | `off`（关思考）→ `low`（低思考）→ `follow`（跟随适配器默认）三级阶梯：路由拒绝当前档时自动降档并按路由记忆；模型无 effort 词表时最终省略该字段 |

#### 「关闭思考」（off）真正生效的条件

`effort: off` 是否显式发送「禁用思考」由**路由的适配器与模型声明**决定，不在本插件：

- **DeepSeek 官方路由**：适配器内置映射，`off` → `thinking: {type: "disabled"}`，开箱即用。
- **pi-ai 路由（zai 等）**：模型的 effort 档位表来自 settings 文档（`llm-pi-ai.providers.<route>.models[].reasoningEfforts`），且**未声明的档位一律视为不支持**：
  - 条目完全没写 `reasoningEfforts`、又不在 pi-ai 内置目录里的模型，会被当成**非思考模型**——请求里连 `thinking` 字段都不写（是否思考取决于服务端默认）；
  - 要显式关闭，需在模型条目里声明 `off` 档，YAML **空值**写法（`off:` 留 null）表示「支持关闭：发送时省略参数」，zai 格式会序列化为 `thinking: {type: "disabled"}`；注意只声明 `off` 一个档会被校验拒绝，须同时声明至少一个思考档：

    ```yaml
    reasoningEfforts:
      off:        # null = 支持关闭：发送时省略参数（zai 格式 → thinking: {type: disabled}）
      low: low
      high: high
    ```

  - 路由不支持 `off` 时（档位表未声明），本插件的降档阶梯会**静默**退到 `low` 或省略字段——「关闭」名不副实但不会报错，排查时先看该模型的 `reasoningEfforts` 声明。

## 模型工具（默认关闭）

开启 `toolsEnabled` 后注册两个工具（按调用 agent 的会话绑定作用域）：

- `recap_read(limit?)` — 读取回顾链（新句在前）
- `recap_refresh()` — 立即排空待总结队列

## HTTP API

`POST /recap/api/<method>`（JSON body；与 `/api` 相同的浏览器信任围栏）：

| 方法 | 说明 |
|---|---|
| `list` | `{sessionId, limit?}` → 条目（新在前）+ 汇总（句数/缓存命中率/用量）+ 队列状态 |
| `generate` | `{sessionId}` 手动排空 |
| `stats` | `{sessionId}` 队列/存储/设置快照 |
| `clear` | `{sessionId}` 清空回顾链 |
| `settings` / `settings.update` | 读写用户设置（带 revision 守卫） |
| `providers` | 列出 provider（或某 provider 的模型）供选择器使用 |

## 架构

```
session/event ──▶ capture（seed 回放 + live 镜像，按消息 id 幂等去重）
                      │ 每 step 的 Δ（新增数据，确定性截断+JSON 框架）
                      ▼
                 queue（每会话串行、跨会话并行、背压合并、失败韧性）
                      │ history = store 句子（逐字节复用为前缀）
                      ▼
                 generator（ctx.llm.stream 辅助调用，purpose:'recap'，
                           reasoningEffort off→low，超时控制）
                      ▼
                 store（~/.dsh/recap/sessions/<sid>.jsonl，追加写+压缩）
```

单包双半结构（host + client），完全遵循 [dsh-dashboard](https://github.com/Howardzhangdqs/dsh-dashboard) 的工程组织：`src/` 为 host 半（捕获/队列/生成/存储/路由/工具），`src/client/` 为浏览器半（dashboard tab + i18n）；`tsdown` 产出双通道 client bundle（profile 名 `dsh-recap` 与注册表 id `dsh-external/dsh-recap`）。

## 缓存命中账（为什么这样设计）

第 k 次调用的输入 = `system(固定) + 句子行 1..k-1 + Δk + 框架尾`。相邻调用共享 `system + 句子行 1..k-1` 逐字节前缀 → 除 Δk（本来就必须喂的新数据）与一行新句外，**全部命中缓存**。对比两种替代方案：

- 全链多轮（历史 Δ 原文重放）：input 随步数线性爆炸（~640 tok/步），长会话超窗；
- Δ 前置：每次调用在开头即分叉，前缀缓存几乎全灭。

设计细节见 [docs/plans/2026-08-15-dsh-recap-design.md](./docs/plans/2026-08-15-dsh-recap-design.md)。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（capture/store/generator/queue 四接缝单测）
pnpm build       # tsc 声明 + tsdown bundle
```

## License

MIT
