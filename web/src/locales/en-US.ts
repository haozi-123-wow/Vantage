/**
 * English messages.
 *
 * 中文优先（决策 #26）：本文件先建好结构并给出可用译文，缺失的 key 由 vue-i18n 回退到 zh-CN，
 * 因此新增页面时不必等英文文案就位。
 */
export default {
  app: {
    name: 'Vantage Console',
  },
  common: {
    loading: 'Loading…',
    retry: 'Retry',
    empty: 'No data',
    skeletonNotice: 'Skeleton stage: this page is a placeholder, no business logic yet.',
    specPointer: 'Specification: docs/frontend.md',
    sidebarToggle: 'Toggle sidebar',
  },
  nav: {
    publicStatus: 'Public status',
    hosts: 'Hosts',
    alerts: 'Alerts',
    settings: 'Settings',
    login: 'Sign in',
    logout: 'Sign out',
  },
  theme: {
    label: 'Theme',
    light: 'Light',
    dark: 'Dark',
    auto: 'System',
  },
  locale: {
    label: 'Language',
    'zh-CN': '简体中文',
    'en-US': 'English',
  },
  realtime: {
    connecting: 'Connecting',
    open: 'Live connection OK',
    closed: 'Live connection closed',
    degraded: 'Live connection degraded (reconnecting)',
  },
  status: {
    online: 'Online',
    offline: 'Offline',
    disabled: 'Disabled',
  },
  forbidden: {
    title: 'Access denied',
    hint: 'This page requires the admin role.',
  },
  notFound: {
    title: 'Page not found',
    hint: 'The link may be stale or mistyped.',
    back: 'Back to public status',
  },
  view: {
    publicStatus: {
      title: 'Public status',
      hint: 'Read-only, no sign-in: current snapshot, probe overview and summary counts.',
    },
    login: {
      title: 'Sign in',
      hint: 'Password plus second factor (recovery code supported) in a single route.',
    },
    hostList: {
      title: 'Hosts',
      hint: 'Requires sign-in: filters by status, tag and name; includes IP and alert counts.',
    },
    hostDetail: {
      title: 'Host detail',
      hint: 'Requires sign-in: snapshot, metric charts, probe history, IP timeline, process top.',
    },
    alerts: {
      title: 'Alerts',
      hint: 'Requires sign-in: events, controlled threshold rules, channels and silences.',
    },
    settings: {
      title: 'Settings',
      hint: 'Requires sign-in (admin): agents, accounts and 2FA, system settings, sessions.',
    },
  },
  error: {
    network_error: 'Network unreachable or request aborted. Check the connection and retry.',
    private_api_in_public_domain: 'Private APIs must not be called from the public view.',
    csrf_missing: 'Write request is missing a CSRF token.',
    invalid_request: 'Malformed request.',
    schema_invalid: 'Field validation failed.',
    range_too_large: 'Time range too large; narrow it and retry.',
    expr_not_allowed: 'Free-form expressions are not supported.',
    invalid_totp: 'Invalid verification code.',
    signature_invalid: 'Signature verification failed.',
    timestamp_skew: 'Request timestamp skew too large.',
    agent_unknown_or_disabled: 'Agent unknown or disabled.',
    session_expired: 'Session expired; please sign in again.',
    invalid_credentials: 'Incorrect username or password.',
    role_denied: 'Your account is not allowed to perform this action.',
    totp_required: 'Complete the second factor to continue.',
    totp_setup_required: 'Security policy requires binding a second factor first.',
    csrf_invalid: 'CSRF check failed; refresh the page and retry.',
    not_found: 'Resource not found.',
    conflict: 'The operation conflicts with the current state.',
    already_exists: 'Already exists.',
    nonce_reused: 'Request already processed (replay rejected).',
    channel_in_use: 'This notification channel is in use.',
    payload_too_large: 'Payload exceeds the size limit.',
    unsupported_content_encoding: 'Unsupported compression or encoding.',
    rate_limited: 'Too many attempts; please retry later.',
    internal_error: 'Server error; please retry later.',
    upstream_unavailable: 'A dependency is unavailable (database or cache).',
    public_view_disabled: 'The public view is disabled; please sign in.',
  },
}
