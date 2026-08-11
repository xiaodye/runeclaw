import fs from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { CONFIG_FILE } from './loader';
import { SuperAgentConfig } from './schema';

/**
 * 读取一条带默认值的终端输入，空输入会回落到默认值。
 *
 * @param rl 当前交互式 readline 实例。
 * @param question 提示语。
 * @param defaultValue 空输入时使用的默认值。
 * @returns
 */
function askQuestion(rl: Interface, question: string, defaultValue = ''): Promise<string> {
    return new Promise((resolve) => {
        const prompt = defaultValue ? `${question} [${defaultValue}]: ` : question;
        console.log(prompt);
        rl.question('  > ', (answer) => resolve(answer.trim() || defaultValue));
    });
}

/**
 * 选择 DeepSeek 的默认模型或自定义模型名。
 *
 * @param rl 当前交互式 readline 实例。
 * @returns
 */
async function selectModelName(rl: Interface): Promise<string> {
    console.log('  选择模型:\n');
    console.log('    1. deepseek-v4-flash  (推荐，均衡)');
    console.log('    2. deepseek-v4-pro    (更强)');
    console.log('    3. 自定义模型名称\n');

    const choice = (await askQuestion(rl, '  模型', '1')) || '1';
    if (choice === '3') {
        return askQuestion(rl, '  自定义模型名称', 'deepseek-v4-flash');
    }
    if (choice === '2') return 'deepseek-v4-pro';
    return 'deepseek-v4-flash';
}

/**
 * 生成默认面向 DeepSeek 的配置文件，配置文件只保留环境变量占位符。
 *
 * @returns
 */
export async function runInit() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n  RuneClaw 初始化向导\n');

    if (fs.existsSync(CONFIG_FILE)) {
        const overwrite = await askQuestion(rl, `  ${CONFIG_FILE} 已存在，覆盖? (y/N): `);
        if (overwrite.toLowerCase() !== 'y') {
            console.log('  已取消\n');
            rl.close();
            return;
        }
    }

    const modelName = await selectModelName(rl);
    const baseURL = await askQuestion(rl, '  API Base URL', 'https://api.deepseek.com');
    const apiKey = await askQuestion(rl, '\n  API Key (留空则从环境变量 LLM_API_KEY 读取): ');

    const enableFeishu =
        (await askQuestion(rl, '\n  启用飞书 Channel? (y/N): ')).toLowerCase() === 'y';
    let feishuAppId = '';
    let feishuAppSecret = '';
    if (enableFeishu) {
        feishuAppId = await askQuestion(rl, '  飞书 App ID: ');
        feishuAppSecret = await askQuestion(rl, '  飞书 App Secret: ');
    }

    const concurrentStr = await askQuestion(rl, '\n  子 Agent 最大并发数', '3');
    const maxConcurrent = parseInt(concurrentStr, 10) || 3;

    const config: SuperAgentConfig = {
        version: '1.0',
        model: {
            provider: 'custom',
            name: '${LLM_MODEL}',
            baseURL: '${LLM_API_BASE}',
            apiKey: '${LLM_API_KEY}',
        },
        plugins: [{ name: 'supabase', enabled: false, config: {} }],
        channels: {
            feishu: {
                enabled: enableFeishu,
                appId: '${FEISHU_APP_ID}',
                appSecret: '${FEISHU_APP_SECRET}',
                port: 3000,
            },
        },
        agents: { maxSpawnDepth: 1, maxConcurrent, defaultTimeout: 60000 },
        security: { defaultRole: 'developer', auditLog: true, bashTimestamp: true },
        memory: { dataDir: '.' },
        rag: {
            enabled: true,
            docsDir: 'docs',
            embeddingKey: '${DASHSCOPE_API_KEY}',
        },
        cron: { enabled: true, dataDir: '.' },
        session: { id: 'default' },
        usage: { trackingFile: '.usage/today.jsonl' },
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
    console.log(`\n  ✓ ${CONFIG_FILE} 已生成`);

    const envLines: string[] = [];
    envLines.push(`LLM_MODEL=${modelName}\n`);
    envLines.push(`LLM_API_BASE=${baseURL}\n`);
    envLines.push(`LLM_API_KEY=${apiKey}\n`);
    if (enableFeishu && feishuAppId) {
        envLines.push(`FEISHU_APP_ID=${feishuAppId}\n`);
        envLines.push(`FEISHU_APP_SECRET=${feishuAppSecret}\n`);
    }
    if (envLines.length > 0) {
        fs.writeFileSync('.env', envLines.join('\n') + '\n');
        console.log('  ✓ .env 已生成');
    }

    console.log('\n  启动 Agent: pnpm start\n');
    rl.close();
}
