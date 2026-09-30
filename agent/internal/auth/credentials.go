package auth

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

// 凭证前缀（与中心创建 Agent 时的生成规则一致，见 docs/database.md §5.2）。
const (
	KeyPrefix    = "vk_"
	SecretPrefix = "vs_"
)

// Credentials 本机凭证。
//
// ⛔ 这两样只在内存里流转：不进日志、不进 User-Agent、不进任何 URL。
//   - Key 用于 `X-Agent-Key`（身份校验）；
//   - Secret **只用于算 HMAC，绝不上行**（中心侧以密文 `agent_secret_enc` 存储，因为验签需要重算）。
type Credentials struct {
	Key    string
	Secret []byte
	// Warnings 非致命问题（例如非 Linux 上无法检查文件权限），由调用方在启动时打出来。
	Warnings []string
}

// LoadCredentials 从两个受限文件加载凭证，并做三道检查。
//
// 三道检查都是为了挡住**同一类事故**：凭证配错时，Agent 会一直收到 401，
// 而日志里只有"签名不匹配"这种看不出根因的信息。所以宁可在这里说得非常具体：
//
//  1. 文件存在且是普通文件；
//  2. 权限必须是 0600（非 Linux 平台没有 POSIX 权限位，只能给出警告）；
//  3. **前缀必须对得上**（key 是 `vk_`、secret 是 `vs_`）—— 这条专门拦住
//     "把两个文件写反了"这个极其常见、又完全静默的运维错误。
func LoadCredentials(keyPath, secretPath string) (*Credentials, error) {
	keyRaw, err := readRestrictedFile(keyPath, "agent.key_file")
	if err != nil {
		return nil, err
	}
	secretRaw, err := readRestrictedFile(secretPath, "agent.secret_file")
	if err != nil {
		return nil, err
	}

	key := strings.TrimSpace(string(keyRaw))
	secret := strings.TrimSpace(string(secretRaw))

	var problems []string
	if key == "" {
		problems = append(problems, fmt.Sprintf("%s 是空文件", keyPath))
	}
	if secret == "" {
		problems = append(problems, fmt.Sprintf("%s 是空文件", secretPath))
	}
	if key != "" && !strings.HasPrefix(key, KeyPrefix) {
		if strings.HasPrefix(key, SecretPrefix) {
			problems = append(problems, fmt.Sprintf(
				"%s 里是 **secret**（以 %s 开头），而这里要的是 key（应以 %s 开头）——"+
					"请把 agent.key_file 与 agent.secret_file 两个配置对调过来", keyPath, SecretPrefix, KeyPrefix))
		} else {
			problems = append(problems, fmt.Sprintf(
				"%s 的内容不像 key：应以 %q 开头（当前前几个字符是 %q）", keyPath, KeyPrefix, preview(key)))
		}
	}
	if secret != "" && !strings.HasPrefix(secret, SecretPrefix) {
		if strings.HasPrefix(secret, KeyPrefix) {
			problems = append(problems, fmt.Sprintf(
				"%s 里是 **key**（以 %s 开头），而这里要的是 secret（应以 %s 开头）——"+
					"请把 agent.key_file 与 agent.secret_file 两个配置对调过来", secretPath, KeyPrefix, SecretPrefix))
		} else {
			problems = append(problems, fmt.Sprintf(
				"%s 的内容不像 secret：应以 %q 开头（当前前几个字符是 %q）", secretPath, SecretPrefix, preview(secret)))
		}
	}
	if !isPrintableASCII(key) || !isPrintableASCII(secret) {
		problems = append(problems, "凭证里含不可打印字符：多半是复制粘贴时带进了换行以外的内容（如 BOM 或全角字符）")
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("凭证校验未通过：\n  - %s", strings.Join(problems, "\n  - "))
	}

	// ⚠️ Secret 保留文件里的原始字节（只去掉首尾空白）：签名必须与中心存储的那份逐字节一致，
	//    顺手在中间做任何"清洗"都会让签名对不上，而且极难排查。
	return &Credentials{Key: key, Secret: []byte(secret)}, nil
}

// preview 只回显前 3 个字符 —— 够用来判断"是不是配错了"，又不至于把凭证写进日志。
func preview(s string) string {
	if len(s) <= 3 {
		return strings.Repeat("*", len(s))
	}
	return s[:3] + "..."
}

func isPrintableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// readRestrictedFile 读一个凭证文件并校验权限。
func readRestrictedFile(path, configKey string) ([]byte, error) {
	if path == "" {
		return nil, fmt.Errorf("%s 未配置", configKey)
	}

	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s 指向的文件不存在：%s（提示：面板创建 Agent 时会给出凭证内容，需自行落成受限文件）", configKey, path)
		}
		return nil, fmt.Errorf("无法访问 %s（%s）：%w", configKey, path, err)
	}
	// ⛔ 拒绝非普通文件：`/dev/stdin`、命名管道、目录都会让"权限 0600"这道检查失去意义
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s 必须是普通文件（当前 %s）：%s", configKey, info.Mode().Type(), path)
	}

	if runtime.GOOS != "windows" {
		// 只要 o+rwx 或 g+rwx 里任何一位被置上就拒绝。
		// 用 Perm() 而不是 Mode()：后者还包含 setuid/sticky 等与读写无关的位。
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			return nil, fmt.Errorf(
				"%s 的权限是 %04o，必须收紧到 0600（同机其他用户能读到凭证就等于凭证泄露）：\n"+
					"    chmod 600 %s && chown <运行用户> %s",
				configKey, perm, path, path)
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 %s（%s）失败：%w", configKey, path, err)
	}
	return data, nil
}

// CheckFilePermissions 供配置热重载前做一次"体检"。
//
// 返回的是**问题列表**而不是错误：reload 时权限变松应当被拒绝并保留旧配置（由调用方决定），
// 但启动时的处理方式可能不同，所以这里只报告事实。
func CheckFilePermissions(paths map[string]string) []string {
	var out []string
	if runtime.GOOS == "windows" {
		return []string{"当前平台没有 POSIX 权限位，⛔ 无法校验凭证文件是否为 0600（生产部署在 Linux，那里会强制校验）"}
	}
	for configKey, path := range paths {
		if path == "" {
			continue
		}
		info, err := os.Lstat(path)
		if err != nil {
			out = append(out, fmt.Sprintf("%s 不可访问：%v", configKey, err))
			continue
		}
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			out = append(out, fmt.Sprintf("%s 的权限是 %04o，应为 0600（chmod 600 %s）", configKey, perm, path))
		}
	}
	return out
}
