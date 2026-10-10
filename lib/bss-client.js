// 阿里云 BSS OpenAPI 请求构造与签名（纯函数，无网络副作用）
// - v3（默认）：ACS3-HMAC-SHA256，Action/Version 走 x-acs-* 头，业务参数默认进 query
import { createHash, createHmac, randomBytes } from 'node:crypto'

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const BSS_VERSION = '2017-12-14'

const enc = (s) => encodeURIComponent(String(s))
  .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(/%7E/g, '~')
const sha256hex = (s) => createHash('sha256').update(s).digest('hex')
const hmac256hex = (key, s) => createHmac('sha256', key).update(s).digest('hex')
const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const formEncode = (params) => Object.keys(params).sort()
  .map((k) => `${enc(k)}=${enc(params[k])}`).join('&')

export function buildSignedRequest(o) {
  const {
    ak, sk, action, params = {}, endpoint = 'business.aliyuncs.com',
    atMs = Date.now(), nonce = randomBytes(16).toString('hex'),
    paramLocation = 'query', method = 'POST', uri = '/',
  } = o


  const queryString = paramLocation === 'query' ? formEncode(params) : ''
  const body = paramLocation === 'body' && Object.keys(params).length ? formEncode(params) : ''
  const headers = {
    host: endpoint,
    'x-acs-action': action,
    'x-acs-version': BSS_VERSION,
    'x-acs-date': isoUtc(atMs),
    'x-acs-signature-nonce': String(nonce),
    'x-acs-content-sha256': sha256hex(body || ''),
  }
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded'
  const signedHeaders = Object.keys(headers).sort().join(';')
  // CanonicalHeaders：每行 `name:value\n`，**末行也带 \n**；随后由 join('\n') 提供分隔换行。
  // ⚠️ 这里**不能**再额外追加一个 '\n'（曾在头块后多留一个空行 → 服务器报 SignatureDoesNotMatch）。
  // 已用阿里云返回的 `server CanonicalRequest` 反推验证：
  //   QueryCashCoupons  → SHA256(CR) = 05697a12923d5070b61e2145f59509bc01693d7eed967f51f3e10809bbf3d846
  //   QueryAccountBalance → SHA256(CR) = 1b12f48fe6dbe3a7b4ad2fafa881c34d53438812a506ce0dc0cb9327257fdca1
  // 两个哈希都写进了 test/bss-sign.test.mjs 作为黄金用例。
  const canonicalHeaders = Object.keys(headers).sort().map((n) => `${n}:${String(headers[n]).trim()}\n`).join('')
  const canonicalRequest = [method, uri, queryString, canonicalHeaders, signedHeaders, headers['x-acs-content-sha256']].join('\n')
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256hex(canonicalRequest)}`
  const signature = hmac256hex(sk, stringToSign)
  return {
    method, url: `https://${endpoint}${uri}`, queryString, body,
    headers: {
      ...headers,
      authorization: `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
  }
}


export async function callBss(o, fetchImpl = fetch) {
  const r = buildSignedRequest(o)
  const headers = { ...r.headers }
  delete headers.host                       // 交给 fetch 设置，避免 host 不一致
  let res
  try {
    res = await fetchImpl(r.url + (r.queryString ? `?${r.queryString}` : ''), {
      method: r.method, headers, body: r.body || undefined,
    })
  } catch (e) {
    return { ok: false, code: 'NetworkError', message: String(e && e.message || e) }
  }
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  if (!res.ok || (json && json.Success === false)) {
    return { ok: false, code: (json && json.Code) || `HTTP ${res.status}`, message: (json && json.Message) || '', status: res.status }
  }
  return { ok: true, data: json }
}
