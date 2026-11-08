import { estimateMessageTokens, applyDefense } from '../context/defense.js';
import type { CommandHandler } from './index.js';

export const debugCommands: CommandHandler[] = [
    (cmd, ctx) => {
        if (cmd !== '执行防线' && cmd !== 'defend') return false;
        console.log('\n--- 执行防线 ---');
        const before = estimateMessageTokens(ctx.messages);
        const def = applyDefense(ctx.messages, ctx.timestamps);
        ctx.messages = def.messages;
        console.log(`  [TTL] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`);
        console.log(
            `  [结果] ~${before} → ~${def.tokenEstimate} tokens (节省 ${before - def.tokenEstimate})\n`,
        );
        return true;
    },

    (cmd, ctx) => {
        if (cmd !== 'status' && cmd !== '查��状态') return false;
        const tokens = estimateMessageTokens(ctx.messages);
        const memCount = ctx.memoryStore?.list().length ?? 0;
        const ragCount = ctx.vectorStore?.size() ?? 0;
        console.log(
            `\n[状态] ${ctx.messages.length} 条消息, ~${tokens} tokens, ${memCount} 条记忆, ${ragCount} 个知识库片段\n`,
        );
        return true;
    },
];
