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
import { estimateTokens, microcompact, summarize } from './context/compressor';
import { estimateMessageTokens, applyDefense } from './context/defense';
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

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

const memoryStore = new MemoryStore('.');
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

const vectorStore = new VectorStore();
const embedFn = process.env.DASHSCOPE_API_KEY
    ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
    : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

async function connectMCP() {
    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([['supabase', supabasePlugin]]);

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
        return { action: 'modify', modifiedOutput: `[${timestamp}]\n${output}` };
    }
    return { action: 'allow' };
});

registry.setHookPipeline(hookPipeline);

// ── Cron Service ────────────────────────────────
const cronService = new CronService('.');
registry.register(createCronTool(cronService));

const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext());

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
]);

function makePromptCtx(): PromptContext {
    return {
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: registry.getDeferredToolSummary(),
        sessionMessageCount: 0,
        sessionId: 'default',
    };
}

async function main() {
    await connectMCP();
    console.log('  加载插件...');
    for (const [name, def] of availablePlugins) {
        try {
            const tools = await pluginManager.load(def);
            console.log(`  ✓ ${name} — ${tools.length} 个工具`);
        } catch {
            console.log(`  ✗ ${name} — 加载失败`);
        }
    }

    console.log('  启动 Channel...');
    await gateway.startAll();

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
    console.log(`  Cron: ${cronJobs.length} 个任务已加载`);

    const store = new SessionStore('default');
    let messages: ModelMessage[] = [];
    const timestamps = new Map<number, number>();
    const tracker = new UsageTracker('.usage/today.jsonl');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function ask() {
        rl.question('\nYou: ', async (input) => {
            const trimmed = input.trim();
            if (!trimmed || trimmed === 'exit') {
                console.log('Bye!');
                cronService.stop();
                await gateway.stopAll();
                await pluginManager.unloadAll();
                rl.close();
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

    console.log('Super Agent v0.18 — Cron 定时任务 (type "exit" to quit)');
    console.log('快捷命令：');
    console.log('  /cron             — 查看定时任务');
    console.log('  /cron logs        — 查看执行记录');
    console.log('  /role [角色]      — 查看/切换角色');
    console.log('  /hooks            — 查看 Hook 管线');
    console.log('');
    console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
    console.log(`  Hook: ${hooks.pre.length} 个 pre + ${hooks.post.length} 个 post`);
    console.log(`  Cron: ${cronJobs.length} 个定时任务`);
    console.log('');
    console.log('  试试：');
    console.log('    让 Agent 创建一个每 30 秒执行的定时任务');
    console.log('    /cron         — 查看当前任务列表');
    console.log('    /cron logs    — 查看执行记录');
    console.log('');

    if (fs.existsSync('docs')) {
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
    }
    ask();
}

main().catch(console.error);
