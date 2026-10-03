/**
 * 中文文案（✅ 决策 #26：中文优先，默认语言）。
 *
 * 命名约定（docs/frontend.md §8.1）：`view.hostDetail.title`、`common.loading`、
 * `metric.cpu.usage`、`error.signature_invalid`。
 * ⚠️ vue-i18n 的 message 里 `@` `|` `{` 有特殊含义，文案里不要裸用。
 */
export default {
  app: {
    name: 'Vantage Console',
  },
  common: {
    loading: '加载中…',
    retry: '重试',
    empty: '暂无数据',
    skeletonNotice: '骨架阶段：本页仅占位，尚未实现业务。',
    specPointer: '工程规格见 docs/frontend.md',
    sidebarToggle: '收起/展开侧栏',
  },
  nav: {
    publicStatus: '公开总览',
    hosts: '主机',
    alerts: '告警',
    settings: '设置',
    login: '登录',
    logout: '登出',
  },
  theme: {
    label: '主题',
    light: '亮色',
    dark: '暗色',
    auto: '跟随系统',
  },
  locale: {
    label: '语言',
    'zh-CN': '简体中文',
    'en-US': 'English',
  },
  realtime: {
    connecting: '连接中',
    open: '实时连接正常',
    closed: '实时连接已断开',
    degraded: '实时连接已降级（重连中）',
  },
  status: {
    online: '在线',
    offline: '离线',
    disabled: '已禁用',
  },
  forbidden: {
    title: '没有访问权限',
    hint: '当前账号为普通用户，该页面仅管理员可访问。',
  },
  notFound: {
    title: '页面不存在',
    hint: '链接可能已失效，或地址输入有误。',
    back: '返回公开总览',
  },
  view: {
    publicStatus: {
      title: '公开总览',
      hint: '免登录只读：当前快照 + 探活概览 + 汇总计数，就地展开、无历史、无 IP。',
    },
    login: {
      title: '登录',
      hint: '用户名密码 + 二次验证（含恢复码登录），同一路由内两步。',
    },
    hostList: {
      title: '主机列表',
      hint: '需登录：状态/标签/名称过滤，含 IP、漂移、Flapping 与活动告警数。',
    },
    hostDetail: {
      title: '主机详情',
      hint: '需登录：当前快照、历史曲线、探活历史、IP 变更时间线、进程 Top。',
    },
    alerts: {
      title: '告警',
      hint: '需登录：事件列表、受控阈值规则、通知通道与静默窗口。',
    },
    settings: {
      title: '设置',
      hint: '需登录（管理员）：Agent 管理、面板账号与 2FA、系统设置、我的会话。',
    },
  },
  error: {
    // 前端自身
    network_error: '网络不可达或请求被中断，请检查连接后重试。',
    private_api_in_public_domain: '公开视图不得调用私有接口（前端缺陷，请上报）。',
    csrf_missing: '写请求缺少 CSRF token（前端缺陷，请上报）。',
    // 400
    invalid_request: '请求格式不正确。',
    schema_invalid: '字段校验未通过，请检查填写内容。',
    range_too_large: '时间范围过大，请缩短范围后重试。',
    expr_not_allowed: '不支持自由表达式。',
    invalid_totp: '验证码不正确，请重新输入。',
    // 401
    signature_invalid: '签名校验失败。',
    timestamp_skew: '请求时间戳偏差过大。',
    agent_unknown_or_disabled: 'Agent 未知或已被禁用。',
    session_expired: '会话已过期，请重新登录。',
    invalid_credentials: '用户名或密码错误。',
    // 403
    role_denied: '当前账号没有该操作的权限。',
    totp_required: '需要完成二次验证后才能继续。',
    totp_setup_required: '按安全策略要求，请先绑定二次验证。',
    csrf_invalid: 'CSRF 校验失败，请刷新页面后重试。',
    // 404 / 409
    not_found: '资源不存在。',
    conflict: '操作与当前状态冲突。',
    already_exists: '对象已存在。',
    nonce_reused: '请求已被处理过（重放被拒绝）。',
    channel_in_use: '该通知通道正在被使用。',
    // 413 / 415 / 429 / 5xx
    payload_too_large: '提交内容超过大小上限。',
    unsupported_content_encoding: '不支持的压缩/编码格式。',
    rate_limited: '尝试过于频繁，请稍后再试。',
    internal_error: '服务端发生错误，请稍后重试。',
    upstream_unavailable: '依赖服务不可用（数据库或缓存），请稍后重试。',
    // 公开视图
    public_view_disabled: '公开视图已关闭，请登录后查看。',
  },
}
