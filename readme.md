# auto-commit-hook

ZCode / WorkBuddy / Claude Code 的 git 自动检查点 skill：每个 agent 回合结束时自动把工作区变更提交一次 —— Conventional Commits 主题 + AI 生成的正文（ZCode 读 `provider_config.json`，WorkBuddy 走会话内置的本地 VLM 代理，Claude Code 用会话的 `ANTHROPIC_*` 环境），模型不可用时退化为本地启发式；常见敏感文件（`.env`、密钥等）自动排除在提交之外；绝不阻塞回合。

## 安装 skill

三种方式效果相同：把 skill 目录装到 `~/.agents/skills/auto-commit-hook/`。**只装 skill，不注册任何 hook。** 装好后想启用每回合自动提交，在 agent 对话框输入「安装 hook」即可；启用/暂停/恢复/卸载/更新/查看状态/LLM 配置等对话短语见 `auto-commit-hook/SKILL.md`。

### 方式一：curl（无需 git）

```bash
curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash
```


### 方式二：git clone

```bash
git clone https://github.com/netcaty/skill
./skill/install.sh
```

clone 方式下脚本检测到旁边的 `auto-commit-hook/` 目录后会直接本地拷贝，不访问网络。也可以手动拷贝：把 `auto-commit-hook/` 目录整个复制到 `~/.agents/skills/` 下。

### 方式三：agent 对话框安装

不敲命令，在 ZCode / WorkBuddy 的对话框直接输入 prompt，让 agent 代为安装：

```
安装 auto-commit-hook skill：执行 curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash ，装到 ~/.agents/skills/auto-commit-hook/ 即可，只装 skill，不要注册任何 hook。
```

agent 会先请求执行该命令的权限，确认后即完成安装，效果与方式一相同。Windows 下 agent 会自动改用 Git Bash 执行。

## 依赖

| 步骤 | 需要什么 |
|---|---|
| 安装 skill | bash + curl（方式一、方式三）或 git（方式二）；Windows 用 Git Bash，macOS 用自带 bash 即可 |
| 启用 hook | `bash scripts/run.sh install`（自动发现 node 或 ZCode / WorkBuddy 自带的 Electron，Windows 与 macOS 应用路径都会探测）+ git + bash |
| 运行 hook（每回合） | git + bash；AI 提交信息额外需要可用的模型来源，失败自动退化为 `chore: update N files` |

## 目录结构

```
auto-commit-hook/            ← skill 本体（即安装到 ~/.agents/skills/ 的内容）
├── SKILL.md                 ← skill 说明与常用命令
├── references/              ← 详细文档：安装内部、排错、安全、扩展新 agent
├── hooks/
│   ├── auto-commit.sh       ← Stop hook：守卫、暂存、提交，永远 exit 0
│   └── auto-commit-msg.cjs  ← 把 agent 最终回复转成 Conventional Commits 信息
└── scripts/
    ├── lib.cjs              ← 配置合并、hook 检测、bash 探测、暂停标记
    ├── install.cjs / uninstall.cjs / disable.cjs / enable.cjs / status.cjs / setup-llm.cjs
    └── run.sh               ← 脚本运行器：自动发现 node / agent Electron，子命令 install / uninstall / disable / enable / status / setup-llm
install.sh                   ← 本文件所在的一键安装脚本
readme.md
```
