// --- 错误分类 ---

/**
 * 判断错误是否适合通过重试恢复，覆盖限流、服务端错误和常见网络中断。
 *
 * @param error 待分类的未知错误对象。
 * @returns 是否应进入重试流程。
 */
export function isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const message = error.message || '';

    // HTTP 状态码判断
    const statusMatch = message.match(/(\d{3})/);
    if (statusMatch) {
        const status = Number.parseInt(statusMatch[1]);
        if ([429, 529, 408].includes(status)) return true;
        if (status >= 500 && status < 600) return true;
        if (status >= 400 && status < 500) return false;
    }

    // 网络错误
    if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
    if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
    if (message.includes('fetch failed') || message.includes('network')) return true;
    // AI SDK 会把流式错误包装成 NoOutputGeneratedError
    if (message.includes('No output generated')) return true;

    return false;
}

// --- 指数退避 + 随机抖动 ---

/**
 * 按指数退避计算下一次重试等待时间，并加入随机抖动降低并发重试冲击。
 *
 * @param attempt 当前重试序号，从 1 开始。
 * @param baseMs 初始退避时长，单位为毫秒。
 * @param maxMs 最大退避上限，单位为毫秒。
 * @returns 本次重试前应等待的毫秒数。
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
    const exponential = baseMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, maxMs);
    const jitterRange = capped * 0.25;
    const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
    return Math.max(0, Math.round(jittered));
}

/**
 * 返回一个在指定时间后 resolve 的 Promise，用于串联异步等待。
 *
 * @param ms 等待时长，单位为毫秒。
 * @returns 等待结束后 resolve 的 Promise。
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
