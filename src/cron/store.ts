import fs from 'node:fs';
import type { CronJobConfig, RunLog } from './types.js';

const JOBS_FILE = '.cron/jobs.json';
const LOGS_FILE = '.cron/logs.jsonl';

export class CronStore {
    /**
     * 创建 cron 持久化存储。
     *
     * @param baseDir `.cron` 目录所在根路径。
     */
    constructor(private baseDir: string = '.') {}

    /** 任务配置文件的绝对或相对路径。 */
    private get jobsPath() {
        return `${this.baseDir}/${JOBS_FILE}`;
    }
    /** 运行日志 JSONL 文件的绝对或相对路径。 */
    private get logsPath() {
        return `${this.baseDir}/${LOGS_FILE}`;
    }

    /**
     * 确保存储目录存在，供读写任务和日志前调用。
     */
    init(): void {
        const dir = `${this.baseDir}/.cron`;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    /**
     * 读取任务配置文件，解析失败时返回空列表。
     *
     * @returns
     */
    loadJobs(): CronJobConfig[] {
        if (!fs.existsSync(this.jobsPath)) return [];
        try {
            const data = JSON.parse(fs.readFileSync(this.jobsPath, 'utf-8'));
            return data.jobs || [];
        } catch {
            return [];
        }
    }

    /**
     * 覆盖保存任务配置列表。
     *
     * @param jobs 需要持久化的任务配置。
     */
    saveJobs(jobs: CronJobConfig[]): void {
        this.init();
        fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2));
    }

    /**
     * 追加一条任务运行日志到 JSONL 文件。
     *
     * @param log 单次任务运行记录。
     */
    appendLog(log: RunLog): void {
        this.init();
        fs.appendFileSync(this.logsPath, JSON.stringify(log) + '\n');
    }

    /**
     * 读取最近的运行日志，支持按任务 id 过滤。
     *
     * @param jobId 可选任务 id，传入时只返回该任务日志。
     * @param limit 返回日志数量上限。
     * @returns
     */
    getRecentLogs(jobId?: string, limit = 10): RunLog[] {
        if (!fs.existsSync(this.logsPath)) return [];
        const lines = fs.readFileSync(this.logsPath, 'utf-8').split('\n').filter(Boolean);

        let logs: RunLog[] = lines
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return null;
                }
            })
            .filter(Boolean) as RunLog[];

        if (jobId) logs = logs.filter((l) => l.jobId === jobId);
        return logs.slice(-limit);
    }
}
