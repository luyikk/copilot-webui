# Copilot Workspace

一个简洁、美观的中文 Copilot CLI 网页工作空间。在浏览器中使用本机的 GitHub Copilot CLI，不必每次通过 SSH 手动启动。

这是非官方社区项目，不代表 GitHub 官方产品或获得 GitHub 背书。界面使用 [GitHub Octicons 的 Copilot 图标](https://github.com/primer/octicons/blob/main/icons/copilot-24.svg)，按其 MIT 许可保留版权及许可证文本，见 `THIRD-PARTY-NOTICES.txt`。图标版权许可不等于商标授权，发布和宣传仍需遵守相应品牌规范。

它通过真正的 PTY 终端运行 Copilot，并非模拟聊天界面。模型选择、斜杠命令、工具输出和权限确认仍由 CLI 处理，**不会自动跳过工具审批或目录信任确认**。

## 功能

- 深色中文界面，适配电脑与手机。
- 最多同时保留 6 个会话，支持工作目录选择。
- 实时终端输入输出，支持字号调整、全屏、选中文字复制和纯文本复制窗口。
- 切换会话、刷新网页或网络重连，不会结束正在运行的终端。
- “历史会话”标签保留已结束的对话入口，可点击恢复，历史记录不占用当前会话名额。
- 手机快捷键：Esc、Tab、方向键、Ctrl C、Enter。
- HTTPS、口令登录、登录限速，以及 HTTP / WebSocket 来源网段限制。
- 网页静态资源全部由本机提供，不依赖外部 CDN。

> **安全提示：** 获得网页访问权限的人，可以通过 Copilot 以服务所属用户的身份操作电脑。请把登录口令当作远程终端密码保管，使用较长的随机密码，不要将服务直接暴露到公网，也不要使用 root 运行。

## 一、运行环境

目前的部署说明面向 **Linux**；开机自启使用 systemd 用户服务。

需要提前安装：

- Node.js **22 或更新版本**，以及 npm。
- OpenSSL。
- Python 3、make 和 C/C++ 编译工具，用于构建 `node-pty` 原生依赖。
- GitHub Copilot CLI，并已在运行服务的同一个 Linux 用户下完成登录。

检查环境：

```bash
node --version
npm --version
openssl version
command -v python3 make g++ copilot
```

Debian / Ubuntu 如缺少编译依赖，可由管理员安装：

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 openssl
```

先在终端运行一次 `copilot`，确认本机 CLI 可以正常使用。需要登录时运行 `copilot login`。WebUI 复用本机 CLI 的登录状态，无需在网页中填写 GitHub Token。

## 二、安装与本机启动

下载或克隆本项目后进入项目目录。以下假设代码位于 `~/copilot-webui`：

```bash
cd ~/copilot-webui
npm ci --omit=dev
COPILOT_BIN="$(command -v copilot)" npm start
```

默认访问地址：

```text
https://127.0.0.1:8000
```

默认仅允许本机 IPv4 回环地址访问。前台运行时不要关闭终端；需要长期运行，请按下文配置 systemd 服务。

首次启动会在 `~/.local/share/copilot-webui/` 自动创建：

| 文件 | 用途 |
|---|---|
| `access-key` | 自动生成的随机登录口令 |
| `tls-key.pem` | HTTPS 私钥 |
| `tls-cert.pem` | 自签名 HTTPS 证书 |
| `tls-host` | 证书对应的监听地址记录 |
| `sessions.json` | 网页会话索引，仅保存 ID、目录、标题和时间等元数据，不保存终端全文 |

该目录权限为 `700`，口令和私钥文件权限为 `600`。**这些文件不要提交到 GitHub。**

在服务器本地查看登录口令：

```bash
cat ~/.local/share/copilot-webui/access-key
```

### 首次访问的证书提示

由于使用自签名证书，浏览器首次访问可能提示“连接不是私密连接”。请先确认地址属于自己的服务器，并通过可信渠道核对证书 SHA-256 指纹：

```bash
openssl x509 \
  -in ~/.local/share/copilot-webui/tls-cert.pem \
  -noout -fingerprint -sha256
```

核对后，再按浏览器提供的方式信任该证书。不要盲目忽略后续意外出现的证书变更。自签名证书可以加密流量，但浏览器不会自动信任它。

## 三、允许局域网访问

需要同时指定**服务器的局域网 IPv4 地址**和**允许访问的客户端网段**。

例如，服务器地址为 `192.168.1.100`，局域网网段为 `192.168.1.0/24`：

```bash
cd ~/copilot-webui
WEBUI_HOST=192.168.1.100 \
WEBUI_PORT=8000 \
WEBUI_ALLOWED_SUBNETS=192.168.1.0/24 \
COPILOT_BIN="$(command -v copilot)" \
npm start
```

同一局域网的电脑或手机访问：

```text
https://192.168.1.100:8000
```

**请根据实际网络修改示例地址，不要原样照搬。** 可用 `ip -4 addr` 查看服务器地址，建议为服务器设置固定地址或 DHCP 地址保留。

- 只绑定指定的服务器接口，不必监听 `0.0.0.0`。
- HTTP 请求和 WebSocket 连接均检查真实 TCP 对端地址，不信任 `X-Forwarded-For`、`X-Real-IP` 等请求头。
- 多个允许网段使用英文逗号分隔，例如 `192.168.1.0/24,127.0.0.0/8`。
- 网段限制与登录验证同时生效；知道密码不代表可以从其他网段访问。
- 主机防火墙若启用，应仅向允许网段放行所选 TCP 端口，不要关闭整个防火墙。
- 不要配置路由器公网端口转发。网段限制不能替代边界防火墙；代理或路由器若改写来源地址，后端看到的将是改写后的地址。

服务严格校验 Host 和 Origin。请使用配置的 IP 与端口访问；**不能未经调整直接套用域名或反向代理配置**。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WEBUI_HOST` | `127.0.0.1` | 监听的 IPv4 地址 |
| `WEBUI_PORT` | `8000` | HTTPS 端口 |
| `WEBUI_ALLOWED_SUBNETS` | `127.0.0.0/8` | 允许的 IPv4 CIDR 网段，以英文逗号分隔 |
| `WEBUI_DATA_DIR` | `~/.local/share/copilot-webui` | 口令与证书存放目录 |
| `COPILOT_BIN` | `~/.local/bin/copilot` | Copilot CLI 可执行文件的绝对路径 |

更改监听 IP 后重启服务，会重新生成对应地址的证书，需重新核对并信任；仅更改端口不会重新生成证书。

## 四、配置开机自启

使用普通用户的 systemd 服务，无需把网页服务作为 root 运行。

先查看真实路径：

```bash
command -v node
command -v copilot
pwd
mkdir -p ~/.config/systemd/user
```

新建 `~/.config/systemd/user/copilot-webui.service`，参考以下内容。**把所有 `/home/your-user`、Node.js / Copilot 路径和网络地址替换为实际值**：

```ini
[Unit]
Description=Private HTTPS browser workspace for Copilot CLI
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/your-user/copilot-webui
ExecStart=/home/your-user/.local/bin/node /home/your-user/copilot-webui/server.mjs
Environment=NODE_ENV=production
Environment=WEBUI_HOST=192.168.1.100
Environment=WEBUI_PORT=8000
Environment=WEBUI_ALLOWED_SUBNETS=192.168.1.0/24
Environment=WEBUI_DATA_DIR=/home/your-user/.local/share/copilot-webui
Environment=COPILOT_BIN=/home/your-user/.local/bin/copilot
Environment=PATH=/home/your-user/.local/bin:/usr/local/bin:/usr/bin:/bin
UMask=0077
NoNewPrivileges=yes
KillMode=control-group
TimeoutStopSec=15
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

systemd 不会自动加载 `.bashrc` 或 nvm。若通过 nvm 安装 Node.js，应将实际 Node.js 的 `bin` 目录加入上面的 `PATH`，并确认 `ExecStart` 指向可用的 Node.js。项目要用到的其他工具目录也应加入 `PATH`。

启用服务：

```bash
systemctl --user daemon-reload
systemctl --user enable --now copilot-webui.service
systemctl --user status copilot-webui.service --no-pager
```

若希望退出 SSH 后继续运行、系统启动后无需用户登录即可启动，可由管理员为该用户开启 lingering：

```bash
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" -p Linger
```

常用管理命令：

```bash
# 查看日志
journalctl --user -u copilot-webui.service -n 50 --no-pager

# 重启服务
systemctl --user restart copilot-webui.service

# 停止服务
systemctl --user stop copilot-webui.service

# 取消自启并停止
systemctl --user disable --now copilot-webui.service
```

修改服务文件后，先运行 `systemctl --user daemon-reload`，再重启服务。

## 五、网页使用方法

1. 在浏览器打开服务器的 HTTPS 地址，输入 `access-key` 中的口令。
2. 点击工作目录选择器，选择项目文件夹；也可以手动输入目录绝对路径。
3. 点击“启动 Copilot”，进入真实 CLI 终端。
4. 首次进入项目时，按 CLI 提示确认是否信任该目录，然后输入任务。模型、工具和权限确认方式与终端中一致。
5. 点击侧栏“新建会话”可以选择其他项目，再启动一个独立会话。

### 工作目录与终端操作

- 工作目录必须位于服务用户的主目录内；指向主目录外的符号链接会被拒绝。
- 目录列表默认不显示隐藏文件夹，但可以手动输入其路径。
- Enter 发送输入，Shift Enter 发送换行按键序列，具体解释由 CLI 决定。
- **网页终端中的 Ctrl C / Ctrl Shift C / Command C 仅用于复制选中文字，不会发送给 Copilot**。未选中文字时只提示，不会中断或退出 CLI。
- Ctrl C 和复制按钮优先使用同步浏览器复制，支持终端选区与浏览器文本选区；不支持时尝试异步剪贴板，再退回手动复制窗口。若 CLI 启用了鼠标交互，请按住 **Shift 再拖动鼠标**选择文字，避免把拖动传给 CLI。
- **按住 Shift 拖动选字，松开鼠标即可自动复制**，不需要再按 Ctrl C 或点击复制按钮。普通拖动、单击或空选区不会触发自动复制；浏览器拒绝复制时会提示并提供手动复制窗口。
- 选中后工具栏显示“已选 N 字”，网页会暂存这段选中文字，避免 CLI 重绘或调整终端尺寸后无法复制。重新点击终端、发送输入或切换会话会清除暂存选区；暂存内容不会写入日志或磁盘。
- 点击“复制终端文本”，可在普通文本框中自由选择、长按复制或一键复制全部。内容来自当前终端缓冲区及其可用滚动历史，不保证包含已被 CLI 清屏或丢弃的全部对话。
- 复制图标复制终端中**已选中的文字**；浏览器拒绝剪贴板权限时会打开可手动复制的文本框。
- 需要中断任务时，点击“中断”并确认才发送真正的 Ctrl C。CLI 空闲或连续中断时仍可能退出，因此不要用中断按钮复制文字。手机底部的“中断”同样需要确认。
- 工具栏支持放大 / 缩小字号和全屏。
- `Alt N` 返回新会话页面。

### 粘贴截图与上传图片

- 截图并复制到剪贴板后，在网页终端按 **Ctrl V / Command V**，即可打开图片预览。也可点击终端下方“添加截图 / 图片”，再点“读取剪贴板截图”或“选择图片”。
- 预览后点击“添加到当前输入”，网页将图片上传到本机，再用粘贴图片路径的方式交给 CLI；**不会自动发送消息**。确认终端显示图片附件后，输入说明并按 Enter 发送。先退出目录信任或权限选择界面，回到 CLI 的消息输入框再添加图片。
- 支持 PNG、JPEG、WebP，单张最大 10 MiB。普通文本粘贴保持原样；浏览器拒绝剪贴板权限时可以选择本地图片文件。
- 上传文件保存在 `WEBUI_DATA_DIR/uploads/`（默认 `~/.local/share/copilot-webui/uploads/`），目录权限 700、文件权限 600，不提供公开下载地址，也不会写入项目工作目录。保存后即使会话关闭或服务重启仍保留，以便后续恢复时读取。
- 图片存储总量上限为 200 MiB；达到上限会明确报错。需要清理时，先停止服务，删除该目录内确认不再需要的图片，再启动服务。删除会使对应历史对话中的图片路径失效。停止服务会结束正在运行的网页终端。
- 图片不会传给额外的第三方上传服务；发送后由你当前的 Copilot 模型处理。图片理解仍取决于当前模型是否支持视觉输入。

### 会话保留范围

- 刷新网页、断网、切换会话、关闭浏览器或退出网页登录，**不会结束后台终端**。
- 登录有效期为 12 小时；过期后重新输入口令。
- 点击“结束会话”并确认，才会终止对应终端。
- 结束后自动显示“历史会话”标签；点击历史条目可用原始 Copilot 会话 ID 重新打开对话。`0 / 6` 仅表示没有当前终端，不表示历史对话已被删除。
- 服务重启、电脑重启或服务崩溃会结束终端；之后可以从历史入口恢复 **Copilot 已保存的对话**，但不能恢复原进程、尚未保存的输出或被中断的工具任务。
- “本机历史”以本用户 `~/.copilot/session-state/` 中实际保存的 CLI 对话为准；没有名称且没有用户消息的空启动记录不显示。正在使用的会话会显示但禁止重复恢复。已删除、主目录外或工作目录不可访问的历史不会显示。
- CLI 的 `Sessions → All` 还会包含 GitHub 远程会话，本机历史不包含云端记录，不能保证与 `All` 的范围或排序完全一致；比较本机内容请使用 CLI 的 `Local` 标签。
- 新会话使用 `copilot --session-id <UUID>` 固定身份，恢复时使用同一参数，由 CLI 恢复对应保存记录。若你在 CLI 内使用 `/new`、`/fork` 或 `/resume` 切换身份，新保存的会话也会通过 CLI 历史元数据列出。
- 每个会话仅在内存中保留最近约 1 MiB 的终端输出用于重连，不主动将按键或终端全文写入本项目日志。
- 多个浏览器同时打开同一会话时，共用一个终端和尺寸，不是独立副本。

## 六、修改或重置登录口令

**先保存工作并停止服务，停止服务会结束所有运行中的网页终端。**

```bash
systemctl --user stop copilot-webui.service
```

在 Bash 终端中输入新口令，输入内容不会显示在屏幕或写入命令历史：

```bash
read -r -s -p "请输入新登录口令（至少 7 个字符）: " WEBUI_NEW_PASSWORD
printf '\n'
printf '%s\n' "$WEBUI_NEW_PASSWORD" > ~/.local/share/copilot-webui/access-key
unset WEBUI_NEW_PASSWORD
chmod 600 ~/.local/share/copilot-webui/access-key
systemctl --user start copilot-webui.service
```

至少需要 7 个字符，推荐使用较长的随机密码。若配置了自定义 `WEBUI_DATA_DIR`，请使用相应目录。

也可以在停止服务后，仅删除 `access-key` 文件，再启动服务以自动生成随机新口令。不要删除整个数据目录。服务重启后，已有网页登录状态会失效。

## 七、更新项目

如通过 Git 克隆安装，可在保存工作后更新：

```bash
systemctl --user stop copilot-webui.service
cd ~/copilot-webui
git pull --ff-only
npm ci --omit=dev
systemctl --user start copilot-webui.service
```

如有本地代码修改，请先妥善保存，不要强制覆盖。升级过程会结束现有网页终端，但不会删除数据目录中的口令与证书。

## 八、常见问题

| 问题 | 检查方法 |
|---|---|
| 局域网其他设备打不开 | 确认设备网络、服务器 IP、监听地址和主机防火墙；用 `ss -ltn` 查看端口是否监听 |
| 提示仅允许指定网段访问 | 检查客户端实际来源 IP 和 `WEBUI_ALLOWED_SUBNETS`；VPN、代理、其他子网不会自动放行 |
| 主机地址不匹配或连接失败 | 使用与 `WEBUI_HOST`、`WEBUI_PORT` 一致的地址，不要随意换成域名或 `localhost` |
| 提示找不到 Copilot | 用 `command -v copilot` 查真实路径，并更新 `COPILOT_BIN` |
| 前台可运行但 systemd 启动失败 | 查看服务日志，检查绝对路径、Node.js 版本和 `PATH`，尤其是 nvm 环境 |
| 端口已被占用 | 用 `ss -ltn` 检查；选择空闲端口，不要随意停止其他服务 |
| 密码修改后仍无法登录 | 确认修改的是实际数据目录下的文件，并已重启服务；失败尝试过多需要等待 15 分钟 |
| 提示最多 6 个会话 | 在侧栏打开不再需要的会话，点击“结束会话”释放名额 |

本项目不改变 SSH、数据库、Docker 或系统防火墙设置。网页资源无第三方请求，**不意味着 Copilot 离线运行**：CLI 仍会访问其配置的模型提供商、GitHub 和相关工具服务。

## 九、开发与测试

开发时需要安装开发依赖：

```bash
cd ~/copilot-webui
npm ci
npm run check
npm test
```

浏览器测试使用 Playwright，需要本机已有的 Chromium 可执行文件：

```bash
CHROMIUM_PATH=/absolute/path/to/chrome npm run test:browser
```

浏览器测试使用模拟终端和临时口令，不发送真实模型请求。截图默认输出到已忽略的 `test-results/`，可用 `SCREENSHOT_DIR` 修改输出目录。

上传源码时不要包含 `node_modules/`、`.env`、真实口令、私钥、会话数据或含敏感信息的截图。
