# Dual Game Build

**当前版本：`v0.3.0.1`**

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

当前尚未执行三种 Creator 正式构建。独立工具仓的版本前缀、远端和首次提交待 Owner 确认；不将此脚本接入其他玩法或 P1060 采集器。

迁移支持 Windows x64、本地 NTFS、Python 标准库和 Node 22。句柄相对创建/写入使用 OBJ_DONT_REPARSE，目标能力固定在获准的新产品目录，已有文件拒绝覆盖；保留来源冻结及前后 Git/字节复核。不修改 ACL 或特权，不保证管理员、驱动或设备映射篡改；失败保留部分输出，不自动回滚删除。
