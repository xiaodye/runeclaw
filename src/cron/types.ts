export type ScheduleType = 'cron' | 'interval' | 'once';

export interface CronJobConfig {
    /** 任务唯一标识，用于存储、日志关联和调度去重。 */
    id: string; // 任务唯一标识
    /** 任务显示名称，用于列表和通知。 */
    name: string; // 任务显示名称
    /** 可选任务描述，补充说明任务用途。 */
    description?: string; // 可选的任务描述
    /** 调度表达式，支持 cron 五字段、every 间隔和 ISO 时间戳。 */
    schedule: string; // 调度表达式：cron 五字段 | "every 30s" | ISO 时间戳
    /** 调度表达式解析后的类型。 */
    scheduleType: ScheduleType; // 解析后的调度类型
    /** 是否启用任务，禁用后不会进入调度。 */
    enabled: boolean; // 是否启用
    /** 实际执行内容，可以是 agent prompt 或 handler 名称。 */
    payload: JobPayload; // 执行内容（agent prompt 或 handler 回调）
    /** 单次执行超时毫秒数，缺省为 60000。 */
    timeout?: number; // 单次执行超时，单位 ms，默认 60000
    /** 连续失败多少次后自动禁用，缺省为 3。 */
    maxRetries?: number; // 连续失败多少次后自动禁用，默认 3
    /** 任务来源；config 任务由配置提供，runtime 任务可由服务增删。 */
    source: 'config' | 'runtime'; // 来源：config 不可删，runtime 可增删
}

export type JobPayload =
    /** 将 prompt 交给 Agent Loop 执行。 */
    | {
          /** payload 类型标记，表示交给 Agent Loop 执行。 */
          type: 'agent';
          /** 传给 Agent Loop 的任务 prompt。 */
          prompt: string;
      } // 把 prompt 交给 Agent Loop 执行
    /** 调用插件或内置逻辑注册的 handler。 */
    | {
          /** payload 类型标记，表示调用 handler。 */
          type: 'handler';
          /** 插件或内置逻辑注册的 handler 名称。 */
          handler: string;
      }; // 调用插件注册的 handler 函数

export interface RunLog {
    /** 所属任务 id，用于按任务筛选日志。 */
    jobId: string; // 所属任务 ID
    /** 开始时间 ISO 字符串。 */
    startedAt: string; // 开始时间 ISO 字符串
    /** 结束时间 ISO 字符串。 */
    finishedAt: string; // 结束时间 ISO 字符串
    /** 执行结果状态。 */
    status: 'success' | 'error' | 'timeout'; // 执行结果
    /** 执行输出摘要，写入前会截断到 1000 字符。 */
    output?: string; // 执行输出（截断到 1000 字符）
    /** 失败或超时时记录的错误信息。 */
    error?: string; // 错误信息
}

export interface CronJobState {
    /** 当前任务配置。 */
    config: CronJobConfig; // 任务配置
    /** 当前定时器句柄，空值表示尚未调度。 */
    timerId: ReturnType<typeof setTimeout> | null; // 当前定时器句柄
    /** 上一次执行记录。 */
    lastRun?: RunLog; // 上一次执行记录
    /** 连续失败计数，用于自动禁用策略。 */
    consecutiveFailures: number; // 连续失败计数
    /** 是否正在执行中，用于避免同一任务重入。 */
    running: boolean; // 是否正在执行中
}
