import { buildContextSnapshot, renderContextView, renderUsageView } from '../context/view.js';
import type { CommandHandler } from './index.js';

export const contextCommands: CommandHandler[] = [
    (cmd, ctx) => {
        if (cmd !== '/context' && cmd !== 'context') return false;
        const SYSTEM = ctx.builder.build(ctx.makePromptCtx());
        const memoryChars = ctx.memoryStore?.buildPromptSection().length ?? 0;
        const snapshot = buildContextSnapshot({
            modelName: ctx.model.modelId,
            modelId: ctx.model.modelId,
            windowTokens: 1_000_000,
            systemPromptChars: SYSTEM.length,
            toolDescriptionChars: ctx.registry
                .getActiveTools()
                .reduce(
                    (a, t) =>
                        a +
                        t.name.length +
                        (t.description?.length || 0) +
                        JSON.stringify(t.parameters || {}).length,
                    0,
                ),
            memoryChars,
            skillsChars: 0,
            messages: ctx.messages,
        });
        console.log(renderContextView(snapshot));
        return true;
    },

    (cmd, ctx) => {
        if (cmd !== '/usage' && cmd !== 'usage') return false;
        console.log(renderUsageView(ctx.tracker));
        return true;
    },
];
