import type { SubAgentRun, SubAgentConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class SubAgentRegistry {
    /** 按运行 ID 保存当前进程内的子 Agent 执行记录。 */
    private runs = new Map<string, SubAgentRun>();

    /** 控制子 Agent 嵌套、并发与超时的运行配置。 */
    private config: SubAgentConfig;

    /** 用于生成进程内递增运行 ID 的计数器。 */
    private idCounter = 0;

    /**
     * 创建子 Agent 运行注册表，并以传入配置覆盖默认值。
     *
     * @param config 可选的运行限制配置。
     */
    constructor(config?: Partial<SubAgentConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 生成便于日志追踪的进程内运行 ID。
     *
     * @returns
     */
    generateId(): string {
        return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`;
    }

    /**
     * 根据当前嵌套深度与活跃任务数判断能否创建子 Agent。
     *
     * @param currentDepth 发起方当前所在的嵌套深度。
     * @returns 允许创建时返回成功状态，否则附带拒绝原因。
     */
    canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
        if (currentDepth >= this.config.maxSpawnDepth) {
            return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` };
        }

        const activeCount = this.getActiveRuns().length;
        if (activeCount >= this.config.maxConcurrent) {
            return {
                ok: false,
                reason: `已达最大并发数 ${this.config.maxConcurrent}，等待现有任务完成`,
            };
        }

        return { ok: true };
    }

    /**
     * 登记一个已启动的子 Agent 运行记录。
     *
     * @param run 待追踪的运行记录。
     */
    register(run: SubAgentRun): void {
        this.runs.set(run.id, run);
    }

    /**
     * 将指定运行标记为完成并保存结果与结束时间。
     *
     * @param id 目标运行 ID。
     * @param result 子 Agent 返回的结果文本。
     */
    complete(id: string, result: string): void {
        const run = this.runs.get(id);
        if (!run) return;
        run.status = 'completed';
        run.result = result;
        run.finishedAt = new Date().toISOString();
    }

    /**
     * 将指定运行标记为失败并保存错误与结束时间。
     *
     * @param id 目标运行 ID。
     * @param error 子 Agent 的错误信息。
     */
    fail(id: string, error: string): void {
        const run = this.runs.get(id);
        if (!run) return;
        run.status = 'error';
        run.error = error;
        run.finishedAt = new Date().toISOString();
    }

    /**
     * 按运行 ID 查询记录。
     *
     * @param id 目标运行 ID。
     * @returns 未登记该 ID 时返回 `undefined`。
     */
    get(id: string): SubAgentRun | undefined {
        return this.runs.get(id);
    }

    /**
     * 获取当前仍在执行的子 Agent 记录。
     *
     * @returns
     */
    getActiveRuns(): SubAgentRun[] {
        return Array.from(this.runs.values()).filter((r) => r.status === 'running');
    }

    /**
     * 获取注册表中的全部运行记录。
     *
     * @returns
     */
    getAllRuns(): SubAgentRun[] {
        return Array.from(this.runs.values());
    }

    /**
     * 获取当前生效的子 Agent 运行配置。
     *
     * @returns
     */
    getConfig(): SubAgentConfig {
        return this.config;
    }
}
