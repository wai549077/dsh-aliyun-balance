# HANDOFF —— dsh-aliyun-balance 交接文档

> 读者是**下一个 AI 会话**：你看不到之前的对话，只依赖仓库文件。
> 这份文档只写「当前事实 + 怎么做」，不写历史过程；日志事件、验收清单等已在 README，不重复抄。

## 2026-11-22 交接：0.1.5（高校计划券口径）已实现，**尚未发版**

### 一句话状态

工作区里是 **0.1.5**：新增「只统计高校计划（云工开物）代金券」的口径，109 项测试全绿。
**npm 与 GitHub 上仍是 0.1.4** —— 0.1.5 还没提交/打 tag/发布，发版前须按 README 的 11 条真机清单验收。

### 交付事实

| 项 | 值 |
|---|---|
| 版本 | `package.json` 与 `assets/widget.js` 的 `CLIENT_VERSION` 都是 `0.1.5` |
| 发布 | 仍是 `v0.1.4`（npm + GitHub）；0.1.5 待发 |
| CI | `.github/workflows/test.yml`，Windows + Node 22，跑 `npm test` |
| 测试 | 109 项，约 2 秒，零运行时依赖 |

### 代码在哪、改完怎么生效

- 开发目录：`C:\Users\WIT_User\.dsh\profiles\desktop\dsh-aliyun-balance`
- 该目录以 `link:` 方式挂进 `~/.dsh/profiles/desktop` 的 bundle，**官方 DSH 与 DSH Desktop 共用这一份代码**
- 宿主数据：`~/.dsh/.credentials.yaml`、`~/.dsh/.dsh-aliyun-balance-settings.json`、`~/.dsh/.dsh-aliyun-balance.json`、`~/.dsh/.dsh-aliyun-balance.log`
- 生效方式（容易误判）：
  - 改 `assets/widget.js` → **整个客户端退出重开**；只刷新页面不保险，渲染进程会缓存脚本
  - 改 `lib/*.js` → 必须重启内核，只重启桌面外壳无效
- 详见 README「开发」一节。

### 0.1.5 的核心契约（改之前先读）

阿里云 `QueryCashCoupons` 的响应里**没有券类型 / 来源字段**，唯一稳定的判据是 `Description` 文本。
所以分类是**启发式的**，且只在宿主做一次：

- `lib/normalize.js`：`UNIVERSITY_KEYWORDS = ['云工开物', '高校用云支持计划']`，
  `couponProgram(description)` 命中任一 → `'university'`，否则 `'other'`；
  空/非字符串/纯空白一律 `'other'`（宁可不统计，也不要瞎认）。
  2025 年那批券备注写「指定品类」、2026 年写「限定品类」，但两个专有名词一直在。
- `overview.json` 的 `coupons` **纯增量**：
  - `availableBalance` **语义不变**（仍是全部可用券），别改它，老前端还在读
  - 新增 `universityAvailableBalance` / `universityCouponCount` / `otherAvailableBalance` / `otherCouponCount`
    （只对 `isAvailableStatus` 的券求聚合，用分整数累加）
  - 每张券多一个 `program: 'university' | 'other'`
- 前端**只读 `program`，不重复关键词匹配**：关键词只改一处，否则两处迟早漂移
  （`isAvailableStatus` 已经吃过这个亏，`assets/widget.js:32` 有注释）。
- 口径是**显示项**，不是设置项：`prefs.studentOnly`（默认 `true`，localStorage `dshab.prefs`）。
  **不要**把它加进 `DEFAULT_SETTINGS` / `WRITABLE_SETTINGS_KEYS` —— 那会扩大 settings 的可写面，
  而改口径这件事根本不需要往返宿主。
- 回落规则：`studentOnly` 开着但账户里一张高校券都没有 → 自动按全量统计。
  **这条不能删**，否则没用学生券的用户会看到合计突然变少。
- 悬停明细必须保持「可解释」：主数用哪个口径，券面值 / 已用 / 最早失效时间就都用哪个口径，
  被排除的券单列「其它券（未计入） ¥X · N 张」。
- 日志：`coupon-split` 只记 `total` / `university` / `other` 三个计数，
  **不记 `Description` 原文**（券备注可能带活动名，没必要落盘）。

### 改代码前必须知道的约束

- **不要改变 Desktop 行为**：`ChipCore.topLimit = 0` 时不设挡墙，位置逻辑与 GitHub v0.1.2 一致；只有 `<html data-windows-titlebar>` 存在时才读 `--dsh-windows-titlebar-height`（缺省 40）。
- **界面只说人话**：错误文案必须中文、单行、可照做；任何英文原文/签名串只允许出现在日志。测试会断言界面文本不含英文原文。
- **日志红线**：不得写入 AK/SK；不得写入券备注原文；`endpoint` 只允许 `*.aliyuncs.com`；测试连接失败**不得落盘**（坏凭据不能覆盖好凭据）。
- **版本对账**：`assets/widget.js` 的 `CLIENT_VERSION` 必须与 `package.json` 的 `version` 同步，测试会直接变红。
- **零运行时依赖、只读 BSS、不统计消费**：这是产品边界，别加账单/消费/多账号这类需要更大权限的功能。
- **显示项与外观项要分清**：`prefsPreset()` 只比外观四项；`locked` / `studentOnly` / `showPeak`
  都是显示/状态项，「恢复默认外观」不得动它们（有测试守着）。

### 菜单面板结构（0.1.5 起）

三个入口行：`凭据与设置` / `外观与挂件` / `显示项`。

- 「显示项」的 head checkbox = **只看高校计划券**（`studentOnly`）
- 展开体里是 **计价时段**（`showPeak`）
- 摘要行同时写当前口径与当前时段（如 `只看高校券 · 闲时（便宜）· 4小时后转忙`）
- 以后新增显示类开关都放这个分区，别再新开一行

### 常用命令

```powershell
npm test                                          # 全量 109 项
node test/normalize.test.mjs                      # 单跑一个文件

# 发版（顺序固定）
git push origin main
git tag vX.Y.Z; git push origin vX.Y.Z
npm publish --registry=https://registry.npmjs.org --access public
gh release create vX.Y.Z --title "..." --notes @'...'@
```

发版坑（实测）：

- 本机默认 registry 是 `https://registry.npmmirror.com/`；**发布必须显式加 `--registry=https://registry.npmjs.org`**，否则会报 ENEEDAUTH。
- npm token 是 granular + bypass 2FA，**有效期最长 90 天**；过期就重建或改用 OTP。
- 发布后 packument 可能延迟几分钟：此时 `npm view` 仍显示旧版本、重发会得到 E409/E404，**先去查 `https://registry.npmjs.org/dsh-aliyun-balance/<版本>` 与 `/latest`**，别连点重发。
- 插件市场目录按天构建，发版当天可能仍显示旧版本。
- 已装用户不会自动升级：让他们跑 `dsh plugin update dsh-aliyun-balance`。

### 用户报 bug 时的固定流程

1. 先问三件事：**版本号**（日志 `v=` 或面板）、**客户端**（官方 DSH / Desktop）、**现象**。
2. 低于 `0.1.4` 且是「报错很长/英文」，先让用户升级，不改代码。
3. 报「合计不对」的，先分清是**口径**还是 **bug**：默认只算高校券，比控制台券总额小是正常的；
   悬停卡片的「其它券（未计入）」就是差额来源。真异常看 `coupon-split` 的三个计数。
4. 要日志：`C:\Users\<用户名>\.dsh\.dsh-aliyun-balance.log`；事件与 stage 含义见 README「故障排查」。
5. 能复现才动代码；修完必须 `npm test`，并按下表补一条回归。
6. 改了运行时代码才需要发版；只改测试/文档/CI 不发版。

### 已知会随时间漂移的外部依赖

| 会变的 | 早期信号 | 处理 |
|---|---|---|
| npm token 90 天过期 | 发版时 ENEEDAUTH | 重建 granular token 或 OTP |
| DSH 顶栏结构变化 | 日志 `host` 的 `detect` 不是 40；用户说拖到顶上点不动 | 重新探测高度/选择器，更新 `detectTopLimit` |
| 阿里云 BSS 字段或接口变化 | `refresh-fail` 的 `code` / `overview.errors` | 按真实响应更新 `bss-client.js` / `normalize.js` 并补夹具 |
| **券备注文案变化** | `coupon-split` 的 `university` 变成 0，或悬停「其它券」里出现学生券 | 补 `UNIVERSITY_KEYWORDS`，同步 `test/normalize.test.mjs` 与 README 的口径说明 |
| 阿里云给出真正的券类型字段 | 接口文档新增字段 | 优先用字段，把关键词匹配降级为兜底 |
| 插件市场 schema 变化 | 市场页信息缺失 | 更新 `package.json` 的 `dshhub` 段 |

### 有意识没做的事（不要当 TODO）

- 券分页：接口本身没有分页（2026-10 官方文档核对）。
- **用户自定义关键词 / 正则过滤**：Issue 里提过 `excludePatterns`，暂不做 ——
  用户输入编译成正则有性能与安全风险，配置面也会膨胀；固定关键词集合 + 一个开关足够覆盖
  「学生券场景」这个主诉求。真要做，也必须是固定枚举而不是自由正则。
- 布局/Electron 非客户区的自动化 E2E：需要真机或 Playwright，收益低于成本；用 README 的 11 条真机验收代替。
- 消费统计 / 账单趋势 / 自动更新器 / 多账号 / i18n：权限面或维护成本不划算。

### 验证状态（如实）

- 单测：109 项全绿（本地 Windows，`node --test` 约 2 秒；CI 结果以 push 为准）。
- 真机：0.1.3 的顶部挡墙由用户验收通过；**0.1.4 的中文报错文案、0.1.5 的券口径界面均尚未做真机截图验收**，
  其行为由单测覆盖。
- 未执行：完整 11 条真机清单（发版前按 README 跑一遍）。

### 复现「报错撑成一面墙」（用于验证修复）

用**正确 AK + 故意写错一位的 SK**（AK 本身写错只会得到短消息 `InvalidAccessKeyId`，看不到长文本）：

```powershell
node --input-type=module -e "import {callBss} from './lib/bss-client.js'; const r = await callBss({ ak:'<真实AK>', sk:'<错一位的SK>', action:'QueryAccountBalance', params:{} }); console.log(r.code, String(r.message||'').length)"
```

预期打印 `SignatureDoesNotMatch` 与数千字符长度。再在面板里填入同样凭据点「测试连接」（不要点保存）：旧版会铺开整段 `CanonicalRequest`，0.1.4 只显示一行中文；日志里 `stage=test-fail` 保留完整原文。

### 复现「合计把满减券也算进去了」（0.1.5 修的 bug）

拿一个有学生券 + 平台满减券的账户看 `overview.json`：

```powershell
curl.exe -s http://127.0.0.1:<端口>/dsh-aliyun-balance/overview.json
```

0.1.4 的 `coupons.availableBalance` 是全部券之和（例如 `600.21`），界面照抄就是虚高；
0.1.5 里：

- `availableBalance` 仍是全量（`600.21`，向后兼容）
- `universityAvailableBalance` 只算学生券（`240.21`）
- 界面默认显示 `240.21 + 账户余额`，另起一行「其它券（未计入） ¥360.00 · N 张」

若 `universityAvailableBalance` 是 `0.00` 但明细里有学生券，说明备注关键词又变了 —— 见上表。