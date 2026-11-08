import fs from 'node:fs';
import { join } from 'node:path';
import { USER_DIR, CONFIG_FILE, ENV_FILE, ensureUserDir } from './paths';

/** 显式复制当前目录的旧配置和运行数据，保留来源且不覆盖目标。 */
export function migrateLegacyConfig(): void {
    ensureUserDir();
    const files = [
        ['runeclaw.config.json', CONFIG_FILE],
        ['.env', ENV_FILE],
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
            const config = JSON.parse(fs.readFileSync(source, 'utf-8'));
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
            if (source === '.env') fs.chmodSync(target, 0o600);
        }
        console.log(`已复制 ${source} → ${target}`);
    }
    console.log('迁移完成，原文件已保留。后续启动仅使用用户目录配置。');
}
