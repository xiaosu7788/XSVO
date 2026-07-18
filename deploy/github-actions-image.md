# GitHub Actions 镜像部署

主应用由 GitHub Actions 构建并发布多架构镜像：

```text
ghcr.io/xiaosu7788/xsvo:latest
```

服务器只拉取镜像，不执行 `docker build`、`pnpm install` 或 `next build`。生产环境使用项目根目录的 `docker-compose.yml`，不要使用 `docker-compose.local.yml`。

## 一次性准备服务器

服务器需要安装 Docker、Docker Compose Plugin 和 Git。首次部署可以执行：

```bash
sudo mkdir -p /var/www/xsvo
sudo chown -R "$USER":"$USER" /var/www/xsvo
git clone https://github.com/xiaosu7788/XSVO.git /var/www/xsvo
cd /var/www/xsvo
```

如果仓库是私有仓库，请先为服务器配置 GitHub SSH key 或其他 Git 认证方式。

如果 GHCR 镜像保持私有，在服务器登录一次：

```bash
echo "你的 GitHub Token" | docker login ghcr.io -u xiaosu7788 --password-stdin
```

Token 只需要 `read:packages` 权限，不要写入仓库文件。

把站点环境变量写入 `/var/www/xsvo/.env`，至少确认以下配置：

```dotenv
NEXT_PUBLIC_SITE_URL=https://你的域名
NEXT_PUBLIC_DOC_URL=https://github.com/xiaosu7788/XSVO/tree/main/docs
XSVO_COOKIE_SECURE=true
VOZEB_COOKIE_SECURE=true
```

先手动启动一次并确认服务正常：

```bash
cd /var/www/xsvo
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
```

## 配置 GitHub Actions

在仓库 `Settings -> Secrets and variables -> Actions` 中创建以下 **Repository secrets**：

| 名称 | 内容 |
| --- | --- |
| `SERVER_HOST` | 服务器 IP 或域名 |
| `SERVER_PORT` | SSH 端口，例如 `22` |
| `SERVER_USER` | SSH 用户，例如 `root` |
| `SERVER_SSH_KEY` | 用于登录服务器的 SSH 私钥全文 |
| `SERVER_KNOWN_HOSTS` | `ssh-keyscan -p 22 服务器IP` 的完整输出 |
| `DEPLOY_PATH` | 服务器项目目录，例如 `/var/www/xsvo` |

在同一页面的 **Repository variables** 中创建：

```text
XSVO_DEPLOY_ENABLED=true
```

`SERVER_SSH_KEY` 和 `SERVER_KNOWN_HOSTS` 只放在 Secrets，不要放入普通 Variables。生成服务器指纹示例：

```bash
ssh-keyscan -p 22 服务器IP
```

## 发布流程

推送到 `main` 后，工作流会按以下顺序执行：

1. GitHub Actions 在 amd64 和 arm64 runner 上构建镜像。
2. 将两个架构合并为 `ghcr.io/xiaosu7788/xsvo:latest`。
3. SSH 登录服务器并执行 `git pull --ff-only origin main`。
4. 执行 `docker compose -f docker-compose.yml pull` 和 `up -d`。

服务器更新时会继续使用 `xsvo-main-data` 数据卷。不要执行 `docker compose down -v`，否则会删除账号、后台设置和公共提示词数据。

## 从本地构建切换到镜像部署

你当前卡住的命令是本地构建模式。停止该命令后，在服务器执行一次：

```bash
cd /var/www/xsvo
docker compose -f docker-compose.local.yml down
git pull --ff-only origin main
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d --remove-orphans
```

后续只要推送 `main`，GitHub Actions 会自动更新服务器，不再执行 `docker compose ... --build`。
