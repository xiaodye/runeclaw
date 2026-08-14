import type { CronJobConfig, CronJobState, RunLog, JobPayload } from './types.js';
import { parseSchedule, getNextCronTime } from './parser.js';
import { CronStore } from './store.js';

const QUOTES = [
    '\u201C知之为知之，不知为不知，是知也。\u201D \u2014\u2014 孔子',
    '\u201C学而不思则罔，思而不学则殆。\u201D \u2014\u2014 孔子',
    '\u201C千里之行，始于足下。\u201D \u2014\u2014 老子',
    '\u201C天行健，君子以自强不息。\u201D \u2014\u2014 《周易》',
    '\u201C不积跬步，无以至千里。\u201D \u2014\u2014 荀子',
    '\u201CStay hungry, stay foolish.\u201D \u2014\u2014 Steve Jobs',
    '\u201CThe best way to predict the future is to invent it.\u201D \u2014\u2014 Alan Kay',
    '\u201CTalk is cheap. Show me the code.\u201D \u2014\u2014 Linus Torvalds',
    '\u201CSimplicity is the ultimate sophistication.\u201D \u2014\u2014 Leonardo da Vinci',
    '\u201CFirst, solve the problem. Then, write the code.\u201D \u2014\u2014 John Johnson',
];

export interface CronExecutor {
    /** 将任务 prompt 交给 Agent 执行，并可传入单次超时时间。 */
    runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>;
    /** 可选通知回调，用于向外部展示任务执行结果摘要。 */
    notify?: (message: string) => void;
}

export class CronService {
    /** 当前已加载的任务状态表，以任务 id 做索引。 */
    private jobs = new Map<string, CronJobState>();
    /** 负责读写任务配置与运行日志的持久化存储。 */
    private store: CronStore;
    /** 执行 agent prompt 或发送通知的外部适配器。 */
    private executor?: CronExecutor;
    /** 服务是否处于运行状态，决定新增/启用任务是否立即调度。 */
    private running = false;

    /**
     * 创建定时任务服务，并初始化任务存储目录。
     *
     * @param baseDir `.cron` 数据目录所在的项目根目录。
     */
    constructor(baseDir = '.') {
        this.store = new CronStore(baseDir);
        this.store.init();
    }

    /**
     * 注入实际执行任务和通知外部系统的适配器。
     *
     * @param executor 外部执行器实现。
     */
    setExecutor(executor: CronExecutor): void {
        this.executor = executor;
    }

    /**
     * 从持久化存储加载已启用任务到内存状态表。
     */
    load(): void {
        const configs = this.store.loadJobs();
        for (const config of configs) {
            if (config.enabled) {
                this.jobs.set(config.id, {
                    config,
                    timerId: null,
                    consecutiveFailures: 0,
                    running: false,
                });
            }
        }
    }

    /**
     * 启动调度循环，为所有已启用任务安排下一次执行。
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        for (const state of this.jobs.values()) {
            if (state.config.enabled) this.scheduleJob(state);
        }
    }

    /**
     * 停止调度循环并清理所有未触发的 timer。
     */
    stop(): void {
        this.running = false;
        for (const state of this.jobs.values()) {
            if (state.timerId) {
                clearTimeout(state.timerId);
                state.timerId = null;
            }
        }
    }

    /**
     * 添加一个运行时任务，并在服务运行中时立即纳入调度。
     *
     * @param config 新任务配置，id 必须唯一。
     */
    add(config: CronJobConfig): void {
        if (this.jobs.has(config.id)) throw new Error(`任务 ${config.id} 已存在`);
        const state: CronJobState = {
            config,
            timerId: null,
            consecutiveFailures: 0,
            running: false,
        };
        this.jobs.set(config.id, state);
        this.persist();
        if (this.running && config.enabled) this.scheduleJob(state);
    }

    /**
     * 删除任务并取消其尚未触发的 timer。
     *
     * @param id 要删除的任务 id。
     * @returns
     */
    remove(id: string): boolean {
        const state = this.jobs.get(id);
        if (!state) return false;
        if (state.timerId) clearTimeout(state.timerId);
        this.jobs.delete(id);
        this.persist();
        return true;
    }

    /**
     * 启用指定任务并重置连续失败计数。
     *
     * @param id 要启用的任务 id。
     * @returns
     */
    enable(id: string): boolean {
        const state = this.jobs.get(id);
        if (!state) return false;
        state.config.enabled = true;
        state.consecutiveFailures = 0;
        this.persist();
        if (this.running) this.scheduleJob(state);
        return true;
    }

    /**
     * 禁用指定任务并取消其当前 timer。
     *
     * @param id 要禁用的任务 id。
     * @returns
     */
    disable(id: string): boolean {
        const state = this.jobs.get(id);
        if (!state) return false;
        state.config.enabled = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        this.persist();
        return true;
    }

    /**
     * 列出任务配置、调度状态和最近一次运行日志。
     *
     * @returns
     */
    list(): Array<{
        /** 任务配置快照。 */
        config: CronJobConfig;
        /** 当前调度状态，区分运行中、禁用、已调度和空闲。 */
        status: string;
        /** 最近一次运行日志。 */
        lastRun?: RunLog;
    }> {
        return Array.from(this.jobs.values()).map((state) => ({
            config: state.config,
            status: state.running
                ? 'running'
                : !state.config.enabled
                  ? 'disabled'
                  : state.timerId
                    ? 'scheduled'
                    : 'idle',
            lastRun: state.lastRun,
        }));
    }

    /**
     * 立即执行指定任务，不影响后续已安排的调度计划。
     *
     * @param id 要立即执行的任务 id。
     * @returns
     */
    async runNow(id: string): Promise<string> {
        const state = this.jobs.get(id);
        if (!state) return `任务 ${id} 不存在`;
        return this.executeJob(state);
    }

    /**
     * 读取最近运行日志，可按任务过滤。
     *
     * @param jobId 可选任务 id，传入时只返回该任务日志。
     * @param limit 返回日志数量上限。
     * @returns
     */
    getRecentLogs(jobId?: string, limit?: number): RunLog[] {
        return this.store.getRecentLogs(jobId, limit);
    }

    /**
     * 根据任务调度表达式安排下一次执行，并处理一次性任务的自动移除。
     *
     * @param state 待调度的任务运行状态。
     */
    private scheduleJob(state: CronJobState): void {
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        try {
            const parsed = parseSchedule(state.config.schedule);
            let delayMs: number;
            switch (parsed.type) {
                case 'interval':
                    delayMs = parsed.intervalMs!;
                    break;
                case 'once': {
                    const diff = parsed.onceAt!.getTime() - Date.now();
                    if (diff <= 0) {
                        this.executeJob(state);
                        return;
                    }
                    delayMs = diff;
                    break;
                }
                case 'cron':
                    delayMs = getNextCronTime(parsed.cronInstance!);
                    break;
            }
            state.timerId = setTimeout(async () => {
                await this.executeJob(state);
                if (parsed.type !== 'once' && state.config.enabled && this.running) {
                    this.scheduleJob(state);
                } else if (parsed.type === 'once') {
                    this.remove(state.config.id);
                }
            }, delayMs);
        } catch (err: any) {
            console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${err.message}`);
        }
    }

    /**
     * 执行单个任务，记录日志并在连续失败超限后自动禁用。
     *
     * @param state 待执行的任务运行状态。
     * @returns
     */
    private async executeJob(state: CronJobState): Promise<string> {
        if (state.running) return '任务正在执行中';
        state.running = true;
        const startedAt = new Date().toISOString();
        let output = '';
        let status: RunLog['status'] = 'success';
        let error: string | undefined;
        try {
            const timeout = state.config.timeout || 60000;
            output = await this.runPayload(state.config.payload, timeout);
            state.consecutiveFailures = 0;
        } catch (err: any) {
            status = err.message?.includes('timeout') ? 'timeout' : 'error';
            error = err.message;
            output = `执行失败: ${err.message}`;
            state.consecutiveFailures++;
            const maxRetries = state.config.maxRetries ?? 3;
            if (state.consecutiveFailures >= maxRetries) {
                state.config.enabled = false;
                console.log(`  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`);
                this.persist();
            }
        } finally {
            state.running = false;
        }

        const log: RunLog = {
            jobId: state.config.id,
            startedAt,
            finishedAt: new Date().toISOString(),
            status,
            output: output.slice(0, 1000),
            error,
        };
        state.lastRun = log;
        this.store.appendLog(log);
        if (this.executor?.notify) {
            const icon = status === 'success' ? '✓' : '✗';
            this.executor.notify(`[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`);
        }
        return output;
    }

    /**
     * 根据 payload 类型分发到 Agent prompt 或内置 handler。
     *
     * @param payload 任务执行内容。
     * @param timeout 单次执行超时时间，单位毫秒。
     * @returns
     */
    private async runPayload(payload: JobPayload, timeout: number): Promise<string> {
        if (!this.executor) return '[cron] 未设置执行器，无法运行任务';
        if (payload.type === 'agent') {
            return this.executor.runAgentPrompt(payload.prompt, timeout);
        }
        if (payload.type === 'handler') {
            if (payload.handler === 'random-quote') {
                return QUOTES[Math.floor(Math.random() * QUOTES.length)];
            }
            return `[handler] ${payload.handler} — handler 类型需要通过插件注册`;
        }
        return '未知 payload 类型';
    }

    /**
     * 保存运行时任务，同时保留配置文件来源的只读任务。
     */
    private persist(): void {
        const configs = Array.from(this.jobs.values())
            .filter((s) => s.config.source === 'runtime')
            .map((s) => s.config);
        const existing = this.store.loadJobs().filter((j) => j.source === 'config');
        this.store.saveJobs([...existing, ...configs]);
    }
}
