import 'dotenv/config';
import process from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';
import fs from 'node:fs';

import { createInterface } from 'node:readline';
import { allTools } from './tools';
import { agentLoop } from './agent/loop';
import { ToolDefinition, ToolRegistry } from './tools/registry';
import { createMockModel, setCacheEnabled } from './mock-model';
import { MCPClient, MockMCPClient } from './tools/mcp-client';
import { SessionStore } from './session/store';
import {
    coreRules,
    deferredTools,
    PromptBuilder,
    PromptContext,
    sessionContext,
    toolGuide,
} from './context/prompt-builder';
import { estimateMessageTokens } from './context/defense';
import { buildContextSnapshot, renderContextView, renderUsageView } from './context/view';
import { UsageTracker } from './usage/tracker';
import { ModelMessage } from 'ai';
import { CommandContext, createDispatcher } from './commands';
import { createMemoryTool } from './tools/memory-tools';
import { MemoryStore } from './memory/store';
import { contextCommands } from './commands/context';
import { debugCommands } from './commands/debug';
import { memoryCommands } from './commands/memory';
import { createToolSearchTool } from './tools/tool-search';
import { memoryContext, ragContext } from './context/prompt-pipes';
import { chunkDocument } from './rag/chunker';
import { createDashScopeEmbedder, createMockEmbedder, embed } from './rag/embedder';
import { VectorStore } from './rag/store';
import { SqliteVectorStore } from './rag/sqlite-store';
import { createRagTools } from './tools/rag-tools';
import { ragCommands } from './commands/rag';
import { dreamCommands } from './commands/dream';
import { SkillLoader } from './skills/loader';
import { createSkillCommands } from './commands/skill';
import { PluginManager } from './plugins/manager';
import { PluginDefinition } from './plugins/types';
import { createPluginCommands } from './commands/plugin';
import { supabasePlugin } from './plugins/supabase-plugin';
import { ChannelGateway } from './channels/gateway';
import { FeishuChannel } from './channels/feishu';
import { createChannelCommands } from './commands/channel';
import { HookPipeline } from './security/hooks';
import { createSecurityCommands } from './commands/security';
import { CronService } from './cron/service';
import { createCronTool } from './tools/cron-tools';
import { createCronCommands } from './commands/cron';
import { SubAgentRegistry } from './agents/registry';
import { SpawnContext } from './agents/spawn';
import { createSpawnTool } from './tools/spawn-tools';
import { createAgentCommands } from './commands/agents';
import { loadConfig } from './config/loader';
import { c } from './ui/theme';
import boxen from 'boxen';

// ── 加载配置 ────────────────────────────────
const config = loadConfig();

const provider = createOpenAI({
    baseURL: config.model.baseURL,
    apiKey: config.model.apiKey,
});

const model = provider.chat(config.model.name ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

// ── Registry ────────────────────────────────────────
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

// ── Memory ────────────────────────────────────────
const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// ── RAG ────────────────────────────────────────
// const vectorStore = new VectorStore();

// sqlite 数据库
const vectorStore = new SqliteVectorStore('knowledge.db');
const embedFn = config.rag.embeddingKey
    ? createDashScopeEmbedder(config.rag.embeddingKey)
    : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

async function connectMCP() {
    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ── Skills ────────────────────────────────────────
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ── Plugins ────────────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([['supabase', supabasePlugin]]);

// ── Security: Hook Pipeline ────────────────────────────────────────
const hookPipeline = new HookPipeline();

hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
        const path = (input as any)?.path || 'unknown';
        console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
    }
    return { action: 'allow' };
});

hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
        const timestamp = new Date().toISOString();
        return {
            action: 'modify',
            modifiedOutput: `[${timestamp}]\n${output}`,
        };
    }
    return { action: 'allow' };
});

registry.setHookPipeline(hookPipeline);

// ── Cron Service ────────────────────────────────────────
const cronService = new CronService(config.cron.dataDir);
registry.register(createCronTool(cronService));

// ── Sub-Agent ────────────────────────────────────────
const agentRegistry = new SubAgentRegistry({
    maxSpawnDepth: config.agents.maxSpawnDepth,
    maxConcurrent: config.agents.maxConcurrent,
});

function getSpawnCtx(): SpawnContext {
    return {
        model,
        registry,
        agentRegistry,
        buildSystem: () => builder.build(makePromptCtx()),
        currentDepth: 0,
    };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

// ── Prompt Builder ────────────────────────────────────────
const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext());

// ── Channel Gateway ────────────────────────────────────────
const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem: () => builder.build(makePromptCtx()),
});

const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
const feishuChannel = new FeishuChannel({
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    port: FEISHU_PORT,
});
gateway.register(feishuChannel);

// ── Commands ────────────────────────────────────────
const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...ragCommands,
    ...dreamCommands,
    ...createSkillCommands(skillLoader, activeSkills),
    ...createPluginCommands(pluginManager, availablePlugins),
    ...createChannelCommands(gateway),
    ...createSecurityCommands(registry, hookPipeline),
    ...createCronCommands(cronService),
    ...createAgentCommands(agentRegistry),
]);

function makePromptCtx(): PromptContext {
    return {
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: registry.getDeferredToolSummary(),
        sessionMessageCount: 0,
        sessionId: config.session.id,
    };
}

export async function startAgent() {
    // 启动阶段静默普通日志（插件/Channel/MCP/飞书），只保留 error/warn
    const restoreConsole = (() => {
        const originalLog = console.log;
        const originalInfo = console.info;
        console.log = () => {};
        console.info = () => {};
        return () => {
            console.log = originalLog;
            console.info = originalInfo;
        };
    })();

    // MCP 加载
    await connectMCP();

    // 加载插件
    console.log('  加载插件...');
    for (const [name, def] of availablePlugins) {
        try {
            const tools = await pluginManager.load(def);
            console.log(`  ✓ ${name} — ${tools.length} 个工具`);
        } catch {
            console.error(`  ✗ ${name} — 加载失败`);
        }
    }

    // 启动 Channel
    console.log('  启动 Channel...');
    await gateway.startAll();

    // 启动 Cron
    cronService.load();
    cronService.setExecutor({
        runAgentPrompt: async (prompt, timeout) => {
            const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
            const system = builder.build(makePromptCtx());
            await agentLoop(model, registry, cronMessages, system);
            const lastMsg = cronMessages[cronMessages.length - 1];
            if (!lastMsg) return '(无输出)';
            if (typeof lastMsg.content === 'string') return lastMsg.content;
            if (Array.isArray(lastMsg.content)) {
                return (
                    lastMsg.content
                        .filter((p: any) => p.type === 'text')
                        .map((p: any) => p.text)
                        .join('') || '(无输出)'
                );
            }
            return String(lastMsg.content);
        },
        notify: (message) => {
            console.log(`\n${message}`);
        },
    });
    cronService.start();
    const cronJobs = cronService.list();

    // 启动完成，恢复 console 输出（开屏盒子与后续对话正常显示）
    restoreConsole();

    const store = new SessionStore('default');
    let messages: ModelMessage[] = [];
    const timestamps = new Map<number, number>();
    const tracker = new UsageTracker('.usage/today.jsonl');

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function ask() {
        rl.question(`\n${c.cyan}❯${c.reset} `, async (input) => {
            const trimmed = input.trim();
            if (trimmed === '/exit') {
                console.log('Bye!');
                cronService.stop();
                await gateway.stopAll();
                await pluginManager.unloadAll();
                rl.close();
                // 强制退出：即使仍有 feishu/MCP/插件等句柄挂着事件循环，也要释放终端
                process.exit(0);
            }
            if (!trimmed) {
                ask();
                return;
            }

            const ctx: CommandContext = {
                messages,
                timestamps,
                registry,
                builder,
                tracker,
                sessionStore: store,
                model,
                makePromptCtx,
                ask,
                memoryStore,
                vectorStore,
            };
            const handled = dispatch(trimmed, ctx);
            if (handled === 'async') return;
            if (handled) {
                ask();
                return;
            }

            const userMsg: ModelMessage = { role: 'user', content: trimmed };
            messages.push(userMsg);
            timestamps.set(messages.length - 1, Date.now());
            store.append(userMsg);

            const currentSystem = builder.build(makePromptCtx());
            const beforeLen = messages.length;
            await agentLoop(model, registry, messages, currentSystem, tracker);

            const newMessages = messages.slice(beforeLen);
            const now = Date.now();
            for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
            store.appendAll(newMessages);

            console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
            ask();
        });
    }

    const role = registry.getRole();
    const toolCount = registry.getActiveTools().length;
    const hooks = hookPipeline.list();
    const modelName = (model as any)?.modelId || config.model.name || 'unknown';

    const splash = boxen(
        [
            `  ${c.cyan}model:${c.reset}     ${c.bold}${modelName}${c.reset}`,
            `  ${c.cyan}directory:${c.reset} ${c.bold}${process.cwd()}${c.reset}`,
            `  ${c.cyan}role:${c.reset}      ${c.yellow}${role}${c.reset} · 可用工具: ${c.green}${toolCount}${c.reset} 个`,
            '',
            `  ${c.dim}Sub-Agent 深度 ${agentRegistry.getConfig().maxSpawnDepth} / 并发 ${agentRegistry.getConfig().maxConcurrent} · /exit 退出 · /help 命令${c.reset}`,
        ].join('\n'),
        {
            title: 'RuneClaw',
            titleAlignment: 'left',
            borderStyle: 'round',
            borderColor: 'cyan',
            padding: 1,
        },
    );
    console.log(splash);
    console.log(
        `${c.green}✓ 就绪${c.reset} · ${toolCount} 个工具 · ${availablePlugins.size} 个插件已加载`,
    );
    console.log('');

    // RAG 知识库：仅在显式传入 --rag 时才自动导入 docs/ 下的文档
    const enableRag = process.argv.includes('--rag');
    if (enableRag && fs.existsSync('docs')) {
        const files = fs.readdirSync('docs').filter((f) => f.endsWith('.md'));
        if (files.length > 0) {
            console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
            for (const f of files) {
                const path = `docs/${f}`;
                const text = fs.readFileSync(path, 'utf-8');
                const chunks = chunkDocument(path, text);
                const embeddings = await embed(
                    embedFn,
                    chunks.map((c) => c.text),
                );
                vectorStore.addBatch(
                    chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })),
                );
            }
            console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
        }
    } else if (fs.existsSync('docs')) {
        console.log('  提示: 检测到 docs/ 目录，加 --rag 参数可自动导入知识库\n');
    }

    ask();
}
