import fs from 'node:fs';
import path from 'node:path';
import { bm25Search, type SearchHit } from './search';
import { lintAll, type ValidationReport } from './validator';

/**
 * 单条记忆的完整结构，包含索引展示信息、正文内容与读写时间。
 */
export interface MemoryEntry {
    /** 记忆名称，用于索引展示和同名检测。 */
    name: string;

    /** 记忆摘要，帮助模型在索引中快速判断是否需要读取正文。 */
    description: string;

    /** 记忆分类，决定校验时的保质期策略。 */
    type: 'user' | 'feedback' | 'project' | 'reference';

    /** 记忆正文，保存不能从代码或文档直接推导的信息。 */
    content: string;

    /** 记忆文件的实际路径，用于读取、删除和路径校验。 */
    filePath: string;

    /** 最近写入时间戳，单位为毫秒。 */
    lastWriteAt?: number;

    /** 最近读取时间戳，单位为毫秒。 */
    lastReadAt?: number;
}

const MEMORY_DIR = '.memory';
const INDEX_FILE = 'MEMORY.md';
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;
const STALE_DAYS = 30;

/**
 * 基于本地 Markdown 文件的记忆仓库，负责保存、索引、检索和健康检查。
 */
export class MemoryStore {
    /** 记忆目录所在的项目根路径。 */
    private readonly baseDir: string;

    /**
     * 创建记忆仓库实例，但不会立即写入文件系统。
     *
     * @param baseDir 记忆目录所在的项目根路径，默认使用当前目录。
     */
    constructor(baseDir: string = '.') {
        this.baseDir = baseDir;
    }

    /**
     * 返回记忆文件所在目录的绝对或相对路径。
     *
     * @returns
     */
    private get memoryDir(): string {
        return path.join(this.baseDir, MEMORY_DIR);
    }

    /**
     * 返回记忆索引文件路径。
     *
     * @returns
     */
    private get indexPath(): string {
        return path.join(this.memoryDir, INDEX_FILE);
    }

    /**
     * 初始化记忆目录和索引文件，缺失时会自动创建。
     */
    init(): void {
        if (!fs.existsSync(this.memoryDir)) {
            fs.mkdirSync(this.memoryDir, { recursive: true });
        }
        if (!fs.existsSync(this.indexPath)) {
            fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
        }
    }

    /**
     * 将一条新记忆写入 Markdown 文件，并同步更新索引。
     *
     * @param entry 待保存的记忆内容，不包含由仓库生成的路径和时间字段。
     * @returns 写入后的记忆文件名。
     */
    save(entry: Omit<MemoryEntry, 'filePath' | 'lastWriteAt' | 'lastReadAt'>): string {
        this.init();
        const slug = entry.name
            .toLowerCase()
            .replace(/[^a-z0-9一-鿿]+/g, '-')
            .replace(/^-|-$/g, '');
        const filename = `${entry.type}_${slug}.md`;
        const filePath = path.join(this.memoryDir, filename);
        const now = Date.now();

        const fileContent = [
            '---',
            `name: ${entry.name}`,
            `description: ${entry.description}`,
            `type: ${entry.type}`,
            `lastWriteAt: ${now}`,
            `lastReadAt: ${now}`,
            '---',
            '',
            entry.content,
        ].join('\n');

        fs.writeFileSync(filePath, fileContent, 'utf-8');
        this.updateIndex(entry.name, filename, entry.description);
        return filename;
    }

    /**
     * 新增或替换索引中的记忆条目，并在达到上限时淘汰最早记录。
     *
     * @param name 记忆名称。
     * @param filename 记忆文件名。
     * @param description 记忆摘要。
     */
    private updateIndex(name: string, filename: string, description: string): void {
        const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
        const lines = indexContent.split('\n');

        const existingIdx = lines.findIndex((l) => l.includes(`(${filename})`));
        const newLine = `- [${name}](${filename}) — ${description}`;

        if (existingIdx >= 0) {
            lines[existingIdx] = newLine;
        } else {
            if (lines.length >= MAX_INDEX_LINES) {
                console.log(`[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`);
                const firstEntry = lines.findIndex((l) => l.startsWith('- '));
                if (firstEntry >= 0) lines.splice(firstEntry, 1);
            }
            lines.push(newLine);
        }

        fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
    }

    /**
     * 读取记忆目录下所有有效条目，忽略无法解析的 Markdown 文件。
     *
     * @returns 有效记忆条目列表。
     */
    list(): MemoryEntry[] {
        this.init();
        const entries: MemoryEntry[] = [];
        const files = fs
            .readdirSync(this.memoryDir)
            .filter((f) => f.endsWith('.md') && f !== INDEX_FILE);

        for (const file of files) {
            const filePath = path.join(this.memoryDir, file);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = this.parseFrontmatter(raw);
            if (parsed) {
                entries.push({ ...parsed, filePath });
            }
        }
        return entries;
    }

    /**
     * 使用 BM25 在全部记忆中检索与查询最相关的条目。
     *
     * @param query 检索关键词或自然语言查询。
     * @param topK 返回结果数量上限。
     * @returns 按相关性降序排列的搜索结果。
     */
    search(query: string, topK = 5): SearchHit[] {
        return bm25Search(this.list(), query, topK);
    }

    /**
     * 读取记忆索引内容，并按文件展示上限截断。
     *
     * @returns 可注入 prompt 的索引文本。
     */
    loadIndex(): string {
        this.init();
        const raw = fs.readFileSync(this.indexPath, 'utf-8');
        return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
    }

    /**
     * 读取指定记忆文件内容，读取成功时会刷新 lastReadAt。
     *
     * @param filename 记忆文件名。
     * @returns 文件内容；文件不存在时返回 null。
     */
    loadFile(filename: string): string | null {
        const filePath = path.join(this.memoryDir, filename);
        if (!fs.existsSync(filePath)) return null;
        this.touchReadAt(filename);
        const raw = fs.readFileSync(filePath, 'utf-8');
        return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
    }

    /**
     * 更新记忆文件 frontmatter 中的最近读取时间。
     *
     * @param filename 记忆文件名。
     */
    private touchReadAt(filename: string): void {
        const filePath = path.join(this.memoryDir, filename);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const now = Date.now();
        let updated: string;
        if (/^lastReadAt:.*$/m.test(raw)) {
            updated = raw.replace(/^lastReadAt:.*$/m, `lastReadAt: ${now}`);
        } else {
            updated = raw.replace(/^---\n/, `---\nlastReadAt: ${now}\n`);
        }
        fs.writeFileSync(filePath, updated, 'utf-8');
    }

    /**
     * 删除指定记忆文件，并从索引中移除对应链接。
     *
     * @param filename 记忆文件名。
     * @returns 是否实际删除了文件。
     */
    delete(filename: string): boolean {
        const filePath = path.join(this.memoryDir, filename);
        if (!fs.existsSync(filePath)) return false;
        fs.unlinkSync(filePath);

        const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
        const lines = indexContent.split('\n').filter((l) => !l.includes(`(${filename})`));
        fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
        return true;
    }

    /**
     * 对当前记忆库执行健康检查，包含路径、过期和重复名称校验。
     *
     * @returns 存在问题的记忆校验报告。
     */
    lint(): ValidationReport[] {
        return lintAll(this.list(), this.baseDir);
    }

    /**
     * 构建注入系统 prompt 的记忆摘要区块，包含索引和使用原则。
     *
     * @returns 面向模型的记忆上下文文本。
     */
    buildPromptSection(): string {
        this.init();
        const index = this.loadIndex();
        const entries = this.list();

        if (entries.length === 0) {
            return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
        }

        const lines = [
            `[记忆系统] 共 ${entries.length} 条记忆`,
            '',
            '记忆索引：',
            index,
            '',
            '使用 memory 工具的 read 操作来读取具体记忆内容；用 search 做 BM25 搜索；用 lint 检查记忆库健康度。',
            '',
            '记忆使用原则：',
            '- 记忆是线索，不是事实——使用前先用工具验证（read_file、grep 确认路径和内容是否还存在）',
            '- 不存代码能推导的（技术栈、目录结构）、git 能查的（谁改了什么）、文档已经写了的',
            '- 只存对话中出现的、其他地方推导不出来的信息（用户偏好、纠正反馈、项目决策、外部资源）',
        ];
        return lines.join('\n');
    }

    /**
     * 从 Markdown frontmatter 中解析记忆元数据和正文。
     *
     * @param raw 原始 Markdown 文件内容。
     * @returns 解析后的记忆内容；格式无效时返回 null。
     */
    private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return null;

        const meta: Record<string, string> = {};
        for (const line of match[1].split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) {
                meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
        }

        const validTypes = ['user', 'feedback', 'project', 'reference'];
        if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null;

        return {
            name: meta.name,
            description: meta.description || '',
            type: meta.type as MemoryEntry['type'],
            content: match[2].trim(),
            lastWriteAt: meta.lastWriteAt ? Number(meta.lastWriteAt) : undefined,
            lastReadAt: meta.lastReadAt ? Number(meta.lastReadAt) : undefined,
        };
    }
}
