# 更新日志

2026-11-03：推送业务远端 git@github.com:sxtaosdo/dual-game-build.git，父仓登记 submodule。

状态: Draft

## 未发布（初始版本基线 0.3.0.0；本地检查点按 Hook 递增）

- 增加来源保真迁移清单和三种隔离构建输入。
- 检查私有文件、根 meta、UUID 冲突、压缩脚本 UUID 和指向被排除玩法的序列化引用；共享遮罩纹理保留来源字节和 UUID，写入前验证清单路径、hash 与目标冲突。
- 统一 plan/stage 选择，检查实际 Temp 父路径，复制后核对全部文件 hash 并写入审计 manifest。14 项工具测试通过；缺少 Bootstrap 的审计输入明确不可作为正式构建。
- 增加 MK Provider 严格诊断与来源字节 baseline 的差异检查，不宣称 Provider 零诊断。

- 迁移按 Windows x64、本地 NTFS 合同使用父句柄相对创建/读写，拒绝重解析与已有目标；保留来源冻结、前后 Git/字节复核，不修改 ACL 或权限。失败保留部分输出。
- 三种 Creator 编译首轮完成后，真实产物检查发现框架开发示例自动执行；隔离输入现精确排除固定 Provider 的 examples 子树，保留公共运行代码与来源 hash。
- 增加顺序 Creator CLI Build、精确产物 hash/入口 Smoke、实际 Bootstrap 双向切换与保存故障回归工具；只使用新建 Edge 上下文及任务 Temp，不接入共享采集器。最终验收结果以本次任务对应源码 SHA 的回执为准。
- 产物导航断言跟随共享切换面板的实际节点层级，仍要求只出现已选玩法；保留入口、错误、外部请求及产物 hash 检查。
- 构建验收拒绝未完成、缺失或重复变体的回执；验收前绑定当前源码 HEAD、输入 manifest、构建配置及原始产物 hash。子进程启动后立即监听退出与启动失败，避免回执 IO 期间丢失事件；增加故障回归。仍未发布。
- Edge 验收接入本机 Creator AI Companion 的既有 acquirePreviewPage 隔离入口，明确 mode=isolated、禁止复用浏览器/页面，仅释放自身 lease；不接入共享 daemon 或采集器。
- 隔离 Edge 释放失败仍保存失败终态回执，并保留原始验收错误；增加关闭拒绝故障回归。
