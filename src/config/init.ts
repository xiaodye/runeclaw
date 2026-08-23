import { render } from 'ink';
import { createElement } from 'react';
import { InitWizard } from './init-wizard';

/**
 * 启动 RuneClaw 的交互式初始化向导。
 *
 * 使用 Ink（React 渲染的 CLI）展示分步表单，引导用户填写模型、API Key、
 * 飞书 Channel 以及用于 RAG 向量化的 DashScope API Key，最后写出
 * `runeclaw.config.json` 与 `.env`。
 *
 * @returns
 */
export function runInit(): void {
    const instance = render(createElement(InitWizard));
    // 渲染器卸载后进程即可退出，这里仅消费 promise 以避免未处理拒绝。
    instance.waitUntilExit().catch(() => {});
}
