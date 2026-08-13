import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from './store';

/**
 * 单个记忆条目的健康检查问题。
 */
export interface ValidationIssue {
    /** 问题类型，用于调用方分类展示或处理。 */
    kind: 'stale_path' | 'never_used' | 'duplicate_name';

    /** 面向用户的中文诊断信息。 */
    message: string;
}

/**
 * 单条记忆的完整校验报告，只在存在问题时生成。
 */
export interface ValidationReport {
    /** 被校验的记忆条目。 */
    entry: MemoryEntry;

    /** 该记忆命中的全部健康检查问题。 */
    issues: ValidationIssue[];
}

const PATH_RE = /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g;

/**
 * 从记忆正文中提取看起来像项目文件路径的引用。
 *
 * @param content 记忆正文内容。
 * @returns 去重后的路径引用列表。
 */
export function extractPaths(content: string): string[] {
    const paths = new Set<string>();
    for (const match of content.matchAll(PATH_RE)) {
        paths.add(match[1]);
    }
    return Array.from(paths);
}

// 不同类型的记忆有不同的"保质期"
const TTL_BY_TYPE: Record<string, number> = {
    user: 365, // 用户偏好几乎不过期
    feedback: 90, // 纠正反馈保留 3 个月
    project: 30, // 项目决策变化快，1 个月
    reference: 14, // 外部资源引用需要频繁刷新
};

/**
 * 校验单条记忆是否存在失效路径或长期未读取的问题。
 *
 * @param entry 待校验的记忆条目。
 * @param baseDir 相对路径解析所使用的项目根目录。
 * @returns 该记忆命中的问题列表。
 */
export function validateEntry(entry: MemoryEntry, baseDir = '.'): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    const paths = extractPaths(entry.content);
    for (const p of paths) {
        const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
        if (!fs.existsSync(abs)) {
            issues.push({
                kind: 'stale_path',
                message: `引用的路径不存在：${p}`,
            });
        }
    }

    if (entry.lastReadAt) {
        const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
        const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24);
        if (days > staleDays) {
            issues.push({
                kind: 'never_used',
                message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
            });
        }
    }

    return issues;
}

/**
 * 批量校验记忆库，并额外检测同名记忆。
 *
 * @param entries 待校验的记忆条目列表。
 * @param baseDir 相对路径解析所使用的项目根目录。
 * @returns 仅包含异常条目的校验报告列表。
 */
export function lintAll(entries: MemoryEntry[], baseDir = '.'): ValidationReport[] {
    const reports: ValidationReport[] = [];

    const nameCount = new Map<string, number>();
    for (const e of entries) {
        nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
    }

    for (const entry of entries) {
        const issues = validateEntry(entry, baseDir);
        if ((nameCount.get(entry.name) || 0) > 1) {
            issues.push({
                kind: 'duplicate_name',
                message: `存在 ${nameCount.get(entry.name)} 条同名记忆，可能需要合并`,
            });
        }
        if (issues.length > 0) reports.push({ entry, issues });
    }

    return reports;
}
