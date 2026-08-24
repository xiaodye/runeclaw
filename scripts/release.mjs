#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/** 发布目标：官方 npm registry（镜像源只读，不能发布）。 */
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

/** 支持的命令行参数：patch / minor / major，缺省为 patch（补丁号 +1）。 */
const VERSION_TYPES = ['patch', 'minor', 'major'];

/** package.json 的绝对路径（脚本位于 scripts/ 下）。 */
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

/**
 * 按类型递增语义化版本号。
 *
 * @param current 当前版本号，形如 1.0.0。
 * @param type 递增类型：patch / minor / major。
 * @returns
 */
function bumpVersion(current, type) {
    const [major, minor, patch] = current.split('.').map(Number);
    switch (type) {
        case 'major':
            return `${major + 1}.0.0`;
        case 'minor':
            return `${major}.${minor + 1}.0`;
        case 'patch':
            return `${major}.${minor}.${patch + 1}`;
        default:
            throw new Error(`不支持的版本类型: ${type}（可选 patch / minor / major）`);
    }
}

/**
 * 一键发布：版本号 +1 → 用官方源发布（--registry 参数优先级最高，覆盖任何 .npmrc）。
 *
 * @returns
 */
function main() {
    const type = process.argv[2] ?? 'patch';
    if (!VERSION_TYPES.includes(type)) {
        throw new Error(`用法: node scripts/release.mjs [patch|minor|major]`);
    }

    // 1. 版本号 +1，写回 package.json
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf-8'));
    const oldVersion = pkg.version;
    pkg.version = bumpVersion(oldVersion, type);
    writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 4) + '\n');
    console.log(`✓ 版本 ${pkg.name} ${oldVersion} → ${pkg.version}`);

    // 2. 提示当前默认源；若是镜像则说明本次发布会自动走官方源（只读镜像无法发布）
    let currentRegistry = '';
    try {
        currentRegistry = execSync('npm config get registry', { encoding: 'utf-8' }).trim();
    } catch {
        // 读不到默认源不阻塞发布
    }
    if (currentRegistry && currentRegistry !== OFFICIAL_REGISTRY) {
        console.log(`✓ 默认源 ${currentRegistry} 是镜像，发布将切换到官方源 ${OFFICIAL_REGISTRY}`);
    }

    // 3. 发布；--registry 命令行参数优先级最高，覆盖 .npmrc 里的镜像配置；
    //    prepublishOnly 会自动执行 pnpm build
    console.log('\n发布中...');
    execSync(`npm publish --registry "${OFFICIAL_REGISTRY}"`, { stdio: 'inherit' });
    console.log(`\n✓ 已发布 ${pkg.name}@${pkg.version}`);
}

try {
    main();
} catch (error) {
    console.error(`\n✗ 发布失败: ${error.message}`);
    process.exit(1);
}
