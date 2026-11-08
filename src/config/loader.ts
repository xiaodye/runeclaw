import fs from 'node:fs';
import { SuperAgentConfigSchema, type SuperAgentConfig } from './schema';

import { CONFIG_FILE, ensureUserDir, resolveUserPath } from './paths';

export { CONFIG_FILE } from './paths';

/**
 * 加载用户配置与密钥，将数据路径解析到用户目录。
 * @param path 配置文件路径，默认使用用户级配置。
 * @returns
 */
export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
    ensureUserDir();
    if (!fs.existsSync(path)) {
        console.log(`  未找到 ${path}，使用默认配置`);
        console.log('  运行 pnpm run init 生成配置文件\n');
        return resolveDataPaths(SuperAgentConfigSchema.parse({}));
    }

    fs.chmodSync(path, 0o600);

    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch (err) {
        console.error(`  ✗ 解析 ${path} 失败: ${(err as Error).message}`);
        process.exit(1);
    }

    const result = SuperAgentConfigSchema.safeParse(raw);
    if (!result.success) {
        console.error('  ✗ 配置文件校验失败:');
        for (const issue of result.error.issues) {
            console.error(`    ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
    }

    console.log(`  ✓ 已加载 ${path}`);
    return resolveDataPaths(result.data);
}

/**
 * 统一解析持久化路径，工作目录仅用于任务的文件与 Shell 操作。
 * @param config 校验后的配置。
 * @returns
 */
function resolveDataPaths(config: SuperAgentConfig): SuperAgentConfig {
    config.memory.dataDir = resolveUserPath(config.memory.dataDir);
    config.cron.dataDir = resolveUserPath(config.cron.dataDir);
    config.usage.trackingFile = resolveUserPath(config.usage.trackingFile);
    return config;
}
