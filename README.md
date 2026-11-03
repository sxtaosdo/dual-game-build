# Dual Game Build

**当前版本：`v0.3.0.6`**

状态: Draft

为 `P4000/ant-cook` 生成 `ant`、`cook`、`both` 三种独立 Creator 输入。源工程不裁剪；未选玩法的脚本、资源和 UUID 从输入中排除。

使用 Node 22，测试为 `node --test tests/*.test.mjs`。本目录安装的专用运行时在 `node_modules/node/bin/node.exe`，不修改全局 Node。

正式输入示例：

```powershell
node build-input.mjs ../../P4000/ant-cook ant "$env:TEMP/shidai3-dual-game-build/run-id/ant"
```

输出必须位于该任务 Temp 根，目标已存在即失败；实际父路径也必须留在此根，拒绝 junction/symlink 越界。正式输入必须有 Creator 保存的 `assets/shell/Bootstrap.scene`。没有场景时可运行 `plan()`，或显式调用 `stage(..., { requireBootstrap: false })` 生成一次性物理审计输入；后者记录 `readyForCreatorBuild: false`，不能当作正式构建验收。`BUILD_INPUT.json` 保存资源与 Provider 的内容 hash、UUID、全部复制文件 hash、共享清单 hash 和原路径/目标路径，供构建后复核。

共享清单的 schema、路径、原始图像/meta 字节 hash、UUID 及目标冲突均在写入前检查。未选玩法的根 meta、脚本压缩 UUID 和子资源引用也参与负向检查；plan 与 stage 共用同一选择器。只改入口可见性不能通过这些检查。

`provider-typecheck.mjs <新产品目录> <工作区目录>` 在严格配置下将本地 MK 补丁与 migration 来源字节比较。`passed` 表示未新增诊断计数，`cleanProviderTypecheck` 另表示是否零诊断；不放宽 strict，也不把 vendor 的既有错误隐藏为全通过。

`migration.mjs` 仅将指定来源的业务 Bundle、唯一 MK、必要公共资源和测试材料复制到空的新产品路径，禁止覆盖；`MIGRATION_SOURCES.json` 保存来源 SHA、脏状态及索引 hash 和逐文件原字节 hash。

Owner 已确认初始工具版本基线 0.3.0.0，正常版本 Hook 为本地检查点递增第四段；业务远端已建立；父仓以 submodule 挂载。

`creator-build.mjs <ant-cook目录> <Creator可执行文件> <Temp回执路径>` 顺序构建三种隔离输入，记录源码 HEAD、输入/配置/产物 hash 和实际退出状态。Creator 的开发示例入口从输入排除，P0002 固定子模块不修改。该命令仅启动 CLI Build；临时用户配置、日志与输出在本任务 Temp。

`build-smoke.mjs <构建回执> <Temp验收回执> <Playwright所在package.json>` 在新建 Edge 上下文验证每种产物的入口与物理 Bundle 选择，并默认执行双玩法产物的实际往返/保存故障恢复。`runtime-smoke.mjs <本地Preview或产物URL> <Temp回执> <Playwright所在package.json>` 可独立执行相同运行回归。它们使用已安装的 Playwright，保持实际产物 hash，独立上下文不使用用户浏览器存档；不能将源码替身测试当作 Runtime 完成。不接入其他玩法或 P1060 采集器。

迁移支持 Windows x64、本地 NTFS、Python 标准库和 Node 22。句柄相对创建/写入使用 OBJ_DONT_REPARSE，目标能力固定在获准的新产品目录，已有文件拒绝覆盖；保留来源冻结及前后 Git/字节复核。不修改 ACL 或特权，不保证管理员、驱动或设备映射篡改；失败保留部分输出，不自动回滚删除。
