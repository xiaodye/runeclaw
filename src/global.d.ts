// marked-terminal@7.x 未随包提供 TypeScript 类型，这里在全局声明中补充。
declare module 'marked-terminal' {
    /**
     * 返回一个可作为 marked 扩展使用的终端渲染器插件。
     *
     * @param options 渲染选项（表头样式、颜色等）。
     * @param highlightOptions 代码高亮选项。
     * @returns
     */
    export function markedTerminal(
        options?: Record<string, unknown>,
        highlightOptions?: Record<string, unknown>,
    ): import('marked').MarkedExtension;
}
