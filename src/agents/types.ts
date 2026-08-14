export interface SubAgentConfig {
    /** 允许创建子 Agent 的最大嵌套层数。 */
    maxSpawnDepth: number; // 最大嵌套深度，默认 1
    /** 同时处于运行状态的子 Agent 数量上限。 */
    maxConcurrent: number; // 最大并发子 agent 数，默认 3
    /** 未单独指定时采用的执行超时时间，单位为毫秒。 */
    defaultTimeout: number; // 默认执行超时 ms，默认 60000
}

export const DEFAULT_CONFIG: SubAgentConfig = {
    maxSpawnDepth: 1,
    maxConcurrent: 3,
    defaultTimeout: 60000,
};

export interface SpawnRequest {
    /** 交由子 Agent 执行的任务描述。 */
    task: string; // 子 agent 的任务描述
    /** 允许调用的工具名；省略时继承父 Agent 的工具范围。 */
    tools?: string[]; // 允许使用的工具名（不传则继承父 agent）
    /** 本次执行的超时时间，单位为毫秒。 */
    timeout?: number; // 执行超时 ms
}

export interface SubAgentRun {
    /** 用于关联日志与运行状态的唯一标识。 */
    id: string; // 运行 ID
    /** 本次运行接收的任务描述。 */
    task: string; // 任务描述
    /** 子 Agent 当前所处的执行状态。 */
    status: 'running' | 'completed' | 'error' | 'timeout';
    /** 本次运行所在的嵌套深度。 */
    depth: number; // 当前嵌套深度
    /** 运行开始时刻的 ISO 时间字符串。 */
    startedAt: string;
    /** 运行结束时刻的 ISO 时间字符串。 */
    finishedAt?: string;
    /** 成功完成后产生的结果文本。 */
    result?: string; // 执行结果文本
    /** 执行失败或超时时记录的错误信息。 */
    error?: string;
}
