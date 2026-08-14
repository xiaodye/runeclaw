export interface PromptContext {
    /** 当前可用工具数量，用于决定是否展示工具引导。 */
    toolCount: number;
    /** 延迟加载工具的摘要说明，空字符串表示无需提示。 */
    deferredToolSummary: string;
    /** 当前会话已积累的历史消息数量。 */
    sessionMessageCount: number;
    /** 当前会话标识，用于 prompt 中关联会话状态。 */
    sessionId: string;
}

/** 根据 prompt 构建上下文生成一个可选片段。 */
type PipeFn = (ctx: PromptContext) => string | null;

export class PromptBuilder {
    /** 按注册顺序执行的 prompt 片段生成管道。 */
    private pipes: Array<{
        /** 调试输出中展示的管道名称。 */
        name: string;
        /** 根据上下文生成 prompt 片段的函数。 */
        fn: PipeFn;
    }> = [];

    /**
     * 注册一个 prompt 片段生成管道，并保持链式调用能力。
     *
     * @param name 调试输出中展示的管道名称。
     * @param fn 根据上下文生成片段的函数。
     * @returns
     */
    pipe(name: string, fn: PipeFn): this {
        this.pipes.push({ name, fn });
        return this;
    }

    /**
     * 执行所有管道并拼接非空 prompt 片段。
     *
     * @param ctx prompt 构建所需的运行时上下文。
     * @returns
     */
    build(ctx: PromptContext): string {
        const sections: string[] = [];

        for (const { fn } of this.pipes) {
            const result = fn(ctx);
            if (result !== null) {
                sections.push(result);
            }
        }

        return sections.join('\n\n');
    }

    /**
     * 输出各管道是否生效及其生成内容长度，辅助排查 prompt 组成。
     *
     * @param ctx prompt 构建所需的运行时上下文。
     */
    debug(ctx: PromptContext): void {
        console.log('\n=== Prompt Pipe Debug ===');
        for (const { name, fn } of this.pipes) {
            const result = fn(ctx);
            const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]';
            console.log(`  ${name}: ${status}`);
        }
        console.log('========================\n');
    }
}

// ── 预定义的 Pipe ────────────────────────────────

/**
 * 创建包含 RuneClaw 基础行为准则的 prompt 管道。
 *
 * @returns
 */
export function coreRules(): PipeFn {
    return () => `你是 RuneClaw，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`;
}

/**
 * 创建仅在存在工具时展示工具使用提示的 prompt 管道。
 *
 * @returns
 */
export function toolGuide(): PipeFn {
    return (ctx) => {
        if (ctx.toolCount === 0) return null;
        return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`;
    };
}

/**
 * 创建提示用户可通过 tool_search 发现延迟工具的 prompt 管道。
 *
 * @returns
 */
export function deferredTools(): PipeFn {
    return (ctx) => {
        if (!ctx.deferredToolSummary) return null;
        return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`;
    };
}

/**
 * 创建携带当前会话标识和历史消息数量的 prompt 管道。
 *
 * @returns
 */
export function sessionContext(): PipeFn {
    return (ctx) => {
        if (ctx.sessionMessageCount === 0) return null;
        return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`;
    };
}
