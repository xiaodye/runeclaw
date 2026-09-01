# Repository Guidelines

## 项目结构与模块划分

RuneClaw 是基于 TypeScript 和 Node.js 的本地 AI Agent CLI。

- `src/index.ts` 是 CLI 入口，`src/main.ts` 是组合根；核心循环、工具系统和上下文管理分别位于 `src/agent/`、`src/tools/`、`src/context/`。
- `src/rag/` 负责 SQLite 向量与全文检索，`src/memory/`、`src/session/`、`src/cron/` 分别负责记忆、会话和定时任务。
- Channel、配置和终端 UI 分别位于 `src/channels/`、`src/config/`、`src/ui/`；构建脚本和静态资源位于 `scripts/`、`assets/`。
- `docs/` 主要是 RAG 测试资料，不是项目设计文档。

## 构建、测试与开发命令

- `pnpm install`：安装依赖；要求 Node.js 22+、pnpm 10.x。
- `pnpm dev`：通过 `tsx` 直接运行源码，日常开发优先使用。
- `pnpm build`：使用 esbuild 将入口打包为可执行的 `dist/index.js`。
- `pnpm start`：运行构建产物；首次使用前执行 `pnpm init` 生成配置。
- `pnpm start:rag`：启动时自动导入 `docs/*.md`。

## 测试要求

- 仓库目前没有可用的测试 runner 或覆盖率门槛，`src/context/defense.spec.ts` 尚未接入测试脚本。提交前至少执行 `pnpm build`，并手动验证受影响的 CLI 命令或 Channel 流程。
- 后续接入测试后，默认只运行与改动相关的测试；除非用户明确要求，否则不要运行耗时的全量测试。

## 编码风格与命名

- TypeScript 使用四空格缩进、单引号和分号，并遵循相邻文件的写法；导入路径是否带 `.js` 以当前文件风格为准。
- 类和类型使用 PascalCase，函数与变量使用 camelCase，文件名使用 kebab-case。
- 新增或实质修改函数、方法、类成员、接口字段及对象类型成员时，遵循 `.agent/skills/add-tsdoc-comments/SKILL.md`，添加简洁的中文 TSDoc。

## 提交与 Pull Request

- 提交标题沿用简短的 Conventional Commit 风格，例如 `feat: AI 工作流`、`fix: 修复会话恢复`；一次提交只处理一个主题。
- PR 应说明行为变化、验证命令和潜在影响，有关联 Issue 时应链接。
- CLI 或终端 UI 有可见变化时附截图；Web UI 改动必须截图自查暗色模式和窄屏布局，确认视觉无误后再报告完成。

## 安全与配置

- 密钥只能放入 `.env`，`runeclaw.config.json` 仅保留 `${VAR}` 占位符。
- 不要提交 API Key、`.sessions/`、`.memory/`、`.cron/`、`.usage/`、`knowledge.db` 等本地运行数据。
- 涉及 Shell 工具、权限或 Hook 的改动必须检查输入边界和危险命令处理。

## Agent 专用说明

- 回答框架、SDK、API 或 CLI 工具相关问题时，先使用项目配置的 `find-docs`/Context7 流程查询当前文档。
- 修改代码时保持范围最小，不覆盖用户已有改动；使用满足当前需求的最简单实现，不为范围外需求预留扩展，能复用现有依赖时不要重复造轮子。
- 新增测试基础设施前先确认确有必要。
