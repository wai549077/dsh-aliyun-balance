import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 必须在 import 之前改 DSH_HOME（paths() 每次调用求值，但保持一致更省心）
const here = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qb-'))
process.env.DSH_HOME = DSH_HOME
after(() => { try { fs.rmSync(DSH_HOME, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } })
const { apply, OVERVIEW_PATH, SETTINGS_PATH, WIDGET_PATH, loadSettings, saveSettings, DEFAULT_SETTINGS, WRITABLE_SETTINGS_KEYS, paths } = await import('../lib/index.js')

function fakeCtx() {
  const routes = new Map()
  const listeners = []
  const ctx = {
    webServer: {
      register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) },
    },
    credentials: {
      store: {},
      async resolve(ref) { return this.store[ref] ? { value: this.store[ref] } : undefined },
      async set(ref, v) { this.store[ref] = v },
    },
    on: (name, fn) => { listeners.push([name, fn]); return () => {} },
    // cordis 的局部等待：这里同步执行，等价于服务已就绪
    inject: (deps, cb) => { cb(ctx); return () => {} },
  }
  return { ctx, routes, listeners }
}

function callRoute(route, { method = 'GET', body, query = '', headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: route.path + query,
      // 默认模拟**自己页面发出的同源写请求**；单条用例可覆盖任意一项来验证闸门
      headers: {
        host: '127.0.0.1:1234',
        origin: 'http://127.0.0.1:1234',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...(headers || {}),
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      status: 0,
      headers: null,
      raw: '',
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(str) {
        this.raw = str || ''
        let parsed = null
        try { parsed = JSON.parse(this.raw) } catch { /* 非 JSON */ }
        resolve({ status: this.status, headers: this.headers, body: parsed, raw: this.raw })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

test('注册三条路由，且只订阅桌面端注入行（不再订阅 session/event）', () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  assert.deepEqual([...f.routes.keys()].sort(), [OVERVIEW_PATH, SETTINGS_PATH, WIDGET_PATH].sort())
  // 只剩一个订阅：桌面端注入行（必须立刻注册）。
  // session/event 已随本机逐轮记账拆除 —— 插件不再触碰任何会话事件。
  assert.deepEqual(f.listeners.map((x) => x[0]), ['webserver/index-inject'])
})

test('幂等激活：二次激活会连晚注册的路由一起释放（liveDisposers 必须闭包引用活数组）', () => {
  // 回归：此前写成 liveDisposers.push(...disposers)，而 start(ctx) 里的路由要等
  // root.inject 触发 start 之后才进数组 —— 展开快照会把它们漏掉，二次激活时
  // disposeLive() 只释放到注入监听，旧路由没释放 → 宿主报 duplicate exact route。
  //
  // 这里刻意模拟**真实宿主的行为**：重复注册同名路由会**抛错**（fakeCtx 用的是 Map，
  // 同 path 覆盖，测不出这个 bug —— 别用 fakeCtx 写这条用例）。
  const routes = new Map()
  const ctx = {
    webServer: {
      register: (r) => {
        if (routes.has(r.path)) throw new Error('duplicate route: ' + r.path)
        routes.set(r.path, r)
        return () => routes.delete(r.path)
      },
    },
    credentials: { store: {}, async resolve() { return undefined }, async set() {} },
    on: () => () => {},
    inject: (deps, cb) => { cb(ctx); return () => {} },
  }

  assert.doesNotThrow(() => apply(ctx, {}), '首次激活')
  assert.equal(routes.size, 3)
  // 关键断言：二次激活前必须把上一次的路由全部释放，否则这里会抛 duplicate route
  assert.doesNotThrow(() => apply(ctx, {}), '二次激活不得撞车 —— 旧路由必须先被释放')
  assert.equal(routes.size, 3, '旧的释放掉、新的注册上，不是 6 条')
})

test('服务延时就绪：inject 的 fiber 必须进 disposers（否则两个 start 先后触发 → duplicate route）', () => {
  // 上一条用例的 fakeCtx.inject 是**同步**回调，覆盖不到「服务还没就绪」这条路径。
  // 真实宿主恰恰是异步的：两次 apply 都可能卡在等待里。若第一次的 fiber 没被释放，
  // 服务就绪时两个 start 会先后跑一遍 → 第二次注册同 path → duplicate exact route。
  const routes = new Map()
  const pending = []
  const ctx = {
    webServer: {
      register: (r) => {
        if (routes.has(r.path)) throw new Error('duplicate route: ' + r.path)
        routes.set(r.path, r)
        return () => routes.delete(r.path)
      },
    },
    credentials: { store: {}, async resolve() { return undefined }, async set() {} },
    on: () => () => {},
    // 只登记回调、不执行 —— 模拟服务尚未就绪
    inject: (deps, cb) => {
      const entry = { cb, disposed: false }
      pending.push(entry)
      return () => { entry.disposed = true }
    },
  }

  apply(ctx, {})
  assert.equal(routes.size, 0, '服务未就绪时一条路由都不该注册')
  apply(ctx, {})
  assert.equal(pending.length, 2)
  assert.equal(pending[0].disposed, true, '第二次激活必须先作废第一次的等待（fiber）')
  assert.equal(pending[1].disposed, false, '第二次自己的等待必须还活着')

  // 只有第二次的回调会被宿主调用；它必须能完整注册三条路由
  assert.doesNotThrow(() => pending[1].cb(ctx))
  assert.equal(routes.size, 3)
})

test('桌面注入行：apply 立刻注册，且推的是内联 script 行（不是 script-src）', () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  const table = []
  const injectListener = f.listeners.find((x) => x[0] === 'webserver/index-inject')[1]
  injectListener(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.match(table[0].text, /dsh-aliyun-balance\/widget\.js/)
  assert.match(table[0].text, /onerror=function\(\)\{\}/)
  // 幂等：再收集一次不会重复推
  injectListener(table)
  assert.equal(table.length, 1)
})

test('widget.js 路由原样回吐挂件脚本（text/javascript）', async () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  const res = await callRoute(f.routes.get(WIDGET_PATH))
  assert.equal(res.status, 200)
  assert.match(String(res.headers['Content-Type']), /javascript/)
  assert.match(res.raw, /dsh-aliyun-balance-root/)
})

test('overview.json 在无凭据时返回 ok:false 且 errors 说明，不抛异常', async () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  const res = await callRoute(f.routes.get(OVERVIEW_PATH))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.errors[0].scope, 'credentials')
})

test('settings 写路由挡跨站请求：Origin 不符 / Sec-Fetch-Site 跨站 / 非 JSON 一律拒', async () => {
  // 这条路由能**写凭据**，而宿主 handler 前面没有鉴权中间件。
  // 浏览器对 text/plain 的 POST/PUT 发的是「简单请求」、不会预检，
  // 所以任意网页都能直接打过来 —— 端到端挡住它，光靠 CORS 不够。
  const f = fakeCtx()
  apply(f.ctx, {})
  const route = f.routes.get(SETTINGS_PATH)

  const cases = [
    { name: '跨源 Origin', headers: { origin: 'http://evil.example.com' }, status: 403 },
    { name: '环回但端口不同', headers: { origin: 'http://127.0.0.1:9999' }, status: 403 },
    { name: 'Sec-Fetch-Site 跨站', headers: { 'sec-fetch-site': 'cross-site' }, status: 403 },
    { name: 'text/plain 简单请求（免预检那条路）', headers: { origin: undefined, 'sec-fetch-site': undefined, 'content-type': 'text/plain;charset=UTF-8' }, status: 415 },
    { name: '完全没有 content-type', headers: { 'content-type': undefined }, status: 415 },
  ]
  for (const c of cases) {
    const res = await callRoute(route, { method: 'PUT', body: { ak: 'X', sk: 'Y' }, headers: c.headers })
    assert.equal(res.status, c.status, c.name + ' 必须被拒')
    assert.equal(res.body.ok, false, c.name + ' 的响应体必须 ok:false')
  }

  // 关键：被拒的请求**一个字节都没写进凭据服务**
  const g = await callRoute(route)
  assert.equal(g.body.settings.hasAk, false, '跨站写请求不得落到凭据服务')
  assert.equal(Object.keys(f.ctx.credentials.store).length, 0, '凭据存储必须仍是空的')

  // 同源请求照常放行（否则就是把自家页面挡在门外）
  const ok = await callRoute(route, { method: 'PUT', body: { ak: 'AK1', sk: 'SK1' } })
  assert.equal(ok.body.ok, true, '同源写请求必须放行')
  assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_AK, 'AK1')
})

test('凭据写入失败必须回 ok:false —— 绝不能谎报「已保存」', async () => {
  // 回归：此前 catch 里什么都不做、照常回 ok:true，前端就报「已保存」；
  // 用户以为配好了，其实密钥没落盘，日志还一条线索都没有。
  const f = fakeCtx()
  f.ctx.credentials.set = async () => { const e = new Error('disk full'); e.code = 'EIO'; throw e }
  apply(f.ctx, {})
  const route = f.routes.get(SETTINGS_PATH)
  const res = await callRoute(route, { method: 'PUT', body: { ak: 'AK1', sk: 'SK1' } })

  assert.equal(res.body.ok, false, '写不进去就绝不能报 ok:true')
  assert.equal(res.body.error, 'CredWriteFailed')
  assert.match(String(res.body.message), /凭据写入失败/)
  assert.equal(Object.keys(f.ctx.credentials.store).length, 0, '凭据存储必须为空')
  assert.equal(res.body.settings.hasAk, false, '读回来也应当是没有')
})

test('取数意外抛错不得被吞：errors 里要有原因（而不是「一片空白 + ¥—」）', async () => {
  // 回归：ensureFresh 原来是 .catch(() => {}) —— 抛错被吞，errors 为空，
  // 界面只能显示 ¥—，什么都不解释。
  // ⚠️ 不能用「fetch 抛错」来造：callBss 自己会把网络错误转成 {ok:false,code:'NetworkError'}，
  // 走的是 noteError 那条老路，这条用例就成了假阳性。必须让**解析阶段**真的抛出来 ——
  // 这里让响应对象的 ok 取值器抛错（等价于阿里云回了个畸形响应）。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    get ok() { throw new Error('boom') },
    status: 200,
    headers: { get: () => null },
    async json() { return {} },
  })
  try {
    const f = fakeCtx()
    apply(f.ctx, {})
    await callRoute(f.routes.get(SETTINGS_PATH), { method: 'PUT', body: { ak: 'AK1', sk: 'SK1' } })
    const res = await callRoute(f.routes.get(OVERVIEW_PATH))
    const scopes = (res.body.errors || []).map((e) => String(e.scope))
    assert.ok(scopes.includes('balance') || scopes.includes('coupons'),
      '抛错必须变成一条 error，而不是被吞掉：' + JSON.stringify(res.body.errors))
    assert.ok((res.body.errors || []).some((e) => String(e.message).includes('boom')), 'error 里应带原因')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('settings PUT 写入凭据服务且 GET 不回显密钥', async () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  const route = f.routes.get(SETTINGS_PATH)
  await callRoute(route, { method: 'PUT', body: { ak: 'AK1', sk: 'SK1' } })
  const g = await callRoute(route)
  assert.equal(g.body.settings.hasAk, true)
  assert.equal(g.body.settings.hasSk, true)
  assert.equal(JSON.stringify(g.body).includes('AK1'), false)
  assert.equal(JSON.stringify(g.body).includes('SK1'), false)
  assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_AK, 'AK1')
  assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_SK, 'SK1')
})

test('settings PUT：白名单 + 取值校验 —— 挡掉任意键，也挡掉把 endpoint 指向非阿里云主机', async () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  const route = f.routes.get(SETTINGS_PATH)

  const res = await callRoute(route, { method: 'PUT', body: {
    balanceRefreshMs: 600000,          // 合法 → 写入
    endpoint: 'evil.example.com',      // 白名单内但取值非法 → 必须拒绝（否则 AK/SK 被引到别处）
    somethingElse: 'nope',             // 未知键 → 拒绝
  } })
  assert.equal(res.body.settings.balanceRefreshMs, 600000, '合法的键正常写入')
  assert.equal(res.body.settings.endpoint, 'business.aliyuncs.com', '非法 endpoint 被拒，保持默认')
  assert.equal('somethingElse' in res.body.settings, false, '未知键不得被写回')

  // 合法的阿里云域名（含国际站）应当放行
  const ok = await callRoute(route, { method: 'PUT', body: { endpoint: 'business.ap-southeast-1.aliyuncs.com' } })
  assert.equal(ok.body.settings.endpoint, 'business.ap-southeast-1.aliyuncs.com', '阿里云国际站域名应放行')

  // 域名形状也要挡：label 必须以字母数字开头结尾，连写的点是旧正则的漏网之鱼。
  // 注意断言「没被写进去」而不是「回到默认值」—— 上面刚成功写入过国际站域名，
  // 被拒时保持的是那个当前值，不是出厂默认。
  for (const bad of ['business..aliyuncs.com', '-a.aliyuncs.com', 'a-.aliyuncs.com', '.aliyuncs.com']) {
    const r = await callRoute(route, { method: 'PUT', body: { endpoint: bad } })
    assert.notEqual(r.body.settings.endpoint, bad, '形状不合规的域名应被拒：' + bad)
  }
  assert.equal(ok.body.settings.endpoint, 'business.ap-southeast-1.aliyuncs.com', '上面那些被拒后，当前值仍是最后一次合法写入')
})

test('客户端自报：?client=1 只写日志并返回 pong，不触达阿里云', async () => {
  const f = fakeCtx()
  apply(f.ctx, {})
  const route = f.routes.get(OVERVIEW_PATH)
  const res = await callRoute(route, { query: '?client=1&stage=apply' })
  assert.equal(res.status, 200)
  assert.equal(res.body.pong, true)
  assert.equal(res.body.ok, true)
  const logFile = path.join(process.env.DSH_HOME, '.dsh-aliyun-balance.log')
  const text = fs.readFileSync(logFile, 'utf8')
  assert.match(text, /"event":"client-ping"/)
  assert.match(text, /"stage":"apply"/)
})

test('loadSettings 过滤掉不认识的键（配置文件里的死键不会回流）', () => {
  // settings.json 可能残留旧版本遗留或手工写入的键：load 只保留 DEFAULT_SETTINGS
  // 认识的键，否则会被 API 回显、被反复写回，越积越多。
  const dead = {
    legacyA: '', legacyB: 'x', legacyC: 'auto',
    legacyD: 2, legacyE: 'builtin', legacyF: {}, legacyG: 3600000,
  }
  fs.writeFileSync(paths().settings, JSON.stringify({ ...dead, endpoint: 'business.aliyuncs.com' }))

  const got = loadSettings()
  for (const k of Object.keys(dead)) {
    assert.equal(k in got, false, k + ' 必须被过滤掉（它已没有任何消费方）')
  }
  // 生效键一个都不能少
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    assert.equal(k in got, true, k + ' 必须保留')
  }

  // 下一次保存把死键从文件里清掉（过滤只在 load 生效，写盘发生在 save）
  saveSettings({})
  const onDisk = JSON.parse(fs.readFileSync(paths().settings, 'utf8'))
  for (const k of Object.keys(dead)) assert.equal(k in onDisk, false, k + ' 保存后不该再写回文件')
})

test('PUT 白名单与 DEFAULT_SETTINGS 的键集一致（防两边漂移）', () => {
  // 白名单少一个 → 用户改不了那个设置；多一个 → 允许写入一个不存在的字段。
  assert.deepEqual(
    [...WRITABLE_SETTINGS_KEYS].sort(),
    Object.keys(DEFAULT_SETTINGS).sort(),
    'WRITABLE_SETTINGS_KEYS 必须与 DEFAULT_SETTINGS 的键完全一致')
})

test('发布包清单：lib/ 下每个文件要么在 files 里、要么在显式排除表里（防漏发）', () => {
  // files 从 "lib"（整目录）改成逐文件列，唯一目的是把冻结的 lib/client.js 排出包外。
  // 代价是：以后往 lib/ 加新文件时忘了写进 files，线上就会缺文件 —— 这条测试把那个代价钉死。
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
  const libDir = path.join(here, '..', 'lib')
  // 有意**不**发出去的文件，每条都要写明理由。
  // （2026-10-08 晚：lib/client.js 已**整体删除** —— 冻结的 React 版与当前形态严重脱节，
  // 注释自己写明「重启用需按 widget.js 重写，不是小修」，「留作底座」前提不成立。
  // 参考件在开发仓库的 git 历史里；本表暂空，未来若有排除项继续在此登记。）
  const EXCLUDED = {}
  const shipped = new Set(pkg.files)
  for (const f of fs.readdirSync(libDir)) {
    const rel = 'lib/' + f
    if (EXCLUDED[f]) {
      assert.equal(shipped.has(rel), false, f + ' 在排除表里，就不该同时出现在 files 里')
      continue
    }
    assert.ok(shipped.has(rel), rel + ' 不在 files 里 → 发布后会缺文件（往 lib/ 加文件记得同步 files）')
  }
  // 反向：files 里列的 lib 文件必须真实存在（防手误写成不存在的路径）
  for (const e of pkg.files) {
    if (e.indexOf('lib/') === 0) {
      assert.ok(fs.existsSync(path.join(here, '..', e)), e + ' 在 files 里但文件不存在')
    }
  }
})

test('宿主组图契约：exports 必须放行 ./package.json（client-modules 定位包清单走 require.resolve，缺失即被静默丢出启动图）', () => {
  const pkgRoot = path.join(here, '..')
  const req = createRequire(pathToFileURL(path.join(pkgRoot, 'lib/index.js')))
  const resolved = req.resolve('dsh-aliyun-balance/package.json') // 修复前：ERR_PACKAGE_PATH_NOT_EXPORTED
  assert.ok(resolved.endsWith('package.json'))
  const pkg = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  assert.equal(pkg.name, 'dsh-aliyun-balance')
  // 原生客户端通道已停用：bundle 能加载并注册成功（client-registered），但随后 renderer 仍被判
  // boot 失败且不给错误消息。摘掉 dsh.client 声明可保证桌面端正常启动；侧栏卡片改由 DOM 兜底挂件的
  // 「视觉锚定」提供。排查记录见开发仓库的 docs/native-client-debug-for-dsh.md。
  assert.equal(pkg.dsh.client, undefined, 'dsh.client 声明应处于停用状态')
  // 2026-10-08 晚：冻结的 React 客户端（lib/client.js）**整体删除** —— 256 行、永不加载、
  // 且与当前形态严重脱节（注释自己写明「重启用需按 widget.js 重写，不是小修」），
  // 「留作底座」的前提不成立。exports["./client"] 随之摘除；
  // 参考件在开发仓库 default-workspace/dsh-aliyun-balance 的 git 历史里。
  assert.equal(pkg.exports['./client'], undefined, '客户端已删除，出口不得残留')
  assert.ok(!fs.existsSync(path.join(pkgRoot, 'lib/client.js')), 'lib/client.js 应已删除')
})