import { Cron } from 'croner';
import type { ScheduleType } from './types.js';

export interface ParsedSchedule {
    /** 调度表达式解析后的任务类型。 */
    type: ScheduleType;
    /** interval 类型的固定间隔毫秒数。 */
    intervalMs?: number; // interval 类型：固定间隔毫秒数
    /** cron 类型使用的 Croner 实例，用于计算下次触发时间。 */
    cronInstance?: Cron; // cron 类型：croner 实例，负责计算下次执行时间
    /** once 类型的一次性目标执行时间。 */
    onceAt?: Date; // once 类型：一次性执行的目标时间
}

const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i;

/**
 * 将用户输入的调度表达式解析为 interval、once 或 cron 执行计划。
 *
 * @param expr 调度表达式，支持 every、ISO 时间戳和 cron 语法。
 * @returns
 */
export function parseSchedule(expr: string): ParsedSchedule {
    // 固定间隔
    const intervalMatch = expr.match(INTERVAL_RE);
    if (intervalMatch) {
        const value = parseInt(intervalMatch[1]);
        const unit = intervalMatch[2].toLowerCase();
        const multiplier = unit.startsWith('h') ? 3600000 : unit.startsWith('m') ? 60000 : 1000;
        return { type: 'interval', intervalMs: value * multiplier };
    }

    // ISO 时间戳
    if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
        const date = new Date(expr);
        if (!isNaN(date.getTime())) {
            return { type: 'once', onceAt: date };
        }
    }

    // Cron 表达式
    const cronInstance = new Cron(expr);
    return { type: 'cron', cronInstance };
}

/**
 * 读取 Croner 距离下次触发的毫秒数，并提供兜底延迟。
 *
 * @param cron 已创建的 Croner 实例。
 * @returns
 */
export function getNextCronTime(cron: Cron): number {
    return cron.msToNext() ?? 60000;
}
