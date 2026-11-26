# Colab 算力面板（Antigravity 2.0 原生右侧栏插件）

基于 Antigravity 2.0 官方 UI Extension（Sidecar）规范编写，无需 Python、无需 `npm install`，直接复用 Antigravity 内置 Node.js 与 `sidecar_sdk`。

## 功能
- **OAuth 2.0 (PKCE) 一次登录**：安全对接 Google Colab API 与会话后端，一次授权即可同时获取订阅等级、精确剩余算力单元（CU）及运行中实例，Token 自动续期且仅存于本机。
- **右侧「概览」面板原生内嵌**：直接挂载在对话右侧「概览」卡片底部，实时查看剩余 CU 余额、RAM / GPU 显存与算力利用率、机房地区、运行时长与闲置倒计时，支持自动保活/手动续期及一键释放。
- **自动低频排队抢算力**：选择目标硬件配置与轮询间隔（默认 30 秒，遇 429 自动退避），分配成功后声音提醒。

## 安装方式

### 方式一：Git 克隆（推荐）
在 PowerShell 中执行：
```powershell
git clone https://github.com/cyscjl/agy-colab-panel.git "$env:USERPROFILE\.gemini\config\plugins\colab-panel"
```

### 方式二：手动下载放置
下载仓库压缩包解压后，将文件夹重命名为 `colab-panel` 并复制到：
```text
%USERPROFILE%\.gemini\config\plugins\colab-panel
```

## 启用与打开
1. **重启 Antigravity**，让客户端扫描新插件目录。
2. 点击左侧栏 **Customizations → Installed**，确认 **Colab 算力面板** 已开启。
3. 打开任意对话窗口右侧的 **概览** 面板，即可直接在底部看到 **Colab 算力** 区块（也可在右上角 **⋮ → Extensions → Colab 算力面板** 打开独立面板）。

## 首次 OAuth 凭证配置
1. 前往 Google Cloud Console，选择或新建一个项目，在 **API 和服务 → 库** 中搜索并启用 **Colab API**（`colaboratory.googleapis.com`）。
2. 在 **OAuth 同意屏幕** 添加你自己的 Google 邮箱为测试用户。
3. 在 **凭证 → 创建凭证 → OAuth 客户端 ID** 中选择 **桌面应用（Desktop app）** 并下载 JSON。
4. 在右侧面板点击右上角 **配置**，把下载的 `client_secret.json` 全文粘贴保存（或直接将文件命名为 `client_secret.json` 放进 `%USERPROFILE%\.gemini\config\plugins\colab-panel\`），随后点击 **使用 Google 账号登录** 即可。

## 调试日志
如果插件未启动或报错，可查看 Antigravity 的 Sidecar 运行日志：
```text
%USERPROFILE%\.gemini\antigravity\sidecar_data\colab-panel\colab\logs\sidecar.log
```
