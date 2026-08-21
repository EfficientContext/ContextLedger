# Good example

把 task agent 的并发和合并后的验证并发拆开了。`--max-workers` 继续控制 task agent 数量；`--final-focused-max-workers` 只控制合并后的 focused validation，默认值为 `1`，避免同一个 checkout 同时启动多个容器。2026-08-20 重新运行相关测试，结果为 23 passed in 0.21s。
