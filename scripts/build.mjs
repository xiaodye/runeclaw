import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

/**
 * 用 esbuild 把 src/index.ts 打包成单个 ESM 文件 dist/index.js。
 *
 * - 第三方依赖（含原生模块）保持 external，运行时从 node_modules 解析；
 * - 内部模块（含动态 import）由 esbuild 内联进产物，顺带解决源码里的无扩展名导入；
 * - 产物头部注入 node shebang，并设置可执行位，供 bin 直接调用。
 */
async function main() {
    mkdirSync('dist', { recursive: true });

    const result = await build({
        entryPoints: ['src/index.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile: 'dist/index.js',
        banner: { js: '#!/usr/bin/env node' },
        packages: 'external',
        logLevel: 'info',
    });

    if (result.errors.length > 0) {
        console.error('✗ 打包失败');
        process.exit(1);
    }

    chmodSync('dist/index.js', 0o755);
    console.log('✓ dist/index.js 已生成');
}

void main();
