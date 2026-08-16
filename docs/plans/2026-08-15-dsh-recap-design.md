# dsh-recap 设计方案

> 状态：已实施（v0.1.0）。本文是设计定稿与实施记录，行为以代码为准。

## 1. 目标

把会话里**每一次 API 请求（turn:step）新增的数据**凝练成一句话，增量追加成一条回顾链；后续生成永远以已有回顾作为上文，**最大化 provider 前缀缓存命中**。

三条硬约束：

1. **零 agent loop 侵入**：捕获只读监听；生成是与主循环并行的辅助调用；loop 永不等待 recap。
2. **无思考生成**：`reasoningEffort: 'off'`（不支持的路由自动降 `'low'`）。
3. **零会话足迹**：不向 session log 追加事件、不注入消息——持久化走插件自有文件。

## 2. 提示结构与缓存论证

### 2.1 结构

```
system:   固定指令（任务说明、输出格式、长度约束；永不变）
user:     1. R1                     ← 裸编号行：已定稿句子逐字回灌
          2. R2
          …
          k-1. Rk-1
          <new_delta>{…Δk 严格 JSON…}</new_delta>
          请凝练本次模型请求的数据，输出下一句。
assistant: Rk                        ← 模型只产出下一句
```

关键点（相对最初草稿的两处修正）：

- **历史在前、Δ 在尾**：前缀缓存要求相邻调用从开头逐字节相同。Δ 每次都不同，放在前面会让分叉点提前到 system 之后，缓存全灭。
- **裸行历史（无闭合包裹标签）**：`<recap_history>…</recap_history>` 的闭合标签会在每次追加时重热（标签字节在新句之后）。裸行 + `<new_delta>` 开标签自定界，使第 k+1 次调用的消息严格以第 k 次调用的全部历史行为前缀**再加一行**——分叉点精确落在最新一句。

### 2.2 token 账（k=100 步，Δ≈600 tok，句≈40 tok，system≈150 tok）

| 方案 | 每次调用 input | 缓存命中 | 未命中（全价） |
|---|---|---|---|
| 全链多轮（Δ 原文重放） | ~64,150 | ~63,550 | ~600 |
| Δ 前置（草稿） | ~4,710 | ~150 | ~4,560 |
| **本设计（裸行历史）** | **~4,710** | **~4,070+** | **~640** |

未命中部分 ≈ 纯 Δk（本来必须喂的新数据）+ 一行新句 + 框架尾；input 斜率 ~40 tok/步（句子形态），长会话不超窗。

### 2.3 前缀稳定性保障

- 落库句 = 下次请求的前缀材料（store 中存的就是将逐字进入提示的文本）；
- 句子序列化固定为 `"{i}. {sentence}"`；生成时已规范化为单行、剥编号/引号/Markdown；
- Δ 框架化确定性：固定 JSON key 顺序、固定截断规则、无时间戳/随机值；
- 每链常量：路由 / effort / maxTokens / system（改配置 = 换前缀，一次性重热）；
- `usage.cacheReadTokens` 逐条落库，UI 显示命中率徽标，可验证。

## 3. 数据管道

### 3.1 捕获（capture.ts）

- 双源合并：**seed**（`ctx.sessions.get(sid).events` 快照回放，覆盖 host 重启前历史）+ **mirror**（`session/event` 追加流，覆盖 store 水合延迟）；live 事件在 seed 完成前缓冲。
- 幂等：`seenIds`（消息 id + `call:` id）与 `emittedKeys`（step key）双去重——同一事件从两源到达均为 no-op。
- 归属规则：每条新数据落在**产生它的 step** 的 Δ 里（step 消费的用户输入、它组装的 assistant 消息、它请求的 tool call 与结果）；`user/message` 无 turn/step 标签，进 pending 队列由下一个 `step/start` 认领；turn 结束仍未认领的 flush 为 `turn:tail` Δ。
- compaction 安全：压缩替换产生全新消息 id → 自然成为新 Δ；被替换的旧消息不再出现，无需特殊处理。
- 恢复：store 条目的 `itemIds`/`key` 播种去重集合——重启回放不为已覆盖的 step 重新生成。

### 3.2 排队（queue.ts）

- 每会话串行（缓存链顺序）、跨会话并行、fire-and-forget（loop 路径零 await）。
- 触发：`turn-end`（默认，debounce 3s 攒批）/ `step-end` / `manual`。
- 失败韧性：单条失败记 `failed` 条目（itemIds 仍算覆盖，不无限重试），链继续；连续 3 次失败驻停等待下次触发。
- 背压：pending 超 `maxPending`（200）时合并最旧为一条 Δ。
- 路由阶梯：设置页显式 pair → 会话捕获路由 → 宿主默认模型。

### 3.3 生成（generator.ts）

- `ctx.llm.stream` 直调（复刻 dsh-session-title-llm 的辅助调用模式）：`purpose:'recap'` 自定义标记（核心与适配器均不拒绝未知值，已验证）、`maxTokens:120`、deadline 超时、AbortSignal 级联。
- effort 阶梯：`off` →（`UNSUPPORTED_REASONING_EFFORT` 一次性降级）`low` → 按路由记忆；`follow` 省略。DeepSeek 适配器 `off` 映射 `thinking: disabled`（彻底关闭）。
- 输出规范化：首行、剥编号/引号/加粗、折叠空白、160 字符硬上限；空输出/工具调用输出/非常规 finish 均报错。

### 3.4 存储（store.ts）

- `~/.dsh/recap/sessions/<sessionId>.jsonl`（`DSH_HOME` 尊重），一行一条：`{v, index, key, turn, step, createdAt, sentence?, status, error?, route?, usage?, itemIds, deltaStats}`。
- 追加写（每会话 promise 链串行化）；坏行跳过；超 `storeMaxEntries×2` 时 write-temp+rename 压缩到上限。
- `sentences()` 重建前缀；`coveredIds/coveredKeys()` 重建恢复去重。

## 4. 接口

- **HTTP**（`/recap/api/*`，webServer 前缀路由 + 与 `/api` 一致的 Host 头/ trustedHosts 信任围栏）：`list` / `generate` / `stats` / `clear` / `settings` / `settings.update`（revision 守卫）/ `providers`。
- **设置**：`recap` 命名空间注册进 DSH 设置服务（SchemaForm 自动渲染），侧边栏与 API 写同一层。
- **模型工具**（`toolsEnabled` 默认关）：`recap_read` / `recap_refresh`，按 `exec.agent.session.id` 绑定。
- **UI**：dashboard tab（`ctx.inject(['dashboard'])` 动态席位，未装自动降级）；可见性门控轮询；zh/en i18n 跟随 DSH 语言。

## 5. 零足迹验收清单

1. 捕获监听器同步透传、零改写（事件本已冻结）；
2. 生成不 `agent.inject`、不 surface append、不 `session.append`——会话日志零新增事件；
3. 触发全部来自 emit 事件，fire-and-forget；异常只进 logger + `failed` 条目；
4. recap 请求 `isAgentLoopRequest === false` + `purpose:'recap'`，任何观察者可过滤；
5. 模型工具默认不注册（避免工具 schema 进入会话请求）；
6. 文件 I/O 全异步、每会话串行；背压丢最旧合并；
7. 会话 dispose → abort + 落盘；所有定时器/监听有 disposer（HMR 安全）。

## 6. 工程组织（对齐 dsh-dashboard）

单包双半：host（`src/`）+ client（`src/client/`）；`tsdown` 双通道 client bundle（profile 名 / 注册表 id）；类型走 `tsc -p tsconfig.build.json`；vitest 覆盖 capture/store/generator/queue 四接缝 + 插件形状一致性。外部 peer 解析：`@deepseek-ai/dsh-llm`（BlockAssembler/createUserMessage/ReasoningEffortId）、`schemastery`（Config schema，dependencies 外部化）。Context 增强走结构化镜像（context-types.ts，漂移容纳于单文件）。

## 7. 实施偏差记录

- 最初草稿的 `<recap_history>` 闭合包裹 → 改为裸行历史（闭合标签每次重热 ~18B，裸行使分叉点严格落在最新句行）。
- 用户设置增加 `enabled` 总开关与路由显式指定（设置页/侧边栏/API 三入口同层）。
- `purpose` 类型上游为封闭联合（`'compaction' | 'session-title'`），运行时容忍未知值——带注释的定向转换保留 `'recap'` 标记（可观测性收益）。
- 背压合并在入队时执行（而非 drain 时），合并条目 key 为 `merged:<turn>`。
- **effort 降级的错误通道修正**：dsh-llm 运行时把 `resolveCallFor`/适配器的抛错转换为终态 `finish` chunk（`reason.kind: 'error'` 携带 `failure.code`），不 rethrow——首版在 catch 里按 `error.code` 检测因此从未命中（zai/glm-5.3 实测暴露）。修正为 `finishError` 透传 `failure.code` + 消息正则双保险；且模型信息无 reasoning 词表时**任何** effort 都被拒，阶梯扩为 `off → low → follow(省略)` 三级，按路由记忆生效档位。
- **UI 从 dashboard tab 改为对话内联注入**（用户要求独立于 dashboard）：对话唯一的 per-turn 扩展槽 `conversation.chat.turnTail` 是单当选链槽（dsh-dashboard 以 `priority: -1` 参选产出文件行），共存不可能；改为以对话引擎渲染的 `data-turn-tail="<turn>"` 属性为锚，MutationObserver 对位在锚点后插入/移除回顾行（与 dsh-dashboard composer-collapse 同级的 DOM 技术），数据走 `/recap/api/list` 轮询（页面可见时 2.5s，隐藏暂停）。client 半因此去 React 化（bundle 12.4kB → 9.9kB）。
- **内联行从轮末改为逐请求落位**（用户要求穿插在模型回复之间）：对话引擎给每个聊天行盖 `data-chat-anchor-key`（引擎 key 格式 `${kind.length}:${kind}${id}`，assistant-step 的 match id 为 `${turn}:${step}`，即 `14:assistant-step<turn>:<step>`），可直接解析定位——每句插在产生它的 assistant 行之后；step 行未渲染时回退同 turn 更早 step 行；轮尾输入条目仍挂 `data-turn-tail`；待凝练 chip 挂最新 assistant 行。默认触发随之改为 `step-end`（debounce 3s→1.5s）：请求结束即凝练、下轮轮询内落位。
- **step 行插入点修正 + reasoning 入料 + 行样式**（用户实测反馈）：① tool call 在聊天流里是独立节点（`kind: "tool-call"`，行 key `9:tool-call<callId>`），排在该 step 的 assistant 行之后——首版插在 assistant 行正后方因而落在 tool 行之前；现插入点经 `stepTail` 游标越过连续 `data-chat-flow-kind="tool-call"` 行，句子落在该请求全部内容（回复+调用+结果）之后，pending chip 同理，孤儿判定放行 tool 行邻居。② Δ 的 flattenBlocks 原先跳过 reasoning 块——按用户语义（tool result 与 reasoning 一起凝练）改为纳入。③ 行样式：字号 inherit（与正文一致）、去斜体、正文加粗（font-weight 600）。
- **工具完成门控 + 白色文字**（用户实测反馈）：① Δ 关闭增加硬门控——step bucket 记录 `openCalls`（tool/call 加入、tool/result 按其 block 的 toolCallId 移除）；`step/end` 到达时若仍有未归位的调用，bucket 挂入 `closing` 暂存，**最后一个 tool/result 落地时才 emit**（结果路由进 parked bucket 后判空关闭）；turn 结束仍 park 的 bucket（工具被中断、结果永不到达）在 `turn/end` 强制冲刷（数据定格为准）。正常日志序（result 先于 step/end）行为不变，门控是保证而非假设。② 行文字颜色默认 `#ffffff`（保留 `--dsh-recap-fg` 覆盖位适配亮色主题）。
- **S 编号跳跃根因：纯工具步不渲染聊天行**（用户实测反馈）：AssistantMarkdown 对 settled 且 blocks 全为 tool-call 的 step 返回 null——这些步在 DOM 里没有 assistant 行，原锚点回退把其 recap 挂到更早可见行，可见 chip 的 log step 编号"跳"过隐步（跳量=中间工具步数，数据层 store 实际连续无缺口，已验证）。修复：① 锚点改为「最近已渲染 assistant 行 at-or-before 目标 log 位置」（跨 turn），同一锚点的多组 recap 用 per-anchor 游标按 log 序栈叠（DOM 不暴露 step→tool 行映射，recap 可能视觉上尾随其覆盖的隐步工具行，但 recap 相对顺序恒正确）；② chip 显示改 per-turn 连续序号（`▸·1`、`▸·2`…，轮尾输入为 `▸·in`），真实 `T<turn>:S<step>` 坐标移入 title tooltip；③ 孤儿判定回溯跳过栈叠的 recap 行再找结构邻居。
- **会话切换串台修复**（用户实测反馈）：切换会话时旧 recap 行会"挂"到新会话——turn 坐标跨会话冲突（新会话同样从 turn 1 渲染），旧 byAnchor 数据在下次轮询（≤2.5s）替换前会先匹配上新会话的锚点。修复为三层会话栅栏：① `dataFor` 记录当前数据归属会话，reconcile 入口校验 `dataFor !== current` 即清行并跳过放置；② refresh 的 fetch 完成后校验中途切换（`sessionId() !== id` 则丢弃结果）；③ 订阅 client `sessions.list` feed（subscribe），切换瞬间即时清行并立刻拉取新会话数据（不等轮询窗口）。
- **可见回复门控聚合（carry）**（用户要求"一组工具一个 recap"）：数据验证表明真并行调用（同 step 多 callId，33 个）本就合并为一句；用户看到的"每个工具各一句"实为**连续纯工具步 run**（87 段，每段 2~11 步——glm-5.3 每请求只调一个工具且不说话，每步各出一句、又因不渲染聊天行而堆叠）。修复为可见回复门控：StepBucket 记录 `visible`（任一 assistant 消息含非空 text block）；纯工具步关闭时 Δ 不 emit 而是累积进 `carry`，下一个"模型开口"的 step 关闭时合并（carry 在前）一次性凝练——一段连续静默工作爆发在模型说话点产出**一句** recap；turn 结束仍残留的 carry 并入 tail flush。幂等保持：carry 为内存态，重放按 itemIds 跳过后空桶自然 no-op；空桶 closeBucket 显式标记 emittedKeys 防复活。
- **撤销 carry 聚合，改为按请求精确分组 + 精确锚定**（用户指出系统能看到哪些任务并行）：carry 是对"每工具一句"误诊的过度修正，副作用是把句子攒到模型开口（往往在任务末尾）。正确语义：**一次请求 = 一句 recap**——并行调用共享同一次请求（同 turn:step），本就合并；连续请求各自出句、穿插在执行过程中。实施：① capture 撤销 carry/visible 门控，恢复每请求直接 emit，并新增 `StepDelta.callIds`（该请求发出的根 callId 有序列表——精确分组信息）；② callIds 经 queue → store 条目 → /recap/api/list 全链透传；③ 渲染锚定从"最近可见 assistant 行"启发式改为精确匹配：查该请求各 callId 的工具行（DOM key `9:tool-call<callId>`），recap 插在其请求**最后一个工具行**之后（`compareDocumentPosition` 取文档序最大者）；无工具行（纯文本回复/调用不在屏上）才回退 assistant 行锚点。效果：并行组一句紧随整组工具行，连续请求的句子穿插在执行流中。
- **流式/思考期 recap 行消失修复**（用户实测反馈）：模型 thinking/流式输出期间聊天树高频重排，锚点元素被瞬时卸载或重建，孤儿清扫"见失邻居即删"导致行消失、流结束 DOM 稳定后 placement 又加回——即"消失，完毕再出现"。三层修复：① 孤儿删除加 2.5s 宽限（dataset.orphan 记首见时间，结构邻居持续缺失超时才删；placement 复位时清除标记）；② placeRow 增加行位校验（inPosition：回溯跳过栈叠 recap 行须恰落在放置宿主上）——签名未变但错位的行被"搬回"宿主而非先删后加，消除闪烁路径；③ 观察者回调 rAF 合并（流式期每 token 批多次突变更批为每帧至多一次 reconcile）。
- **渲染迁移到官方槽位（React 原生委托）**（调研 dsh-visualize 后重构）：dsh-visualize 证明对话内卡片走 `tool.call.toolview` keyed 槽是官方支持路径——React 原生、抗流式重排、回放稳定。枚举全部对话插槽后选定更优组合：接管 `conversation.chat.node` 的 `assistant-step` 键（keyed 槽低 priority 者为 head，与 dashboard 抢 turnTail 同理），注册前捕获官方 AssistantNodeView 组件做透明委托。放置规则（数据推导）：上一请求的 recap 渲染在下一条助手消息节点**上方**（恰在其工具行之后，实现穿插）；轮内最新请求的 recap 渲染在自己节点**下方**（后续请求到达时自动迁移为上方位）；纯输入尾条目走 `turnTail` chain 槽（dashboard 在有产出文件轮胜出、我方仅在有 recap 的轮当选，select 互斥共存）。视图数据由 useSyncExternalStore 外部 store 驱动（轮询 /recap/api/list，含会话栅栏与中途切换丢弃）。DOM 内联注入（inline.ts）降级为后备：委托捕获失败（加载序变化）时启用。thinking 期消失问题因 React 拥有树而根除。
- **委托渲染致命 bug 修复（memo 对象不可函数调用）**：captured 官方 AssistantNodeView 是 `react.memo(fn)` 的结果——对象而非函数。首版委托代码 `Original(props)` 对 memo 对象做函数调用 → 渲染抛 TypeError → keyed 槽错误边界将条目 abdicate（永久退位）→ assistant-step cell 死亡，recap 全消失。修复：委托一律 `createElement(Original, props)`；注册补 `locale: 'conversation'`（官方条目带 locale NS，`t` prop 由 locale 机制注入，缺失则官方组件内部 `t(...)` 崩溃）。
- **React 路径样式缺失修复**（用户实测反馈"看到文字但没有格式"）：CSS 样式表原本只存在于 DOM 后备路径 registerInlineRecap 内——React 委托路径激活时不经过它，所有 recap 行裸样式渲染（句子技术上在、视觉上消失，只剩可辨识的"凝练中…"文字）。修复：样式表与类名提取到共享 style.ts（RECAP_CLASS/RECAP_CSS/injectRecapStyles 幂等注入），client apply 顶部无条件注入、DOM 后备复用同一标签；stepview/inline 共用类名。另修测试方法错误：组件函数不能在渲染器外直调（hook 无 dispatcher）——改 react-dom/server renderToStaticMarkup 正式渲染；bundle-smoke 修正导出断言（client half 按惯例不导出 name，runner 从 loader 层取名）。
- **行文案字重回调**（用户反馈）：正文/chip/pending/more 一律常规字重（400），白色、与正文同号、卡片样式（左竖线+浅背景）不变。
- **React 协调 key 缺失修复（recap 错乱/闪消）**（用户实测反馈）：包装组件拼装的 children（上方位 recap 行 / 委托官方元素 / 下方位 recap 行 / pending 行）无 key——轮询更新使行的出现/消失改变数组形状时，React 按位置匹配元素，把同一 DOM 复用给不同条目（"当前 recap 显示在前面的 recap 中"）或因类型错配卸载（"123 闪一下消失"）。修复：全部子元素稳定 key——recap 行 `recap-<entry.key>`（耐久坐标）、官方元素 `official`、pending 行 `recap-pending`。
- **上方位改为多条栈叠 + 文本编号 + 诊断日志**（用户实测反馈"当前 recap 显示在前面的 recap 里、123 闪失只剩 4、5"）：数据剖析证实 T22 形态——S1 渲染行、S2-S4 纯工具步（官方渲染 null）、S5 渲染行；原 recapBeforeStep 只取"最近一条"，中间纯工具步的 recap 被静默丢弃，且单行+位置计算在 React null 节点间错位。修复：① recapsBeforeStep 返回区间内**全部**条目（过滤掉拥有自身 below-row 的条目——即各 turn 的最新请求），纯工具步连跑的句子全部栈叠在下一个可见 assistant 节点上方；② 编号改文本坐标 `[T2:S3]`/`[T2:输入]`（可选中复制，用户可直接引用反馈）；③ debugPlacement 每次放置打一行 `[dsh-recap] node=T:S above=[..] below=[..] pending=N`（localStorage.dshRecapDebug='off' 可关），供用户从浏览器控制台复制诊断。
- **后继锚定（单宿主不变式）替换"区间全部堆叠"**（用户实测反馈"大量 recap 聚集在最新对话之前"）：区间堆叠规则是二次方重复——条目 E 渲染在 E 之后每个节点上方各一份，轮末节点上方堆满整个积压（刷新/补齐场景的"山"）。重写为 recapsAboveNode：条目 E 仅锚定其**后继条目**（按 index 的下一条）的节点上方；below-row 拥有者（各轮最新请求）不跨轮堆叠（单宿主）；宿主节点在聊天窗口外（虚拟化滚出，窗口语义经 loadOlder 分页考察）则该条不渲染，滚回自然出现——包装器只为窗口内节点执行，窗口即边界，无需额外 API。回归用例：36 条积压时节末节点至多接待 1 条上方行、任一节点至多 1 条。另加槽位 onEntryError 错误镜像（此前"渲染了但 UI 无输出"疑被错误边界静默 abdicate，现打印槽键/registrant/错误）。
- **点击复制与选中恢复**（用户反馈）：行内文本显式 user-select:text（防祖先禁选），chip 撤 user-select:none；整行点击复制 `[T轮:S步] + 句子`（navigator.clipboard，非安全上下文回退 execCommand textarea），裸点击判定（已有选区时让位给拖选复制），成功后行内闪现"✓ 已复制"1.2s，cursor:pointer 提示可点。
- **hooks 组件被函数调用致全行消失（click-to-copy 回归）**：RecapRow 引入 useCopyFlash（useState/useCallback/useEffect）后成为真组件，但三处调用点仍是函数调用 RecapRow({entry})——hooks 在组件渲染上下文外执行抛 invalid hook call，错误边界退位、全部 recap 行消失（上一版"完美"佐证 hooks 是唯一新变量）。修复：一律 createElement(RecapRow, { key, entry })（key 移入 options），turnTail 与 beforeRows/ownRow 三点同改；渲染回归测试补 [T1:S1] 文本坐标断言。
- **复制反馈改为下方气泡**（用户反馈：不得改行内内容）：RecapLines 恒渲原句（copy 状态不再侵入），点击复制成功后在行**下方**渲染独立气泡（dsh-recap-inline-copied：胶囊形、accent 色、120ms 淡入、pointer-events:none、1.2s 后消失），行内容逐字不动。
- **复制提示改为绝对定位悬浮**（用户反馈：不在 recap DOM 内、在其下方、不占布局）：行加 wrap 类（position:relative 作定位上下文），copied 气泡 position:absolute top:100% 悬于行下方——脱离文档流、不占行高、不推挤兄弟节点、pointer-events:none 不挡交互；行内内容与布局完全不受反馈影响。
- **hover 提示与复制确认共用悬浮位**（用户要求）：toast 常驻 DOM（aria-hidden），默认 opacity:0，hover 行时 CSS 显"点击复制"（无 JS 状态）；点击复制成功 1.2s 内切 copied-active 类强制显示"✓ 已复制"（文本与显隐皆状态驱动，与 hover 解耦）；120ms 过渡替代 keyframes，实底胶囊样式不变，仍绝对定位不占布局。
- **pending 落位最新节点 + 提示词人话化**（用户要求）：① 凝练中提示从"own 存在才显示"改为挂在聊天**最后一个 assistant-step 节点**（lastAssistantPosition：渲染时只读探测 DOM 最后一个 14:assistant-step 行坐标）——生成中的句子恰好将落在这（作为该节点 below-row 或后继 above-row），提示即出现在句子即将出现的位置；PendingRow 改正规组件元素。② 系统提示词重写：要求完整自然叙述（"像同事复述刚发生的工作"），明确禁止电报式压缩、缩写堆砌、名词化动作、分号串联；长度上限不变（60 CJK / 30 词）。
- **锚定改为请求精确（own 尾行）+ 逐条 pending chip**（用户实测反馈"对话进行中所有 recap 堆在最后一个工具调用前、凝练中提示随机刷新"）：读引擎源码定位两个叠加根因——① 各轮最新请求的 below-row 挂在**自己 assistant 节点**下方，而该请求的工具行是独立聊天节点、排在其后，live 期间句子恰好落在回复与工具行之间（=最后一个工具调用的前一个），下一句到达迁移后才归位（"完毕后没问题"正是迁移完成态）；② 纯工具步节点被引擎标 `visibility:"hidden"` 且被 `chat.order`（orderedVisible）过滤——后继锚定在其节点上的行在 live 期间整段消失。修复为**请求精确锚定**：带 callIds 的条目渲染在其请求**最后一个工具行**之后（新增 tool-call 键座位委托：同机制捕获官方 ToolCallTree、priority -1 接管、children 声明 `tool.call.toolview` 逐字复制、createElement 委托），无 callIds 条目（纯文本回复）挂自己节点下方（去掉"仅轮内最新"条件——其请求块本就以自身行结束，位置永真且不再迁移）；后继锚定 recapsAboveNode 整体删除。pending 同理逐条化：queue stats 新增 `items[]`（queued/generating 携 turn/step/callIds，drain 以 inFlight 跟踪生成中条目；顺修 no-route park 时被 shift 的 delta 静默丢失为 unshift 保留），client 每条 work item 在其 own 请求尾部渲一枚 `[T:S] 凝练中…` chip（句子落成原地替换），lastAssistantPosition DOM 探测删除（"随机刷新"根因）；merged 步-null 条目带 callIds 不再进 turnTail（挂自己工具行）。回归：41 用例（请求精确放置、tool-only 步无后继依赖、36 条单宿主、queue items 生命周期 queued→generating→gone、no-route 不丢工、tool-call 委托渲染断言）。
