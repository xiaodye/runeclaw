import fs from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { SuperAgentConfigSchema } from './schema';
import { USER_DIR, CONFIG_FILE, ensureUserDir } from './paths';

/**
 * 将旧环境变量占位符和服务密钥收拢到 JSON，未解析的占位符会阻止迁移。
 * @param config 旧配置对象。
 * @param envFile 旧版环境变量文件。
 * @returns
 */
function consolidateConfig(config: any, envFile: string): unknown {
    const env = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf-8')) : {};
    /** 递归解析旧配置，仅在迁移时使用旧环境文件。 */
    const resolve = (value: any): any => {
        if (typeof value === 'string')
            return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key: string) => {
                if (env[key] === undefined)
                    throw new Error(`旧配置引用 ${key}，但旧 .env 中没有对应值，请先补全后迁移。`);
                return env[key];
            });
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === 'object')
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, resolve(item)]),
            );
        return value;
    };
    const result = resolve(config);
    result.search = {
        tavilyApiKey: env.TAVILY_API_KEY || '',
        serperApiKey: env.SERPER_API_KEY || '',
        ...result.search,
    };
    result.channels ??= {};
    result.channels.feishu ??= {};
    for (const [key, oldKey] of [
        ['appId', 'FEISHU_APP_ID'],
        ['appSecret', 'FEISHU_APP_SECRET'],
    ] as const) {
        if (!result.channels.feishu[key] && env[oldKey]) result.channels.feishu[key] = env[oldKey];
    }
    if (env.FEISHU_PORT && result.channels.feishu.port === undefined)
        result.channels.feishu.port = Number(env.FEISHU_PORT);
    SuperAgentConfigSchema.parse(result);
    return result;
}

/** 显式复制当前目录的旧配置和运行数据，保留来源且不覆盖目标。 */
export function migrateLegacyConfig(): void {
    ensureUserDir();
    const userEnv = join(USER_DIR, '.env');
    if (fs.existsSync(CONFIG_FILE) && fs.existsSync(userEnv)) {
        const config = consolidateConfig(
            JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')),
            userEnv,
        );
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4) + '\n', { mode: 0o600 });
        fs.chmodSync(CONFIG_FILE, 0o600);
        console.log('已将用户目录的旧 .env 合并到 config.json；原 .env 已保留，请确认后删除。');
    }
    const files = [
        ['runeclaw.config.json', CONFIG_FILE],
        ['.sessions', join(USER_DIR, 'sessions')],
        ['.skills', join(USER_DIR, 'skills')],
        ['.memory', join(USER_DIR, 'memory')],
        ['.cron', join(USER_DIR, 'cron')],
        ['.usage', join(USER_DIR, 'usage')],
        ['knowledge.db', join(USER_DIR, 'knowledge.db')],
    ];
    if (fs.existsSync('knowledge.db-wal')) {
        throw new Error('检测到 knowledge.db-wal，请先停止旧进程并关闭数据库后迁移。');
    }
    for (const [source, target] of files) {
        if (!fs.existsSync(source)) continue;
        if (fs.existsSync(target)) {
            console.log(`跳过已有目标：${target}`);
            continue;
        }
        if (source === 'runeclaw.config.json') {
            const config = consolidateConfig(
                JSON.parse(fs.readFileSync(source, 'utf-8')),
                '.env',
            ) as any;
            if (config.usage?.trackingFile === '.usage/today.jsonl') {
                config.usage.trackingFile = 'usage/today.jsonl';
            }
            // 旧目录基准改为用户目录；不保留指向工作目录的存储设置。
            if (config.memory) config.memory.dataDir = '.';
            if (config.cron) config.cron.dataDir = '.';
            fs.writeFileSync(target, JSON.stringify(config, null, 4) + '\n', {
                flag: 'wx',
                mode: 0o600,
            });
        } else {
            fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
        }
        console.log(`已复制 ${source} → ${target}`);
    }
    console.log('迁移完成，原文件已保留。后续启动仅使用用户目录配置。');
}
