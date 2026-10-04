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
    account: 'My account',
    settings: 'Settings',
    login: 'Sign in',
    logout: 'Sign out',
    enterConsole: 'Open console',
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
  captcha: {
    // Human verification: self-built slider (docs/slider-captcha-selfbuilt.md §7.4) + GeeTest v4
    // (docs/geetest-captcha.md §7.4). ⛔ No hardcoded copy in components; ⚠️ the text *inside* the
    // GeeTest window is not controlled by this app (it follows the `language` sent by the server).
    title: 'Security check',
    hint: 'Drag the slider to fit the piece',
    required: 'Multiple sign-in failures detected. Please complete the check.',
    loading: 'Loading human verification…',
    retry: 'Try again',
    refresh: 'New challenge',
    cancel: 'Cancel',
    expired: 'The challenge expired; a new one has been issued',
    failed: 'Verification failed, please try again',
    suspicious: 'Suspicious pointer track, please try again',
    tooManyAttempts: 'Too many failures on this challenge; a new one has been issued',
    unavailable: 'Verification is temporarily unavailable, please try later',
    verified: 'Verified',
    // —— GeeTest v4 only (the self-built branch never references these) ——
    vendorFailed: 'The verification widget failed to load. Retry later; contact an administrator if it persists.',
    closed: 'You closed the verification window; click the verification button again to complete it.',
    ariaLabel: 'Slider verification: press left/right arrow keys to move 5 pixels, Enter to submit',
  },
  // Two-factor authentication (self-service binding)
  twoFactor: {
    sectionTitle: 'Two-factor authentication (2FA)',
    restrictedTitle: 'Security policy requires binding 2FA first',
    restrictedHint:
      'Until binding is complete, the rest of the console is unavailable (only this page and sign-out are allowed).',
    missingCsrfTitle: 'This session has no write token, so binding cannot proceed',
    missingCsrfHint:
      'In the restricted state the server does not return a CSRF token (it is lost on page refresh), so sign in again and bind immediately on this page.',
    relogin: 'Sign in again',
    setupUnavailable: 'Could not fetch a key. Please retry.',
    setupFailedRetry: 'Fetch a new key',
    scanHint:
      'Scan the QR code with an authenticator app (Google Authenticator, 1Password, …); if you cannot scan, type the key below manually.',
    manualSecret: 'Manual key (Base32)',
    secretOnce: 'The key and QR code are shown once and never again after binding succeeds.',
    codeLabel: '6-digit code from the authenticator',
    missingCode: 'Please enter the 6-digit code.',
    enable: 'Complete binding',
    reissue: 'Use a different key',
    alreadyBound: 'This account already has 2FA bound. To re-bind, sign in with a recovery code or ask an administrator to reset it.',
    invalidCodeResent: 'Incorrect code; a new key has been generated — please scan it again and retry.',
    boundTitle: '2FA is bound',
    boundHint:
      'Sign-in requires the 6-digit code from your authenticator. If the device is lost, use a recovery code or ask an administrator to reset 2FA.',
    recoveryTitle: 'Save these 10 recovery codes now',
    recoveryHint:
      'Each recovery code works only once; you cannot view them again after leaving this page (they are your way back in if the device is lost).',
    recoveryCount: 'Remaining: {count}',
    recoveryAcknowledge: 'I have saved them',
    copy: 'Copy',
    copyAll: 'Copy all',
    copied: 'Copied',
    copyFailed: 'Copy failed; please select the text and copy manually.',
    qrAlt: '2FA binding QR code',
  },
  view: {
    publicStatus: {
      title: 'Public status',
      hint: 'Read-only, no sign-in: current snapshot, probe overview and summary counts.',
    },
    login: {
      title: 'Sign in',
      hint: 'Password plus second factor (recovery code supported) in a single route.',
      username: 'Username',
      password: 'Password',
      submit: 'Sign in',
      totp: 'Verification code',
      totpHint: 'Enter the 6-digit code from your authenticator app.',
      verify: 'Verify',
      recovery: 'Recovery code',
      recoveryHint: 'Enter an unused recovery code (single use).',
      useRecovery: 'Use a recovery code',
      usePassword: 'Back to password sign-in',
      missingCredentials: 'Please fill in username and password.',
      missingTotp: 'Please enter the 6-digit verification code.',
      missingRecovery: 'Please enter a recovery code.',
      recoveryLow: 'Recovery codes are almost used up ({count} left); regenerate them on the My account page.',
      captchaFallback:
        'If you cannot complete the human verification, wait a few minutes and retry (the failure counter resets when the window expires), or ask an administrator to reset 2FA.',
      rateLimited: 'Retry in {seconds}s',
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
    account: {
      title: 'My account',
      hint: 'Self-service: two-factor authentication (bind / unbind / recovery codes); sessions and SSO binding status will live here too.',
      pending: 'Sessions and SSO binding status will land here in a later increment.',
    },
    settings: {
      title: 'Settings',
      hint: 'Requires sign-in (admin): agents, accounts and permissions, system settings, public view.',
      accountLink: 'Manage two-factor authentication on the My account page',
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
    // Human verification (docs/api.md §1.3 / self-built §5.4 / GeeTest §6.2)
    captcha_required: 'Complete the human verification first.',
    captcha_invalid: 'Human verification failed; please try again.',
    // ⚠️ Only when GeeTest is unreachable and failMode=closed (the default is open): 5xx messages are
    //    collapsed into generic copy by the server, so the frontend MUST match on error.code.
    captcha_unavailable: 'Human verification is temporarily unavailable; retry later or contact an administrator.',
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
