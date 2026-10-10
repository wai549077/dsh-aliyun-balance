import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshness } from '../lib/cache.js'

test('新鲜度三态', () => {
  assert.equal(freshness(1000, 1500, 1000), 'fresh')
  assert.equal(freshness(1000, 2500, 1000), 'stale')
  assert.equal(freshness(null, 2500, 1000), 'miss')
})

test('ttl 边界相等视为 fresh', () => {
  assert.equal(freshness(1000, 2000, 1000), 'fresh')
  assert.equal(freshness(1000, 2001, 1000), 'stale')
})

// 「退避上限 2 次」「attempt 非法值容错」两条已删：它们测的 retryDelay 于 2026-10-08 删除
// （唯一引用它的 __internals 导出没人 import，调度侧从来没用过退避）。

test('非法/缺失入参容错', () => {
  assert.equal(freshness(undefined, 2500, 1000), 'miss')
  assert.equal(freshness(NaN, 2500, 1000), 'miss')
})
