export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

interface ClassifyResult {
    /** 命令风险等级，用于决定是否允许、提示或拦截。 */
    level: RiskLevel;
    /** 命中风险规则时的人类可读原因。 */
    reason?: string;
}

const DANGEROUS_PATTERNS: Array<{
    /** 用于匹配危险命令形态的正则。 */
    pattern: RegExp;
    /** 命中该规则时返回的风险原因。 */
    reason: string;
}> = [
    { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/, reason: '强制删除文件' },
    { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
    { pattern: /\bsudo\b/, reason: '提权操作' },
    { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
    { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写设备' },
    { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
    { pattern: />\s*\/dev\/sd[a-z]/, reason: '覆写磁盘设备' },
    { pattern: /\bchmod\s+777\b/, reason: '开放所有权限' },
    { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
    { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
    { pattern: /\beval\b/, reason: 'eval 动态执行' },
    { pattern: />\s*\/etc\//, reason: '覆写系统配置' },
];

const MODERATE_PATTERNS: Array<{
    /** 用于匹配中等风险命令形态的正则。 */
    pattern: RegExp;
    /** 命中该规则时返回的风险原因。 */
    reason: string;
}> = [
    { pattern: /\brm\b/, reason: '删除文件' },
    { pattern: /\bmv\b/, reason: '移动/重命名文件' },
    { pattern: /\bchmod\b/, reason: '修改权限' },
    { pattern: /\bchown\b/, reason: '修改所有者' },
    { pattern: /\bkill\b/, reason: '终止进程' },
    { pattern: /\bpkill\b/, reason: '批量终止进程' },
    { pattern: /\bgit\s+push\b/, reason: 'Git 推送' },
    { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 硬重置' },
    { pattern: /\bnpm\s+publish\b/, reason: '发布 npm 包' },
    { pattern: /\bdocker\s+rm\b/, reason: '删除容器' },
];

/**
 * 根据静态规则识别 bash 命令的危险程度。
 *
 * @param command 待分类的原始命令字符串。
 * @returns
 */
export function classifyBashCommand(command: string): ClassifyResult {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
            return { level: 'dangerous', reason };
        }
    }

    for (const { pattern, reason } of MODERATE_PATTERNS) {
        if (pattern.test(command)) {
            return { level: 'moderate', reason };
        }
    }

    return { level: 'safe' };
}
