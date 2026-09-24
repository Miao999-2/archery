// 启动前脚本：在 server.js 打开数据库之前，先从 GitHub 私密仓库恢复最新备份（若存在）。
// 由 package.json 的 start 命令先执行：node restore.js && node server.js
const { restoreBackup } = require('./backup');

(async () => {
  try {
    const restored = await restoreBackup();
    if (restored) console.log('[restore] 已恢复上次的数据');
    else console.log('[restore] 云端无备份（首次启动或未配置备份环境变量），使用本地/空数据库');
  } catch (e) {
    console.error('[restore] 恢复出错（仍会继续启动）:', e.message);
  }
  process.exit(0);
})();
