import type { CommandHandler } from './index.js';

export const ragCommands: CommandHandler[] = [
    (cmd, ctx) => {
        if (cmd !== '/rag' && cmd !== 'rag') return false;
        const vs = ctx.vectorStore;
        console.log(`\n[知识库] ${vs.size()} 个片段`);
        if (!ctx.registry.get('rag_search')) {
            console.log('  RAG 工具不可用：请启用 rag.enabled 并配置 rag.embeddingKey。');
        }
        const sources = vs.sources();
        if (sources.length > 0) console.log(`  来源: ${sources.join(', ')}`);
        console.log('');
        return true;
    },

    (cmd, ctx) => {
        if (!cmd.startsWith('ingest ')) return false;
        const path = cmd.slice('ingest '.length).trim();
        console.log(`\n[导入] 正在处理 ${path}...`);
        const ragIngestTool = ctx.registry.getActiveTools().find((t) => t.name === 'rag_ingest');
        if (!ragIngestTool) {
            console.log('  无法导入：请启用 rag.enabled 并配置 rag.embeddingKey。\n');
            return true;
        }
        ragIngestTool.execute!({ path }).then((result: any) => {
            console.log(`  ${result}\n`);
            ctx.ask();
        });
        return 'async';
    },
];
