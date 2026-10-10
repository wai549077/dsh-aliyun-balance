export function freshness(lastAt, nowMs, ttlMs) {
  if (!Number.isFinite(lastAt)) return 'miss'
  return nowMs - lastAt <= ttlMs ? 'fresh' : 'stale'
}

// 这里原本还有个 retryDelay(attempt)（0 / 60s / 120s 三档退避）与它的 BACKOFF_MS。
// 2026-10-08 删：唯一引用它的是 lib/index.js 那个没人 import 的 __internals 导出，
// 调度侧从来没用过退避（见 lib/index.js 里 schedule() 的说明）。需要时 git 里捞得回来。
