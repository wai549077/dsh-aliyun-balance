# HANDOFF —— dsh-aliyun-balance 交接文档

> 读者是**下一个 AI 会话**：你看不到之前的对话，只依赖仓库文件。
> 这份文档只写「当前事实 + 怎么做」，不写历史过程；日志事件、验收清单等已在 README，不重复抄。

## 2026-10-24 冻结交接：0.1.4 已发布，之后只按反馈维护

### 一句话状态

插件已冻结：**npm 与 GitHub 都是 0.1.4，CI 绿色，101 项测试全绿，工作区干净**。
没有已知待办；除非用户反馈 bug 或外部接口/客户端发生变化，否则不需要发版。

### 交付事实

| 项 | 值 |
|---|---|
| 代码 | `main = 432f001`（`git log --oneline -1` 可复核） |
| 发布 | tag / GitHub Release `v0.1.4` |
| npm | `dsh-aliyun-balance@0.1.4`，`latest`；npmjs 与 npmmirror 均已同步 |
| CI | `.github/workflows/test.yml`，Windows + Node 22，跑 `npm test` |
| 测试 | 101 项，约 2 秒，零运行时依赖 |

### 代码在哪、改完怎么生效

- 开发目录：`C:\Users\WIT_User\.dsh\profiles\desktop\dsh-aliyun-balance`
- 该目录以 `link:` 方式挂进 `~/.dsh/profiles/desktop` 的 bundle，**官方 DSH 与 DSH Desktop 共用这一份代码**
- 宿主数据：`~/.dsh/.credentials.yaml`、`~/.dsh/.dsh-aliyun-balance-settings.json`、`~/.dsh/.dsh-aliyun-balance.json`、`~/.dsh/.dsh-aliyun-balance.log`
- 生效方式（容易误判）：
  - 改 `assets/widget.js` → **整个客户端退出重开**；只刷新页面不保险，渲染进程会缓存脚本
  - 改 `lib/*.js` → 必须重启内核，只重启桌面外壳无效
- 详见 README「开发」一节。

### 本会话完成的内容（按提交）

1. `dd05ca5` / `772bf71`（0.1.3）：官方 DSH 顶部挡墙 —— 挂件最高只能到顶栏下缘（官方 40px），Desktop 探测为 0、行为与 v0.1.2 一致；指针被窗口拖拽抢走时用 `buttons=0` 收尾。
2. `49c9c02`（0.1.4）：界面报错改成中文可执行结论，英文原文/签名串不再上屏；同文同因去重并中文化分区名；原文经 `client-ping` 的 `test-fail` / `save-fail` / `load-fail` / `manual-fail` 写日志，宿主 `refresh-fail` 截 200 字；每条自报带 `client` / `tb` / `v`，启动留 `host` 快照。
3. `51443b6`：`npm test` + Windows CI；测试夹具日期改为相对当前时间（去掉 2027 定时炸弹）；`mkdtemp` 临时目录在 `after` 清理；README 增加 10 条真机验收清单。
4. `432f001`：核对官方文档确认 `QueryCashCoupons` **没有分页参数**，返回完整列表，不需要翻页（只在代码里留注释）。

### 改代码前必须知道的约束

- **不要改变 Desktop 行为**：`ChipCore.topLimit = 0` 时不设挡墙，位置逻辑与 GitHub v0.1.2 一致；只有 `<html data-windows-titlebar>` 存在时才读 `--dsh-windows-titlebar-height`（缺省 40）。
- **界面只说人话**：错误文案必须中文、单行、可照做；任何英文原文/签名串只允许出现在日志。测试会断言界面文本不含英文原文。
- **日志红线**：不得写入 AK/SK；`endpoint` 只允许 `*.aliyuncs.com`；测试连接失败**不得落盘**（坏凭据不能覆盖好凭据）。
- **版本对账**：`assets/widget.js` 的 `CLIENT_VERSION` 必须与 `package.json` 的 `version` 同步，测试会直接变红。
- **零运行时依赖、只读 BSS、不统计消费**：这是产品边界，别加账单/消费/多账号这类需要更大权限的功能。

### 常用命令

```powershell
npm test                                          # 全量 101 项
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
3. 要日志：`C:\Users\<用户名>\.dsh\.dsh-aliyun-balance.log`；事件与 stage 含义见 README「故障排查」。
4. 能复现才动代码；修完必须 `npm test`，并按下表补一条回归。
5. 改了运行时代码才需要发版；只改测试/文档/CI 不发版。

### 已知会随时间漂移的外部依赖

| 会变的 | 早期信号 | 处理 |
|---|---|---|
| npm token 90 天过期 | 发版时 ENEEDAUTH | 重建 granular token 或 OTP |
| DSH 顶栏结构变化 | 日志 `host` 的 `detect` 不是 40；用户说拖到顶上点不动 | 重新探测高度/选择器，更新 `detectTopLimit` |
| 阿里云 BSS 字段或接口变化 | `refresh-fail` 的 `code` / `overview.errors` | 按真实响应更新 `bss-client.js` / `normalize.js` 并补夹具 |
| 插件市场 schema 变化 | 市场页信息缺失 | 更新 `package.json` 的 `dshhub` 段 |

### 有意识没做的事（不要当 TODO）

- 券分页：接口本身没有分页（2026-10 官方文档核对）。
- 布局/Electron 非客户区的自动化 E2E：需要真机或 Playwright，收益低于成本；用 README 的 10 条真机验收代替。
- 消费统计 / 账单趋势 / 自动更新器 / 多账号 / i18n：权限面或维护成本不划算。

### 验证状态（如实）

- 单测：101 项全绿，CI 两次运行均 success（Windows，约 23 秒）。
- 真机：0.1.3 的顶部挡墙由用户验收通过；**0.1.4 的中文报错文案尚未做真机截图验收**，其行为由单测覆盖。
- 未执行：完整 10 条真机清单（下一次发版前按 README 跑一遍）。

### 复现「报错撑成一面墙」（用于验证修复）

用**正确 AK + 故意写错一位的 SK**（AK 本身写错只会得到短消息 `InvalidAccessKeyId`，看不到长文本）：

```powershell
node --input-type=module -e "import {callBss} from './lib/bss-client.js'; const r = await callBss({ ak:'<真实AK>', sk:'<错一位的SK>', action:'QueryAccountBalance', params:{} }); console.log(r.code, String(r.message||'').length)"
```

预期打印 `SignatureDoesNotMatch` 与数千字符长度。再在面板里填入同样凭据点「测试连接」（不要点保存）：旧版会铺开整段 `CanonicalRequest`，0.1.4 只显示一行中文；日志里 `stage=test-fail` 保留完整原文。
