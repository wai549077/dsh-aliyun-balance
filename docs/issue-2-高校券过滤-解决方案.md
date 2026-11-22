# Issue #2 解决方案：可用券合计把满减券也算进去了

> 对应上游 issue：[wai549077/dsh-aliyun-balance#2](https://github.com/wai549077/dsh-aliyun-balance/issues/2)
> 状态：已在 **0.1.5** 实现（本仓库工作区），待验收后发版。
> 这份文档是给维护者与后来者的说明，也用作 issue 回复的底稿。

## 1. 问题

界面那一行的「可用合计」把**所有**可用代金券都加了进去：

- 高校计划（云工开物）学生券剩 `¥240.21`
- 6 张「千问 AI 11.11」满减券共 `¥360.00`（个人满 600 减 30、满 400 减 20……）
- 旧版显示 `¥601`（`600.21 + 账户余额`）

满减券要**先花到门槛**才能抵扣，把它当成「现在就能用的钱」是虚高；学生券场景下这个数字
直接失真（真实可用只有 `¥241`）。

## 2. 根因

`QueryCashCoupons`（BSS OpenAPI，2017-12-14）的响应里**没有券类型 / 来源 / 计划字段**：

```
Data.CashCoupon[] = { CashCouponId, CashCouponNo, Status, NominalValue, Balance,
                      EffectiveTime, ExpiryTime, GrantedTime, ApplicableProducts,
                      ApplicableScenarios, Description }
```

旧版 `normalize.js` 把所有 `Status ∈ {Available, AvailableToUse}` 的券 `Balance` 直接求和，
没有任何来源区分 —— 代码本身没错，是**接口信息不足以区分**。

唯一稳定可用的判据是 `Description`（券备注）。实测样本：

| 券 | Description |
|---|---|
| 学生券 2026 | 高校用云支持计划云工开物代金券，**限定**品类可用，可用品类请参考云工开物页面… |
| 学生券 2025 | 高校用云支持计划云工开物代金券，**指定**品类可用，可用品类请参考云工开物页面… |
| 满减券 | 【千问 AI 11.11】个人满600元减30元 |
| 已过期满减券 | 满减券 |

两代学生券的措辞在漂移（限定/指定），但「**云工开物**」「**高校用云支持计划**」两个专有名词
一直存在，因此用它们做关键词。

## 3. 方案（0.1.5 已实现）

### 3.1 分类只在宿主做一次

`lib/normalize.js`：

```js
export const UNIVERSITY_KEYWORDS = ['云工开物', '高校用云支持计划']

export function couponProgram(description) {
  const text = typeof description === 'string' ? description.trim() : ''
  if (!text) return 'other'
  return UNIVERSITY_KEYWORDS.some((k) => text.includes(k)) ? 'university' : 'other'
}
```

- 非字符串 / 空 / 纯空白 → `'other'`：**宁可不统计，也不瞎认**
- 前端不再重复匹配关键词（`isAvailableStatus` 重复两份已经吃过一次亏）

### 3.2 `overview.json` 契约纯增量

| 字段 | 说明 |
|---|---|
| `coupons.availableBalance` | **语义不变**，仍是全部可用券之和（老前端还在读） |
| `coupons.universityAvailableBalance` | 高校计划券可用余额之和 |
| `coupons.universityCouponCount` | 高校计划可用券张数 |
| `coupons.otherAvailableBalance` | 其它可用券余额之和 |
| `coupons.otherCouponCount` | 其它可用券张数 |
| `coupons.items[].program` | `'university' \| 'other'` |

聚合只对 `isAvailableStatus` 的券计算，用「分」整数累加，避免浮点误差。

### 3.3 口径是显示项，不是设置项

- `prefs.studentOnly`（localStorage `dshab.prefs`，默认 `true`）
- **不**进 `DEFAULT_SETTINGS` / `WRITABLE_SETTINGS_KEYS`：改口径不需要往返宿主，
  也不该扩大 settings 的可写面（那里有决定凭据发往哪台主机的 `endpoint`）
- 面板第三入口行改为「显示项」：行上开关管口径，展开体里放计价时段

### 3.4 被排除的券不会无声消失

学生券场景下用户最怕「数字变对了，但少掉的钱去哪了」。所以：

- 悬停明细固定多一行：`其它券（未计入） ¥360.00 · 6 张`
- 券面值 / 已用 / 最早失效时间**跟主数同口径**（只看高校券时只算高校券），
  否则卡片内部会自相矛盾
- 标题写明口径：`可用合计（高校券 + 阿里云余额）`

### 3.5 回落规则

`studentOnly` 开着但账户里**一张高校券都没有** → 自动按全量统计，合计与 0.1.4 完全一致。

这不是偷懒：不用学生券的用户占多数，加了过滤就把他们的数字改成 0 是更严重的回归。

### 3.6 日志

新增 `coupon-split` 事件，只记 `total` / `university` / `other` 三个计数，
**不记 `Description` 原文** —— 排查「合计为什么是这个数」不需要把券备注抄进磁盘。

## 4. 兼容性

| 组合 | 结果 |
|---|---|
| 旧前端 + 新宿主 | 只读 `availableBalance` → 行为与 0.1.4 完全一致 |
| 新前端 + 旧宿主 | 没有 `program` → 全部归为 `other`、`university` 为空 → 自动回落全量口径 |
| 新前端 + 新宿主 | 默认只看高校券 |

`availableBalance` 语义不变是关键：它是唯一被老版本前端消费的字段。

## 5. 与 issue 建议的差异

issue 里提过两种配置：`excludePatterns`（用户自定义排除正则）或 `excludeFullDiscount`（布尔）。

本次只做了**固定关键词 + 一个开关**，理由：

1. 用户输入编译成 `RegExp` 有性能与 ReDoS 风险，还得处理转义、大小写、空串
2. 配置面一旦开放，后续要解释「为什么我的正则不生效」，维护成本远超收益
3. 主诉求是「学生券场景别混满减券」，固定关键词 + 默认开 + 可关闭已经覆盖

如果将来阿里云给出真正的券类型字段，应**优先用字段**，把关键词匹配降级为兜底。

## 6. 验证

- `test/normalize.test.mjs`：分类（两代措辞、满减券、空/非字符串/前后空格）、聚合
  （`600.21 = 240.21 + 360.00`，count `1 / 6`）、分类不影响排序、过期券不入聚合
- `test/widget.test.mjs`：默认口径 `¥266.93`、同口径面值 `¥300.00 / ¥59.79`、
  「其它券（未计入） ¥360.00 · 2 张」、关掉后 `¥626.93`、无高校券回落 `¥326.72`、
  过期高校券不入账、「恢复默认外观」不动两个显示项
- `test/host-e2e.test.mjs`：假 BSS 两张券跑通全链路，断言 4 个聚合字段与 `program`，
  日志含 `coupon-split` 且不含券备注原文
- 全量 **109 项**通过

## 7. 是否提 PR

代码在本仓库完成。是否向上游提 PR / 在 issue 下回复，**由仓库所有者决定**；
本文件可直接作为回复内容或 PR 描述的主体。