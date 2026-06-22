# aws-case-design 重设计:四层选型 + schema 一致性修复

> 状态:待评审
> 日期:2026-06-15
> 上游:[2026-06-15-vnext-quality-pipeline-trd.md](./2026-06-15-vnext-quality-pipeline-trd.md) §5 / [2026-06-15-m3-fuzz-performance-design.md](./2026-06-15-m3-fuzz-performance-design.md) §4
> 建模决策:**Model A — 一 case 一 target**(用户确认)
> 关系:本文细化并取代 M3 设计 §4 中关于 case-design 的部分

---

## 1. 为什么要重设计

两组问题:**A 类是现存 bug(与 M3 无关,现在就该修)**,**B 类是 M3 四层选型需要的新能力**。

### A 类 — 现存矛盾

| 编号 | 问题 | 证据 |
|------|------|------|
| A1 | `automation`(schema 字段)vs `automation_targets`(正文用语)命名打架;且 readiness check #44 **禁止** `automation_targets` 字段名 | schema L722 用 `automation`;正文 L3/L120/L439/L471 用 `automation_targets`;readiness L1212 禁止 `automation_targets` |
| A2 | 双重事实源:top-level `type` 与 `automation.target` 重复同一信息,可漂移;`Mixed` 语义模糊 | L683 `type` 与 L724 `automation.target` 枚举完全相同 |
| A3 | 死枚举:`Unit` / `Visual` 从未被 workflow 生产(只有 API/E2E codegen) | L683 / L724 |

### B 类 — M3 四层选型缺口

| 编号 | 问题 |
|------|------|
| B1 | `type` / `automation.target` / `framework` 枚举不含 Fuzz / Performance / schemathesis / locust |
| B2 | 决策树只有 API vs E2E 两层 |
| B3 | 8 类澄清问题不覆盖工具选型(category 3 只 API/E2E/Unit/Visual,category 7 只问 tests/api/e2e) |
| B4 | 选型无「确认即锁定」机制(TRD Principle 4 要求确认后下游不可覆盖) |
| B5 | `automation` 是 flat 结构,装不下 fuzz endpoints / perf thresholds |

---

## 2. 建模决策:Model A(一 case 一 target)

**每个 case 恰好一个测试目标。** Fuzz / Performance 是**独立 case**(`type: Fuzz` / `type: Performance`),通过 `related_cases` 关联被测功能 case。

理由:
- 保持现有「一 case 一 target」架构,reviewer 易校验,plan/codegen 按 type 单一路由
- 去掉 `Mixed`(语义模糊的根源)
- 同一端点的功能验证(API)与鲁棒性(Fuzz)/性能(Performance)是**不同测试意图**,分开成 case 更符合 ISTQB 一 case 一意图原则

代价(可接受):同一端点可能出现在多个 case(1 个 API + 1 个 Fuzz + 1 个 Perf),端点信息有少量重复 → 用 `related_cases` 串联,reviewer 校验不重复断言。

---

## 3. 新 schema

### 3.1 单一事实源:`type` 即 target(修 A2/A3/B1)

**删除 `automation.target`**。top-level `type` 成为唯一的目标字段:

```yaml
type: API | E2E | Fuzz | Performance      # 删除 Unit | Visual | Mixed
```

> 理由:Model A 下一 case 一 target,`type` 与 `automation.target` 永远相等,保留两个只会漂移。`type` 更显眼(用于 case_id、Web 展示),作为唯一事实源。`automation` 块只描述「如何自动化」,不再重复「测什么目标」。

### 3.2 `automation` 块重构(修 A1/B4/B5)

```yaml
automation:
  required: true | false
  framework: pytest | pytest-playwright | schemathesis | locust | null
  suggested_file: <optional-test-file-path>
  status: not_automated | planned | automated | flaky | deprecated

  # 选型锁定(B4):用户确认后写入,下游 Plan/Codegen/Run 只读不可覆盖
  confirmed_by: user | null
  confirmed_at: <ISO-8601 | null>

  # 目标专属配置(B5):仅当 type 对应时出现
  fuzz:                          # 仅 type: Fuzz
    endpoints: ["/api/v1/menu/create"]
    expectations: ["no 5xx", "schema-valid input not rejected with 400"]
  performance:                   # 仅 type: Performance
    scenario:
      capability: "menu-list-query"
      endpoint: "/api/v1/menu/list"
      thresholds: { p95_ms: 200, error_rate_max: 0.01 }
      load: { users: 50, spawn_rate: 10, run_time_s: 60 }
```

> - **彻底移除 `automation_targets` 一词**(修 A1):全文统一为 `automation`。readiness check #44 保留"禁止 `automation_targets` 字段"。
> - `framework` 加 `schemathesis` / `locust`(B1)。
> - `fuzz` / `performance` 子块仅在对应 type 出现(B5)。

### 3.3 framework 与 type 对应关系

| type | framework | 产物目录 |
|------|-----------|----------|
| API | pytest | tests/api/ |
| E2E | pytest-playwright | tests/e2e/ |
| Fuzz | schemathesis | tests/fuzz/ |
| Performance | locust | tests/perf/ |

readiness check 新增:`framework` 必须与 `type` 匹配(上表)。

---

## 4. 决策树四层(修 B2)

替换 L118-134:

```
每条 Case 的验证行为:
├─ 单 HTTP 请求 + 响应断言            → type: API         (tests/api/)
│    状态码 / 响应体 / 权限码 / 字段校验 / 错误码矩阵
├─ 多步浏览器交互 + UI 反馈           → type: E2E         (tests/e2e/)
│    表单提交触发列表刷新 / 确认弹窗交互
├─ 复杂输入 / Schema / 边界 / Parser  → type: Fuzz        (tests/fuzz/)
│    用户输入端点的鲁棒性(不崩、不 5xx、schema 合法输入不误拒)
└─ 高频 / 核心 / 复杂查询 / 关键能力   → type: Performance (tests/perf/)
     绝对阈值(P95 / error_rate),无历史基线
```

Hard rules(扩展):
- API 能覆盖的功能断言,不要设计成 E2E
- 错误码矩阵归 API
- E2E 保留 1 happy-path + 至多 2-3 关键异常流
- 同一断言点不得在多个 type 的 case 重复
- **Fuzz 不替代功能断言**:每个 Fuzz case 必须 `related_cases` 指向对应 API case
- **Performance 必须带 thresholds**:无阈值的 Performance case 不合法(reviewer blocker)
- **Fuzz/Performance 是附加 case**,不取消该端点的功能 case 覆盖

---

## 5. 8 类澄清问题更新(修 B3)

| # | Category | 原 | 改 |
|---|----------|----|----|
| 3 | Test types | API / E2E / Unit / Visual / Mixed | **API / E2E / Fuzz / Performance**(去 Unit/Visual/Mixed) |
| 7 | Automation target | tests/api 或 tests/e2e ? | **选型 + 深广度**:需要哪些 type?Fuzz 端点?Performance 场景与阈值? |

新增澄清子项(仅当用户选了 Fuzz / Performance 时追问):
- Fuzz:哪些端点需要鲁棒性测试?
- Performance:哪个能力是高频/核心?可接受的 P95 与错误率阈值是多少?(必须用户给出,无默认)

选型对话仍复用现有 Checklist 第 6-7 步(propose 2-3 approaches → 用户确认),**不新增确认点**。用户确认后,写 `automation.confirmed_by/confirmed_at`。

---

## 6. proposal.md Layer Rationale 四层(配合 reviewer)

L436-445 的 Layer Rationale 扩展示例覆盖四类:

```markdown
## Layer Rationale

- TC-MENU-001: API
  - reason: 单请求验证 create 返回 200 + 业务码
- TC-MENU-FUZZ-001: Fuzz
  - reason: create 接受用户输入 schema,需鲁棒性;关联 TC-MENU-001
- TC-MENU-PERF-001: Performance
  - reason: list 为高频查询接口,P95<200ms;关联 TC-MENU-002
```

> reviewer §13 Layering Review 据此交叉校验每个 case 的 `type`(详见 M3 设计 §4.4)。

---

## 7. case_id 约定

现有正则 `TC-[A-Z0-9]+(-[A-Z0-9]+)*-[0-9]{3}` **无需修改**,新 case 类型用中缀区分:

| type | 约定 | 示例 |
|------|------|------|
| API | `TC-<MODULE>-NNN` | TC-MENU-001 |
| E2E | `TC-<MODULE>-E2E-NNN` | TC-MENU-E2E-001 |
| Fuzz | `TC-<MODULE>-FUZZ-NNN` | TC-MENU-FUZZ-001 |
| Performance | `TC-<MODULE>-PERF-NNN` | TC-MENU-PERF-001 |

---

## 8. readiness check 变更

| 编号 | 变更 |
|------|------|
| #15 `type` | 枚举改为 `API / E2E / Fuzz / Performance` |
| #32 `automation` | 删除 `automation.target` 校验;`framework` 加 schemathesis/locust;校验 `framework` 与 `type` 匹配 |
| 新增 | type==Fuzz → 必须有 `automation.fuzz.endpoints` |
| 新增 | type==Performance → 必须有 `automation.performance.scenario.thresholds`(p95_ms + error_rate_max 非空) |
| 新增 | type==Fuzz → 必须有 `related_cases` 指向至少一个非 Fuzz case |
| #44 | 保留"禁止 `automation_targets` 字段";同时确保正文不再出现该词 |

---

## 9. 文档内一致性清理(修 A1)

全文 `automation_targets` → `automation`,涉及:

| 位置 | 现 | 改 |
|------|----|----|
| description(L3) | "automation targets" | "test target selection (API/E2E/Fuzz/Performance)" |
| 决策树(L120) | "before assigning `automation_targets`" | "before assigning each case's `type`" |
| Layer Rationale(L439) | "cross-check `automation_targets`" | "cross-check each case's `type`" |
| Exit Criteria(L471) | "automation targets are identified" | "test targets (type) are identified and confirmed" |

---

## 10. 迁移影响(下游 skill)

Model A + 删除 `automation.target` 影响读取该字段的下游:

| Skill | 影响 | 处理 |
|-------|------|------|
| `aws-case-reviewer` | §13 Layering Review 读 `automation_targets` | 改读 `type`;扩展四层校验(M3 §4.4) |
| `aws-api-plan` | "Only processes API cases with automation.required" | 筛选条件改为 `type == API && automation.required`(原依赖 target 的逻辑统一到 type) |
| `aws-e2e-plan` | 同上 | `type == E2E && automation.required` |
| `aws-fuzz-plan`(M3 新) | — | `type == Fuzz` |
| `aws-performance-plan`(M3 新) | — | `type == Performance` |

> 关键:所有"按 target 筛 case"的下游统一改为"按 `type` 筛",消除 A2 漂移源。

---

## 11. 落地顺序(并入 M3 Phase A)

```
A1  修 A 类 bug(可独立先行,不依赖 M3):
    - 全文 automation_targets → automation
    - 删除 automation.target,type 成单一事实源
    - 去掉 Unit/Visual/Mixed 死枚举
    - aws-case-reviewer / aws-api-plan / aws-e2e-plan 改读 type
A2  四层扩展(M3):
    - type/framework 加 Fuzz/Performance/schemathesis/locust
    - 决策树四层 + Hard rules
    - automation.fuzz / automation.performance 子块
    - confirmed_by/confirmed_at 锁定
    - 8 类澄清问题更新
    - readiness check 新增校验
```

> A1 是纯一致性修复,**可以脱离 M3 先做**(消除现存 bug);A2 随 M3 Phase A 一起落地。

---

## 12. 开放项

| 编号 | 开放项 | 倾向 |
|------|--------|------|
| R1 | 删除 `automation.target` 是否影响已归档的存量 case.yaml | 存量 case 在 `qa/cases/` 已合并,迁移时 target 与 type 本就相等,可写一次性脚本对齐;或 reviewer 容忍旧字段(读 type 优先) |
| R2 | `confirmed_by` 是否支持非 user(如 orchestrator 自动确认低风险选型) | 暂只支持 `user`;自动确认留后续 |
| R3 | 一端点多 case(API+Fuzz+Perf)是否需要 reviewer 强制 related_cases 双向链 | M3 先单向(Fuzz/Perf → 功能 case);双向校验留后续 |
