import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/** 用户配置与运行数据的统一根目录。 */
export const USER_DIR = join(homedir(), '.runeclaw');
/** 用户级配置文件路径。 */
export const CONFIG_FILE = join(USER_DIR, 'config.json');
/** 用户密钥文件路径，不读取当前工作目录的 .env。 */
export const ENV_FILE = join(USER_DIR, '.env');

/** 创建仅当前用户可访问的配置目录。 */
export function ensureUserDir(): void {
    mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
}

/**
 * 将运行数据路径解析为相对用户目录的绝对路径。
 * @param value 配置中的相对或绝对路径。
 * @returns
 */
export function resolveUserPath(value: string): string {
    return resolve(USER_DIR, value);
}
