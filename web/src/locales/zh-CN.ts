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
    account: '我的账号',
    settings: '设置',
    login: '登录',
    logout: '登出',
    enterConsole: '进入控制台',
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
  captcha: {
    // 人机验证：自建滑块（docs/slider-captcha-selfbuilt.md §7.4）+ 极验 v4（docs/geetest-captcha.md §7.4）
    // ⛔ 组件里不硬编码文案；⚠️ 极验验证窗**内部**的文案不受本站 i18n 控制（由服务端下发的 language 决定）
    title: '请完成安全验证',
    hint: '拖动滑块使拼图吻合',
    required: '检测到多次登录失败，请完成验证',
    loading: '正在加载人机验证…',
    retry: '再试一次',
    refresh: '换一张',
    cancel: '取消',
    expired: '验证已过期，已为你换一张',
    failed: '验证未通过，请重试',
    suspicious: '操作轨迹异常，请重试',
    tooManyAttempts: '同一题失败次数过多，已为你换一张',
    unavailable: '验证暂时不可用，请稍后再试',
    verified: '验证通过',
    // —— 极验 v4 专用（自建分支不引用）——
    vendorFailed: '人机验证组件加载失败，请稍后重试；若持续失败请联系管理员。',
    closed: '你关闭了验证窗口，请重新点击验证按钮完成验证。',
    ariaLabel: '滑块验证：按左右方向键每次移动 5 像素，按回车提交',
  },
  // 二次验证（2FA）自助绑定（docs/frontend.md §4.6 / docs/api.md §4.1 B6）
  twoFactor: {
    sectionTitle: '二次验证（2FA）',
    restrictedTitle: '按安全策略，必须先绑定二次验证',
    restrictedHint: '绑定完成前，控制台的其它功能不可用（只放行本页与登出）。',
    missingCsrfTitle: '本次会话缺少写操作令牌，无法完成绑定',
    missingCsrfHint:
      '受限状态下服务端不返回 CSRF 令牌（刷新页面后会丢失），所以需要重新登录一次，登录后立即在本页完成绑定。',
    relogin: '重新登录',
    setupUnavailable: '密钥获取失败，请重试。',
    setupFailedRetry: '重新获取密钥',
    scanHint:
      '用身份验证器（Google Authenticator、1Password 等）扫描二维码；无法扫码时，手工输入下面的密钥。',
    manualSecret: '手工密钥（Base32）',
    secretOnce: '密钥与二维码仅本次显示，绑定成功后不再展示。',
    codeLabel: '验证器上的 6 位验证码',
    missingCode: '请输入 6 位验证码。',
    enable: '完成绑定',
    reissue: '换一个密钥',
    alreadyBound: '该账号已绑定 2FA。如需换绑，请用恢复码登录，或联系管理员重置。',
    invalidCodeResent: '验证码不正确；已重新生成密钥，请重新扫码后再试。',
    boundTitle: '已绑定二次验证',
    boundHint:
      '登录时需要输入验证器上的 6 位验证码。丢失设备时可用恢复码登录，或由管理员重置二次验证。',
    recoveryTitle: '请立即保存这 10 个恢复码',
    recoveryHint: '每个恢复码只能使用一次；离开本页后无法再次查看（丢失设备时靠它登录）。',
    recoveryCount: '剩余可用：{count} 个',
    recoveryAcknowledge: '我已妥善保存',
    copy: '复制',
    copyAll: '复制全部',
    copied: '已复制',
    copyFailed: '复制失败，请手动选择文本复制。',
    qrAlt: '二次验证绑定二维码',
  },
  view: {
    publicStatus: {
      title: '公开总览',
      hint: '免登录只读：当前快照 + 探活概览 + 汇总计数，就地展开、无历史、无 IP。',
    },
    login: {
      title: '登录',
      hint: '用户名密码 + 二次验证（含恢复码登录），同一路由内两步。',
      username: '用户名',
      password: '密码',
      submit: '登录',
      totp: '动态验证码',
      totpHint: '请输入身份验证器上的 6 位数字。',
      verify: '验证',
      recovery: '恢复码',
      recoveryHint: '请输入一个尚未使用的恢复码（用后即废）。',
      useRecovery: '使用恢复码登录',
      usePassword: '返回密码登录',
      missingCredentials: '请填写用户名与密码。',
      missingTotp: '请输入 6 位动态验证码。',
      missingRecovery: '请输入恢复码。',
      recoveryLow: '恢复码快用完了（剩余 {count} 个），请到「我的账号」页重新生成。',
      captchaFallback:
        '无法完成人机验证时：可稍等几分钟再试（失败计数在窗口过期后清零），或联系管理员重置二次验证。',
      rateLimited: '{seconds} 秒后可重试',
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
    account: {
      title: '我的账号',
      hint: '自助项：二次验证（绑定 / 解绑 / 恢复码）；后续在此加入「我的会话」与 SSO 绑定状态。',
      pending: '「我的会话」与 SSO 绑定状态将在后续增量落在这里。',
    },
    settings: {
      title: '设置',
      hint: '需登录（管理员）：Agent 管理、用户与权限、系统设置、公开视图开关。',
      accountLink: '二次验证请到「我的账号」页管理',
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
    // 人机验证（docs/api.md §1.3 / 自建方案 §5.4 / 变更方案 §6.2）
    captcha_required: '请先完成人机验证。',
    captcha_invalid: '人机验证未通过，请重新尝试。',
    // ⚠️ 极验不可达且 failMode=closed 时出现（默认 open 则不会）：5xx 的 message 会被服务端折叠成
    //    通用文案，所以前端**必须按 error.code 匹配**（docs/api.md §1.3）
    captcha_unavailable: '人机验证服务暂时不可用，请稍后再试或联系管理员。',
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
