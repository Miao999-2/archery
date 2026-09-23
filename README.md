# 射箭队专属网站

一个支持多用户、实时交互的团队网站骨架。当前已包含：

- **账号系统**：注册 / 登录 / 退出（多用户）
- **实时交互**：动态墙——任何人发布的内容，所有在线用户即时看到（WebSocket）
- **响应式页面**：首页、关于我们（内容占位，可随时填充）

技术栈：Node.js + Express + Socket.io + SQLite（Node 内置，无需额外数据库）+ EJS。

---

## 一、本地运行

```bash
cd archery
npm install
npm start
```

打开 http://localhost:3000 即可。开两个浏览器窗口（或一个普通窗口 + 一个无痕窗口）分别注册两个账号，在「动态墙」发消息，就能看到实时同步。

## 二、部署上线，获得「自己的网址」

网站需要一台一直开机的服务器。推荐用 **Render**（免费、无需信用卡、支持 WebSocket）：

1. 把这个文件夹传到 GitHub（建一个仓库）：
   ```bash
   cd archery
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/你的用户名/archery.git
   git push -u origin main
   ```
2. 到 [render.com](https://render.com) 注册 → 「New +」→ 「Blueprint」→ 选择这个仓库。
   （仓库里已经放好了 `render.yaml`，Render 会自动识别并部署。）
3. 部署完成后，Render 会给你一个免费网址：`https://xxx.onrender.com` —— 任何人联网就能打开、注册、互动。

> 免费版有个小缺点：一段时间没人访问会自动休眠，首次打开要等几十秒。对小队内部使用通常够用。

## 三、绑定你自己的域名（可选）

1. 在阿里云 / 腾讯云等买一个域名（几十元/年）。
2. 回到 Render 该服务的 Settings → Custom Domains → 填入你的域名，按提示到域名后台添加一条 CNAME 记录指向 Render 给的地址。
3. 等几分钟解析生效，你的网站就有正式域名了。

## 四、后续怎么加内容

- **首页 / 关于我们**：直接编辑 `views/index.ejs`、`views/about.ejs`。
- **改队名**：编辑 `server.js` 里的 `SITE_NAME`。
- **加新页面/功能**：在 `server.js` 里加路由 + 在 `views/` 加模板即可。

## 五、注意

- 密码用 Node 内置 `scrypt` 加盐哈希，不存明文。
- 部署前请把 `server.js` 里的 `SESSION_SECRET` 换成随机值（或通过环境变量设置）。
- 当前会话存在内存中，适合单实例部署；如果以后要多实例/更大规模，再换 Redis 或数据库存会话。
