# auto-commit-hook

ZCode / WorkBuddy 的 git 自动检查点 skill：每个 agent 回合结束时自动把工作区变更提交一次 —— Conventional Commits 主题 + AI 生成的正文（ZCode 读 `provider_config.json`，WorkBuddy 走会话内置的本地 VLM 代理），模型不可用时退化为本地启发式，绝不阻塞回合。

## 安装 skill

两种方式效果相同：把 skill 目录装到 `~/.agents/skills/auto-commit-hook/`。**只装 skill，不注册任何 hook。**

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

## 启用 hook（可选）

skill 装好后，想要"每回合自动提交"，在 agent 的对话框输入：

```
安装 hook
```

- agent（`zcode` / `workbuddy`）从会话环境自动推断，不用手动指定
- 默认 user scope（对本机所有项目生效）；`--scope workspace` 限定单仓库
- 需要重启 agent 会话（或重开工作区）才会加载 hook

## 检查 / 卸载

```bash
# 查看安装状态（两个 scope 一起看）
node ~/.agents/skills/auto-commit-hook/scripts/status.cjs --all --json

# 卸载 hook 并清理拷贝的脚本
node ~/.agents/skills/auto-commit-hook/scripts/uninstall.cjs --purge
```

## 依赖

| 步骤 | 需要什么 |
|---|---|
| 安装 skill | bash + curl（方式一）或 git（方式二）；Windows 下用 Git Bash 即可 |
| 启用 hook | node（PATH 里没有时会尝试 Zcode / WorkBuddy 自带的 node）+ git + bash |
| 运行 hook（每回合） | git + bash；AI 提交信息额外需要可用的模型来源，失败自动退化为 `chore: update N files` |

## 目录结构

```
auto-commit-hook/            ← skill 本体（即安装到 ~/.agents/skills/ 的内容）
├── SKILL.md                 ← skill 说明与完整用法
├── hooks/
│   ├── auto-commit.sh       ← Stop hook：守卫、暂存、提交，永远 exit 0
│   └── auto-commit-msg.cjs  ← 把 agent 最终回复转成 Conventional Commits 信息
└── scripts/
    ├── lib.cjs              ← 配置合并、hook 检测、bash 探测
    ├── install.cjs / uninstall.cjs / status.cjs
install.sh                   ← 本文件所在的一键安装脚本
readme.md
```
