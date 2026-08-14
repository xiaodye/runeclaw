export type HookAction = 'allow' | 'block' | 'modify';

export interface HookResult {
    /** hook 对当前工具调用或结果的处理动作。 */
    action: HookAction;
    /** 拦截或修改时展示给调用方的原因。 */
    reason?: string;
    /** pre hook 修改后的工具输入。 */
    modifiedInput?: unknown;
    /** post hook 修改后的工具输出。 */
    modifiedOutput?: unknown;
}

/** 工具执行前的拦截或改写函数。 */
export type PreToolHook = (toolName: string, input: unknown) => HookResult | Promise<HookResult>;
/** 工具执行后的输出检查或改写函数。 */
export type PostToolHook = (
    toolName: string,
    input: unknown,
    output: unknown,
) => HookResult | Promise<HookResult>;

export class HookPipeline {
    /** 工具执行前按注册顺序运行的 hook。 */
    private preHooks: Array<{
        /** hook 名称，用于日志定位。 */
        name: string;
        /** 工具执行前运行的 hook 函数。 */
        fn: PreToolHook;
    }> = [];
    /** 工具执行后按注册顺序运行的 hook。 */
    private postHooks: Array<{
        /** hook 名称，用于日志定位。 */
        name: string;
        /** 工具执行后运行的 hook 函数。 */
        fn: PostToolHook;
    }> = [];

    /**
     * 注册一个工具执行前 hook。
     *
     * @param name hook 名称，用于日志定位。
     * @param fn hook 实现函数。
     */
    registerPre(name: string, fn: PreToolHook): void {
        this.preHooks.push({ name, fn });
    }

    /**
     * 注册一个工具执行后 hook。
     *
     * @param name hook 名称，用于日志定位。
     * @param fn hook 实现函数。
     */
    registerPost(name: string, fn: PostToolHook): void {
        this.postHooks.push({ name, fn });
    }

    /**
     * 顺序执行 pre hook，遇到 block 时提前返回。
     *
     * @param toolName 即将执行的工具名。
     * @param input 原始工具输入。
     * @returns
     */
    async runPre(toolName: string, input: unknown): Promise<HookResult> {
        let currentInput = input;

        for (const hook of this.preHooks) {
            try {
                const result = await hook.fn(toolName, currentInput);
                if (result.action === 'block') {
                    console.log(`  [hook:${hook.name}] 拦截 ${toolName}: ${result.reason}`);
                    return result;
                }
                if (result.action === 'modify' && result.modifiedInput !== undefined) {
                    currentInput = result.modifiedInput;
                    console.log(`  [hook:${hook.name}] 修改了 ${toolName} 的输入`);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  [hook:${hook.name}] pre 异常: ${msg}`);
            }
        }

        return { action: 'allow' };
    }

    /**
     * 顺序执行 post hook，并把修改后的输出传给后续 hook。
     *
     * @param toolName 已执行的工具名。
     * @param input 工具执行时使用的输入。
     * @param output 工具原始输出。
     * @returns
     */
    async runPost(toolName: string, input: unknown, output: unknown): Promise<HookResult> {
        let currentOutput = output;

        for (const hook of this.postHooks) {
            try {
                const result = await hook.fn(toolName, input, currentOutput);
                if (result.action === 'modify' && result.modifiedOutput !== undefined) {
                    currentOutput = result.modifiedOutput;
                    console.log(`  [hook:${hook.name}] 修改了 ${toolName} 的输出`);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  [hook:${hook.name}] post 异常: ${msg}`);
            }
        }

        return { action: 'allow', modifiedOutput: currentOutput };
    }

    /**
     * 列出已注册 hook 名称，便于调试 pipeline 配置。
     *
     * @returns
     */
    list(): {
        /** 已注册的 pre hook 名称列表。 */
        pre: string[];
        /** 已注册的 post hook 名称列表。 */
        post: string[];
    } {
        return {
            pre: this.preHooks.map((h) => h.name),
            post: this.postHooks.map((h) => h.name),
        };
    }
}
