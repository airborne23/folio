# Channel Discussion Mode (Round-Robin) — Design

**Status:** Draft — pending user decisions on Open Questions §5
**Author:** jiangkai (with Claude)
**Date:** 2026-05-08
**Target branch:** `feat/channels`
**Related:** `docs/superpowers/specs/2026-05-06-channels-feature-design.md` (parent channels feature)

---

## 0. TL;DR

把"频道里多 agent 各自独立判断要不要回应"换成**用户发起 → 系统排序 → agent 串行接龙**。

- **触发**：人类发言（满足条件，§Q1）
- **顺序**：消息里有 `@A @B C` 严格按 `@` 顺序；没 `@` 用 `hash(message_id)` 决定起始位置后顺序后移
- **执行**：每个 agent 看到完整上下文（含之前 agent 发言 + 标识 speaker），串行 dispatch
- **控制**：频道 toggle `discussion_mode: "parallel" | "round_robin"`（默认 parallel，向后兼容）

文档目的：**让你在 6 个边界问题上拍板**，然后我们才能写 implementation plan。

---

## 1. Background — 现状

### 1.1 当前 channel agent 协调机制

频道里 agent 是否回应一条消息由**每个 agent 独立判断**：

| 配置项 | 当前默认值 | 含义 |
|---|---|---|
| `subscribe_mode` (per-member) | `"subscribe"` / `"mention_only"` | subscribe 全订阅；mention_only 仅 @ 时触发 |
| `agent_cooldown_ms` (per-channel) | 60_000 | 同一 agent 两次发言最小间隔 |
| `max_consecutive_agent_turns` (per-channel) | 5 | 防止 agent 自言自语死循环 |

实际行为：人类发一句话 → backend `EnqueueChannelTask` 给所有 subscribe-mode agent 派任务 → 每个 agent **同时**调用 LLM → 各自决定是否真正回复（agent 自己 prompt 里有"如果你觉得不该插话就 abstain"逻辑）。

### 1.2 痛点

| 痛点 | 现象 |
|---|---|
| **Token 浪费** | 4 个 agent 都被叫起来跑 LLM，但常常只有 1-2 个有意义的回复，其他 3-2 个空跑 |
| **内容重复** | agent 看不到对方在说什么（并发）→ 多人回答相同 prompt 时大量重叠 |
| **缺合作语义** | 后发言的 agent 没机会"补充"或"反驳"前面的 agent |
| **用户没主导权** | `@` 只决定 mention_only 模式下谁会被触发，不决定**顺序**也不决定**唯独这几个** |
| **节奏失控** | 4 个 agent 并发回复，频道一下子刷出 4 条 → 用户阅读顺序被冲乱 |

### 1.3 用户提出的方案（原话复述）

> 每次非 agent 发起一个共同订阅的话题的时候，系统会随机定义一个发言顺序，例如 1，2，3，4 这种，这时候每个 agent 按照顺序进行依次发言，并且每个 agent 发言以前会带上之前所有的 agent 和非 agent 作为上下文，并且标识清楚是谁发言的，这样我们就不会产生并发同时回答的情况，而随机发言顺序又保证了每次不同的 agent 开头，另外，如果非 agent 在发言的时候制定了 @ agent 的顺序的话，就按照他依次 @ 的顺序来排布。

---

## 2. Goals

- **G1**：人类发起的讨论中，agent 串行接龙，每个 agent 看到前面所有人的发言（含之前 agent）
- **G2**：`@` 顺序提供 first-class 控制（用户能强制 A→B→C）
- **G3**：默认随机起始位置，避免每次同一 agent 起头
- **G4**：频道级开关，旧的 parallel 模式保留作为默认
- **G5**：UI 让用户看见队列进度，知道还要等几个 agent

## 3. Non-goals (explicit)

- **Agent 自主讨论循环**：agent 群没有人类介入时自己讨论 N 轮——本设计只覆盖人类发起一次的接龙，不实现 agents-talking-to-agents-without-human-prompt
- **Token 上下文 summarization**：第一阶段直接全堆，等实际遇到 token 爆炸再做
- **跨频道全局调度**：每个频道队列独立
- **复杂取消语义**：用户中途插话只支持"取消当前队列重启"一种策略，不做 partial-retain
- **替代 cooldown / max-consecutive-turns**：这两个机制在 parallel 模式继续有效；round_robin 模式有自己的天然限制（队列单 agent 单 turn），不需要它们

---

## 4. Architecture sketch

### 4.1 数据模型变化

**Channel schema 加一列：**
```sql
ALTER TABLE channel ADD COLUMN discussion_mode TEXT NOT NULL DEFAULT 'parallel'
  CHECK (discussion_mode IN ('parallel', 'round_robin'));
```

**新表 `channel_discussion_queue`**（持久化队列状态，让 backend 重启不丢失进行中的轮询）：
```sql
CREATE TABLE channel_discussion_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  trigger_message_id UUID NOT NULL REFERENCES channel_message(id) ON DELETE CASCADE,
  agent_ids UUID[] NOT NULL,           -- 顺序就是发言顺序
  current_index INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',  -- running | done | cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT chk_status CHECK (status IN ('running', 'done', 'cancelled'))
);

CREATE UNIQUE INDEX uniq_active_queue_per_channel
  ON channel_discussion_queue (channel_id) WHERE status = 'running';
```

唯一索引保证一个频道**最多一个 running queue**——新人类消息触发新队列时，先 `UPDATE ... SET status='cancelled' WHERE channel_id=$1 AND status='running'`，再 INSERT 新队列。

### 4.2 调度路径

```
                   人类发消息
                       │
                       ▼
            ┌──────────────────────┐
            │ EnqueueChannelTask   │
            │  (现有 entry point)  │
            └──────────┬───────────┘
                       │
        discussion_mode = parallel?
                ┌──────┴──────┐
              YES           NO (round_robin)
                │             │
        现有并发派发         ┌─────────────────────┐
        cooldown 限流        │ 1. 取消旧 running   │
                             │    queue (如有)     │
                             │ 2. 解析 @ 序列      │
                             │ 3. 计算 agent_ids   │
                             │ 4. INSERT queue     │
                             │ 5. 派发 agent_ids[0]│
                             │    走现有 task path │
                             └──────────┬──────────┘
                                        │
                                        ▼
                            agent 任务完成 / 失败
                                        │
                            ┌───────────┴────────────┐
                            │ DiscussionAdvancer hook│
                            │ on agent_task complete │
                            │  - current_index++     │
                            │  - 派发下一个 agent     │
                            │  - 完成或失败 → done   │
                            └────────────────────────┘
```

### 4.3 上下文构造

每个 agent 接收 task 时，prompt context 不再是"频道最近 N 条消息"，而是：

```
[Discussion queue context — you are #{position}/{total}]

Conversation so far:
[14:32] 林一 (member): @UI设计师 @资深开发 看看这个方向行不行
[14:32] UI设计师 (agent): I've reviewed the brief, I think direction 9 is...
[14:33] 资深开发 (agent): Building on 设计师's point, technically we should...
[Now you respond as 系统架构师 (agent #4/4)]
```

实现：在 `task.go` 的 `EnqueueChannelTask` 之前，从 queue 表读出 `current_index` 之前所有 messages（trigger + 已完成 agent 的 reply），按时间排序灌进 prompt。

### 4.4 事件流

新 WS 事件，让前端能画进度：

```typescript
type ChannelDiscussionEvent =
  | { type: "channel.discussion_started", channel_id, queue_id, agent_ids: string[], total: number }
  | { type: "channel.discussion_advanced", channel_id, queue_id, current_index: number, current_agent_id: string }
  | { type: "channel.discussion_finished", channel_id, queue_id, status: "done" | "cancelled" }
```

### 4.5 前端

**Channel composer**: 已有 @ mention picker，需要 backend 解析消息体里的 `@<agent_name>` 序列。提交时把 `mentioned_agent_ids` 顺序数组带上。

**Channel view**: 在 `ChannelThinkingIndicator` 上面或替换它，画一个队列条：
```
✻ Discussion queue · 2/4 ━━━━○○ · 系统架构师 thinking
```

**Channel settings panel**: 加一个 toggle：
```
讨论模式
  ○ 并发（默认）— Agent 各自判断要不要回应
  ● 接龙（轮询）— Agent 按顺序串行发言，看完整上下文
```

---

## 5. Open questions — **这一节是你拍板的地方**

### Q1: 什么算"触发讨论"？

人类发言后 round_robin 是否每次都触发？

| 选项 | 触发条件 | 优点 | 缺点 |
|---|---|---|---|
| A | 任何人类消息 | 实现简单 | 你说 "ok" "👍" 也激活 4 agent 串行，2 分钟过去了 |
| B | 仅当消息含 `?` / `@` / 长度 > N 字 | 噪音少 | 启发式规则，边界 case 难调 |
| C | 仅当消息有显式 `@` | 严格用户主导 | 用户每次都要 @，丢失"自动接龙"语义 |
| D | A，但单 agent 只判断一次（agent 觉得不该插话就跳过，用空 reply 进入下一位） | 平衡 | 仍然花 N×LLM 调用判断"我该不该说" |

**我推荐 B + C 的混合：消息含 `@` 走严格 `@` 顺序（C 行为）；不含 `@` 但满足启发式（含 `?` / 长度 > 30 字）触发随机顺序（B 行为）；其他不触发。**

启发式可以从最小规则开始：「**结尾是 ?**」或「**有 `@`**」。

### Q2: 谁进队列？

| 选项 | 规则 | 含义 |
|---|---|---|
| A | 所有 subscribe-mode agent | mention_only agent 即使被 @ 也不进 |
| B | 所有 subscribe-mode + 所有被 @ 的 agent (去重) | 兼容 mention_only |
| C | 有 @ 时仅 @ 的；无 @ 时所有 subscribe-mode | 用户主导更纯粹 |

**推荐 C** — 用户既然 @ 了具体几个 agent，意图就是"只想听这几个的"，让其他 agent 沉默。

### Q3: 队列起始位置怎么定？

| 选项 | 规则 | 优点 |
|---|---|---|
| A | 真随机（每次重 roll） | 多样性极致 |
| B | `hash(trigger_message_id) % N` 决定起始位置 | 确定性 — 同一消息触发的队列在重启 / replay 时位置稳定，便于 debug 和测试 |
| C | round-robin counter（持久化每个 channel 的"上次起始位置 + 1"） | 公平性最强（所有 agent 起始概率均等） |

**推荐 B** — 工程上最易测试，数据量大时分布近似随机，看不出和 A 的差别。

### Q4: 用户中途插话怎么办？

队列还在跑（agent 3/4 还没发言），人类又发一句话：

| 选项 | 行为 |
|---|---|
| A | 取消旧队列，新消息触发新队列 |
| B | 旧队列继续跑完，新消息进 pending，等旧队列结束后启动 |
| C | 把新消息插入旧队列上下文，旧队列剩下的 agent 看到新消息 |

**推荐 A** — 用户的意图就是"不想等了"或"我要说点新的"，强制 cancel 是符合 expectation 的。代码也最简单：上一节那个 unique partial index 已经保证只有一个 running queue。

### Q5: agent 失败 / 超时如何处理？

| 选项 | 行为 |
|---|---|
| A | 阻塞队列 — agent 没回复整个轮询停 |
| B | 跳过失败的 agent — 上下文标记 `(no response)`，下一个 agent 看到 |
| C | 重试 N 次后跳过 |

**推荐 B** — 一个 agent 挂掉不应该 hold 住整个讨论。失败用 UI 显示但不阻塞。

### Q6: 上下文 token 爆炸怎么处理？

| 选项 | 实现 |
|---|---|
| A | 第一阶段直接全堆，监控 token 消耗后再优化 |
| B | 一开始就用 sliding window（最近 N 条 + 头部 trigger 消息） |
| C | 一开始就用 LLM summarization 替换早期消息 |

**推荐 A** — YAGNI。Round-robin 单次最多 8-10 个 agent，token 还远没到上限。先看实际使用频率再决定优化路径。

---

## 6. Design options — 三个抽象层级

### Option α (MVP) — 仅 `@` 硬规则

**改动范围**：
- backend `EnqueueChannelTask` 解析消息体里的 `@<agent_id>` 序列
- 如果有 → 串行派发（一个 agent 完成才派下一个）
- 如果没有 → 现有 parallel
- **不加 channel.discussion_mode 字段**
- **不加 channel_discussion_queue 表**（用 in-memory state 即可，重启丢失可接受）
- **不加 UI toggle**

**工程量**：~半天（backend 修改 + 简单进度 indicator）

**风险**：
- 用户必须 @ 才能体验串行，自动接龙没了
- backend 重启丢队列状态

### Option β (Recommended) — 频道级 toggle + `@` override

**改动范围**：
- 加 `channel.discussion_mode` schema
- 加 `channel_discussion_queue` 表 + DiscussionAdvancer
- backend 区分 parallel / round_robin
- round_robin 触发条件按 §Q1 决定
- 前端 toggle + 队列进度 UI

**工程量**：~2-3 天（backend 1.5d + frontend 1d + tests）

**风险**：
- 工程量翻倍
- 默认 parallel + 用户主动开 round_robin 才用 → 大部分用户感知不到

### Option γ (Aggressive) — 全局默认 round_robin，废除 cooldown

**改动范围**：
- 全部频道默认 round_robin
- 删除 `agent_cooldown_ms` / `max_consecutive_agent_turns` 字段
- parallel 模式作为可选 fallback

**工程量**：~3 天（含数据迁移）

**风险**：
- 现有用户习惯被打破（消息进度肉眼可见变慢）
- 老 channel 数据迁移
- 没有 fallback 路径

### 对比表

| 维度 | α | β | γ |
|---|---|---|---|
| 工程量 | 0.5d | 2-3d | 3d+ |
| 用户主导 | ✓ (必须 @) | ✓✓ (有 @ + auto) | ✓✓✓ |
| 向后兼容 | ✓✓ | ✓✓ | ✗ |
| Schema 改动 | 无 | 中 | 大 |
| UI 工作 | 简 | 中 | 中 |
| 风险 | 低 | 中 | 高 |

---

## 7. Recommended path

**两阶段推进（推荐）：**

1. **Phase 1 — Option α**（MVP，0.5d）
   - 仅 `@` 序列触发串行派发
   - In-memory state 即可
   - 不加 UI toggle，不加表
   - 体验「用户严格主导讨论」
2. **Phase 2 — 升级到 Option β**（基于 Phase 1 反馈，1.5-2d）
   - 加 `discussion_mode` toggle 和持久化队列
   - 加触发启发式（§Q1 推荐的 B+C 混合）
   - 加 UI 进度条

**不推荐 γ** — 默认行为剧烈变化，风险高于收益。

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Round-robin 时序拉长用户感知差 | UI 队列条 + 单 agent 60s 超时跳过 |
| Token 爆炸 | 监控；§Q6 推荐先全堆，遇到再优化 |
| Agent 挂掉阻塞 | §Q5 跳过策略 |
| 用户 @ 拼写错（@错名字）→ 没匹配上 | 发送前在 composer 校验 mention picker，server 二次校验 |
| Backend 重启丢失队列（仅 Option α）| Option α 接受这个 trade-off；β 有持久化表解决 |
| 一个频道有 8+ agent，串行 4 分钟 | 加全队列上限（如 max 6 agents per round），剩余 agent 跳过 |

---

## 9. Decision points — **请你回答**

在我开始写 implementation plan 之前需要拍板：

1. **走 Option α（MVP, 0.5d）还是 Option β（完整, 2-3d）？**
   - α 适合你"想先看看效果"
   - β 适合你"想一步到位"

2. **Q1 触发条件**（如果走 β）
   - A 任何消息 / B 启发式 / C 仅 `@` / D agent 自判断跳过

3. **Q2 谁进队列**（A/B/C）

4. **Q3 起始位置**（A 真随机 / B hash / C round-robin counter）

5. **Q4 中途插话**（A 取消重启 / B 排队 / C 插上下文）

6. **Q5 失败处理**（A 阻塞 / B 跳过 / C 重试 N 次）

7. **Q6 token 处理**（A 全堆 / B sliding / C summarization）

8. **frontend toggle 文案**：
   - "并发 / 接龙"
   - "Parallel / Round-Robin"
   - "Free / Ordered"
   - 别的？

9. **是否覆盖 mention_only agent**：当用户 @ 一个 mention_only agent 时，强制把它加入队列，还是仍然按 mention_only 规则只触发一次（不进串行）？

---

## 10. Out of scope (future work)

- **Agent 自主讨论**：人类发起一轮后，是否允许 agent 在没有人类消息的情况下继续轮询第二轮？现状：无（人类必须再发一次才触发）。未来可考虑，但要严谨防自循环。
- **Multi-human queue**：现在只有一个人类发起就触发，多个人类同时说话怎么办？现状：每个人类消息独立触发（取消上一个）。未来可加"合并多个连续人类消息"逻辑。
- **Agent 主动选择是否发言**：上面 Q1.D 选项，让每个 agent 第一句先用低成本判断"我该不该说"，决定后再生成正式回复。可以省 token 但也增加延迟。
- **Token summarization**：见 §Q6.C。
- **跨频道全局排队**：现在每个频道独立，未来如果 agent 工作量变大可考虑全局调度（不在本设计范围）。

---

## 11. Appendix — 实现关键代码片段（仅供参考，非最终）

### 11.1 解析 `@` 序列

```go
// server/internal/service/channels/mentions.go
var mentionRe = regexp.MustCompile(`@([a-zA-Z0-9_-]+)`)

func ParseMentionSequence(body string, agentsByName map[string]uuid.UUID) []uuid.UUID {
    matches := mentionRe.FindAllStringSubmatch(body, -1)
    seen := make(map[uuid.UUID]struct{})
    out := make([]uuid.UUID, 0, len(matches))
    for _, m := range matches {
        id, ok := agentsByName[m[1]]
        if !ok { continue }
        if _, dup := seen[id]; dup { continue }
        seen[id] = struct{}{}
        out = append(out, id)
    }
    return out
}
```

### 11.2 计算队列顺序

```go
// 简化版，agentIDs 是频道内所有 subscribe-mode agent 的 UUID（已排序）
func ComputeQueue(agentIDs []uuid.UUID, mentioned []uuid.UUID, triggerMsgID uuid.UUID) []uuid.UUID {
    if len(mentioned) > 0 {
        return mentioned // §Q2.C: 有 @ 用 @ 顺序，其他 agent 不进
    }
    if len(agentIDs) == 0 {
        return nil
    }
    // §Q3.B: hash(trigger_message_id) decide 起始位置
    hash := fnv.New32a()
    hash.Write(triggerMsgID[:])
    start := int(hash.Sum32()) % len(agentIDs)
    out := make([]uuid.UUID, len(agentIDs))
    for i := range agentIDs {
        out[i] = agentIDs[(start+i)%len(agentIDs)]
    }
    return out
}
```

### 11.3 前端进度 indicator

```tsx
// channel-discussion-indicator.tsx
function ChannelDiscussionIndicator({ queue }: { queue: DiscussionQueueState }) {
    const { current_index, total, current_agent_id, agent_ids } = queue;
    return (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-serif italic text-brand">✻</span>
            <span>Discussion · {current_index + 1}/{total}</span>
            <div className="flex gap-0.5">
                {agent_ids.map((id, i) => (
                    <span key={id} className={cn(
                        "size-1.5 rounded-full",
                        i < current_index && "bg-brand",
                        i === current_index && "bg-brand animate-pulse",
                        i > current_index && "bg-muted",
                    )} />
                ))}
            </div>
            <ChannelAuthorAvatar authorId={current_agent_id} ... />
            <span>thinking…</span>
        </div>
    );
}
```

---

## 12. What happens after this doc

1. **你回答 §9 的 9 个 decision points**
2. 我基于决策写**实施 plan**（save 到 `docs/superpowers/plans/...`）
3. Plan 决定走 α 还是 β，包含具体文件、TDD 步骤、commit 节奏
4. 用 `superpowers:executing-plans` 或 `subagent-driven-development` 执行

**这个 doc 写完不等于决定要做** — 你看完觉得方向不对、或者优先级不高，可以搁置。
