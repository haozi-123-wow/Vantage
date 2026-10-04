/**
 * 极验 `getValidate()` → `/auth/captcha/verify` 请求体的**形状投影**回归（2026-10-04 事故）。
 *
 * 事故经过：极验 v4 的 `getValidate()` 返回的是客户端 `POST https://gcaptcha4.geetest.com/verify`
 * 响应里 `data.seccode` 的**原样对象** —— 实测 **5** 个字段
 * （`captcha_id, lot_number, pass_token, gen_time, captcha_output`，`captcha_id` 打头）；
 * 而服务端 `/auth/captcha/verify` 的 schema 是 `additionalProperties: false` 的 4 字段白名单。
 * 前端"把返回值原样转发" → 400 `schema_invalid` → 拿不到 `captcha_token`
 * → 紧接着登录 400 `captcha_required`。用户看到极验弹窗"验证通过"，却永远登不进去。
 *
 * 本文件钉死最后一道闸门：投影**只**产出服务端要的那 4 个字段，多出来的（含厂商将来新增的）一律丢掉。
 */
import { describe, expect, it } from 'vitest'

import { toVerifyBody } from '@/utils/geetest'
import type { GeetestValidate } from '@/utils/geetest'

/** 2026-10-04 实测的真实形状（值是原样保留的样本，`captcha_output` 截短以免刷屏） */
const VENDOR_RESULT: GeetestValidate = {
  captcha_id: '5b1794ab14cb32fdf3f196466ad42bfa',
  lot_number: '3dcc7e8f7e514e59b4b755dd4ead7025',
  pass_token: 'a95f274715c1a07681bb419e456bc7acd9005edc6a183bc1f29aec13e27e7a58',
  gen_time: '1791096563',
  captcha_output: '4WDgRmjKUuMJLK_73otoYGtG6lCqbkZrdMpPK82yBQziqa',
}

describe('极验验证结果 → /auth/captcha/verify 请求体', () => {
  it('只挑服务端白名单里的 4 个字段：厂商多带的 captcha_id 必须被丢掉', () => {
    const body = toVerifyBody(VENDOR_RESULT)

    expect(Object.keys(body).sort()).toEqual(['captcha_output', 'gen_time', 'lot_number', 'pass_token'])
    expect(body).not.toHaveProperty('captcha_id')
    expect(body).toEqual({
      lot_number: VENDOR_RESULT.lot_number,
      captcha_output: VENDOR_RESULT.captcha_output,
      pass_token: VENDOR_RESULT.pass_token,
      gen_time: VENDOR_RESULT.gen_time,
    })
  })

  it('厂商将来新增的未知字段同样被挡掉（白名单契约只在这一处收口）', () => {
    // ⚠️ 先落到变量上再传入：绕过 TS 的对象字面量多余属性检查，模拟"厂商多返回了几个字段"
    const withUnknownFields = {
      ...VENDOR_RESULT,
      captcha_type: 'slide',
      challenge: 'challenge-id',
      score: 3,
    }

    const body = toVerifyBody(withUnknownFields)
    const serialized = JSON.stringify(body)

    expect(Object.keys(body).sort()).toEqual(['captcha_output', 'gen_time', 'lot_number', 'pass_token'])
    expect(serialized).not.toContain('captcha_type')
    expect(serialized).not.toContain('challenge-id')
    expect(serialized).not.toContain('captcha_id')
  })
})
