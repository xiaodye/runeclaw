import { readFileSync } from 'node:fs';
import process from 'node:process';

/** 帮助文本，列出所有子命令与全局选项。 */
const HELP_TEXT = `RuneClaw — 本地 AI Agent 运行时

用法:
  runeclaw [命令]

命令:
  init        运行初始化向导，生成 runeclaw.config.json 与 .env
  start       启动交互式 Agent（默认命令）
  continue    启动 Agent（与 start 等价，预留会话续接）
  help        显示本帮助
  version     显示版本号

选项:
  -h, --help       显示帮助
  -v, --version    显示版本号
  --rag            启动时自动导入 docs/ 下的文档到知识库
`;

/**
 * 从项目根目录的 package.json 读取版本号，读取失败时回落到占位值。
 *
 * @returns
 */
function readVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
            version?: string;
        };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * 打印帮助文本到 stdout。
 *
 * @returns
 */
function printHelp(): void {
    console.log(HELP_TEXT);
}

/**
 * 解析子命令并分发到对应模块。
 *
 * @returns
 */
async function main(): Promise<void> {
    const command = process.argv[2];

    switch (command) {
        case 'init': {
            const { runInit } = await import('./config/init');
            runInit();
            break;
        }
        case 'start':
        case 'continue':
        case '--continue':
        case '--rag':
        case undefined: {
            const { startAgent } = await import('./main');
            await startAgent().catch((error: unknown) => {
                console.error(error);
                process.exitCode = 1;
            });
            break;
        }
        case 'help':
        case '--help':
        case '-h':
            printHelp();
            break;
        case 'version':
        case '--version':
        case '-v':
            console.log(`runeclaw ${readVersion()}`);
            break;
        default:
            console.error(`未知命令: ${command}`);
            console.error('运行 runeclaw help 查看用法\n');
            process.exitCode = 1;
            break;
    }
}

void main();
