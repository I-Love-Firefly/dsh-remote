# DSH Remote

通过 HTTPS 中转，在安卓手机或浏览器上访问电脑正在运行的 DeepSeek Harness。电脑主动建立 WSS 连接，不需要公网 IP、端口转发或同一局域网。

```text
Android / browser ── HTTPS + WebSocket ── relay ── outbound WSS ── PC Harness
```

手机复用 Harness 原生 Web 界面：会话、工作区、审批、文件和终端均由电脑上的 Harness 提供。插件只搬运传输，不另建远程 shell，也不绕过 Harness 的审批策略。手机拥有当前电脑用户的 Harness 访问权限；中转服务器是受信任的一方，可接触传输内容。本版本使用分段 TLS，并非服务器不可读的端到端加密。

## 当前交付

- Host 插件：`src/node.js`，声明 `webServer` / `connection` 依赖。
- 服务端：`relay/server.mjs`，监听 loopback，置于现有 HTTPS 反向代理之后。
- Node.js 22+；验证基线为 DSH `0.2.1-rc.2`。未来版本的 API 仍需重新验证。
- 安卓独立工程与 APK 单独交付，Android 8.0+，默认仅允许 HTTPS。
- 原生插件设置表单与实时连接状态；电脑连接密钥使用 Harness 的 secret 字段，读取配置时结构化脱敏。
- 默认在电脑端跳过远程开屏主题脚本，避免将内嵌动画上传中转；电脑本地主题不受影响。

## 配对与服务端

```sh
npm ci --omit=peer --ignore-scripts
node tools/pair.mjs https://your-domain.example/dshremote/
```

生成的 `.private/server.env` 只放服务器；`.private/computer.json` 只放电脑；`.private/mobile-key.txt` 用于手机登录。三个文件都不进入 Git，控制台不打印密钥。Windows 上请限制配置目录的 NTFS 权限。

在服务器仓库目录运行 `sudo sh deploy/install.sh`，然后审核 `deploy/nginx-location.conf`，将它加入相应 HTTPS `server` 块，执行 `sudo nginx -t` 后 reload。保留原站点配置备份；不要覆盖已有根路径代理。必须使用浏览器正常信任的 TLS 证书。

服务重启由 Docker `unless-stopped` 管理。检查：

```sh
docker logs --tail 20 dsh-remote
curl https://your-domain.example/dshremote/health
```

## 电脑插件与设置页

使用 Harness 当前 profile 的插件管理器添加本仓库或 npm 打包文件。插件包声明 `dsh.bundle.patch`，由 Harness 加载 `cordis.patch.yml`。

打开 **插件 → dsh-remote → 配置**：连接状态卡会显示状态、电脑名称、手机访问地址与密钥是否已配置；下方原生配置表单可编辑：

- `enabled`：启用或暂停连接。
- `relayUrl`：自己的 HTTPS/WSS 中转地址。
- `deviceId`：电脑名称，使用字母、数字、下划线或短横线。
- `bridgeKey`：电脑连接密钥，最低 8 字符，使用遮蔽输入框；已保存的密钥不会回传明文，不要填成手机登录密钥。
- `skipRemoteAnimation`：默认开启，在电脑端拦截 `dsh-theme-firefly` 的动画主题模块，远程端使用默认外观；动画数据不经过服务器。
- `configFile`：兼容旧版配置文件的高级选项；直接填写上述配置时留空。

保存配置会自动重新连接，无需修改环境变量。配置只保存在用户本机的 Harness profile 中，包含密钥的 profile 和配对文件不得上传 GitHub。旧版环境变量仍可使用：

```powershell
$env:DSH_REMOTE_CONFIG = 'C:\private\dsh-remote\computer.json'
```

只有选择环境变量兼容方式时，桌面程序才需要继承变量后重新启动。尚未填写配置时，设置页明确显示缺失项。

插件从当前进程的 `connection.authenticatedUrl()` 获取认证地址，向 loopback 交换 cookie；该 token 和 cookie 不发送给手机。HTTP 与 WebSocket 的 Host/Origin 会恢复成电脑本机地址。插件卸载会关闭 tunnel、在途请求和重连定时器。

## 手机

安装 DSH Remote APK，设置 HTTPS 中转地址，输入手机访问密钥（最低 8 字符，必须与电脑连接密钥不同），点击在线电脑。也可直接使用手机浏览器访问同一地址。模型账号和命令执行环境复用电脑配置，手机无需运行 Node 或 Linux。服务器会话签名密钥仍至少需要 32 字符。

电脑必须保持开机、联网、未休眠，并持续运行 Harness。断网时显示离线；插件按指数退避重连。手机退出应用不停止电脑上已由 Harness 接受的任务，但依赖手机参与的审批需要重新打开应用。

## 权限与限制

- 手机密钥与电脑连接密钥分离；Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 下带 Secure；登录有效期 7 天。
- 登录限速，同源检查，拒绝未认证隧道，禁止 relay 消息指定任意本机主机地址。
- HTTP 上传限制 32 MiB，实时 WebSocket 单帧当前限制 512 KiB。超限会拒绝或断开，适用于文本和普通操作；大附件应走 HTTP 上传。
- 一台电脑一个 device ID；已有 ID 不被新连接抢占。当前版本为同一所有者的设备设计，不提供多用户隔离、设备授权列表或独立审计日志。
- 轮换手机密钥时同时更换 session key 并重启 relay，以撤销旧登录。退出登录只清除当前客户端 cookie。
- 不支持访问电脑的 `localhost` 网页、远程桌面屏幕或独立于 Harness 的任意 shell 接口。
- 远程动画跳过在电脑端完成；混合脚本包只移除动画模块，其他模块继续加载。传输层支持大响应的窗口流控，避免慢客户端无限堆积缓冲。

## 验证

```sh
npm test
npm audit --omit=peer
```

自动测试覆盖认证/CSRF、目标地址约束、设备隔离、HTTP 2 MiB 上传、流式响应、WebSocket 握手前消息排队、断线离线提示。另用隔离 DSH `0.2.1-rc.2` 验证完整界面与真实终端 `echo DSH_REMOTE_COMMAND_OK` 回显；第二个独立临时 profile 通过额外 patch 直接加载本插件源码，成功注册 `adapter-pc`。这属于隔离联调，没有向日常 DSH 安装插件或复用其账号。

安卓 APK 已构建并通过 Lint；安卓 16 真机已成功登录、执行电脑端 PowerShell 命令并收到工具结果，连续三次关闭应用后重新连接成功。HTTPS 鉴权、真实 Harness HTML、`remoteAccess/follow` WebSocket baseline 以及三次隧道断线自动重连均已验证。

公网联调可在独立测试 Harness 启动后运行：

```sh
node tools/verify-deployed.mjs .private/computer.json .private/mobile-key.txt /path/to/isolated-harness.log
```

它临时连接测试设备，验证结束即关闭，不向控制台打印密钥或启动 token。
