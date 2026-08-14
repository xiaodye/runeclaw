import fs from 'node:fs';
import path from 'node:path';

export interface SkillDefinition {
    /** skill 的唯一名称，通常来自目录名。 */
    name: string;
    /** skill 的简短能力描述，来自 frontmatter。 */
    description: string;
    /** 可选适用场景提示，来自 frontmatter 的 when_to_use。 */
    whenToUse?: string;
    /** 去除 frontmatter 后的完整 skill 指令正文。 */
    content: string;
    /** skill 所在目录路径，用于解析相对资源。 */
    dirPath: string;
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
    /** 项目根目录，`.skills` 会在该目录下查找。 */
    private readonly baseDir: string;
    /** 已加载 skill 表，以 skill 名称索引。 */
    private skills = new Map<string, SkillDefinition>();

    /**
     * 创建 skill 加载器。
     *
     * @param baseDir `.skills` 目录所在的项目根路径。
     */
    constructor(baseDir = '.') {
        this.baseDir = baseDir;
    }

    /** 当前项目的 skill 根目录路径。 */
    private get skillsDir(): string {
        return path.join(this.baseDir, SKILLS_DIR);
    }

    /**
     * 扫描 `.skills` 目录并加载带有 `SKILL.md` 的 skill。
     *
     * @returns
     */
    load(): SkillDefinition[] {
        this.skills.clear();
        if (!fs.existsSync(this.skillsDir)) return [];

        const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(this.skillsDir, entry.name, SKILL_FILE);
            if (!fs.existsSync(skillFile)) continue;

            const raw = fs.readFileSync(skillFile, 'utf-8');
            const parsed = this.parseFrontmatter(raw);
            if (!parsed) continue;

            const skill: SkillDefinition = {
                name: entry.name,
                description: parsed.description,
                whenToUse: parsed.whenToUse,
                content: parsed.content,
                dirPath: path.join(this.skillsDir, entry.name),
            };
            this.skills.set(skill.name, skill);
        }

        return this.list();
    }

    /**
     * 返回当前已加载的 skill 定义列表。
     *
     * @returns
     */
    list(): SkillDefinition[] {
        return Array.from(this.skills.values());
    }

    /**
     * 按名称查找已加载 skill。
     *
     * @param name skill 名称。
     * @returns
     */
    get(name: string): SkillDefinition | undefined {
        return this.skills.get(name);
    }

    /**
     * 构建注入系统 prompt 的 skill 说明区块。
     *
     * @param activeSkills 当前已激活的 skill 名称集合。
     * @returns
     */
    buildPromptSection(activeSkills: Set<string>): string | null {
        if (this.skills.size === 0) return null;

        const lines: string[] = [];

        if (activeSkills.size > 0) {
            for (const name of activeSkills) {
                const skill = this.skills.get(name);
                if (!skill) continue;
                lines.push(`[激活的 Skill: ${skill.name}]`);
                lines.push(skill.content);
                lines.push('');
            }
        }

        const available = this.list()
            .filter((s) => !activeSkills.has(s.name))
            .map((s) => {
                const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
                return `  /${s.name} — ${s.description}${hint}`;
            });

        if (available.length > 0) {
            lines.push('可用的 Skills（输入 /skill load <name> 激活）：');
            lines.push(...available);
        }

        return lines.length > 0 ? lines.join('\n') : null;
    }

    /**
     * 解析 `SKILL.md` frontmatter，并返回正文与元信息。
     *
     * @param raw 原始 Markdown 文件内容。
     * @returns
     */
    private parseFrontmatter(
        raw: string,
    ): {
        /** skill 描述，缺省为空字符串。 */
        description: string;
        /** 可选适用场景提示。 */
        whenToUse?: string;
        /** 去除 frontmatter 后的正文内容。 */
        content: string;
    } | null {
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return { description: '', content: raw };

        const meta: Record<string, string> = {};
        for (const line of match[1].split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) {
                const key = line.slice(0, idx).trim();
                let value = line.slice(idx + 1).trim();
                if (
                    (value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))
                ) {
                    value = value.slice(1, -1);
                }
                meta[key] = value;
            }
        }

        return {
            description: meta.description || '',
            whenToUse: meta.when_to_use || undefined,
            content: match[2].trim(),
        };
    }
}
