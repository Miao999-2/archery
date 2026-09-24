const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据备份到 GitHub 私密仓库（AES-256-GCM 加密存储），解决 Render 免费版临时盘丢数据问题。
// 未配置环境变量时，所有函数自动跳过（本地开发零影响）。
// 需要环境变量：GITHUB_TOKEN（你的 PAT）、BACKUP_REPO（如 Miao999-2/archery-backup）、BACKUP_SECRET（加密密钥）
const DB_FILE = path.join(__dirname, 'data.sqlite');
const KEY = 'data.sqlite.enc'; // 备份对象在仓库根目录，始终覆盖为最新快照

function isConfigured() {
  return !!(process.env.GITHUB_TOKEN && process.env.BACKUP_REPO && process.env.BACKUP_SECRET);
}
function repo() { return process.env.BACKUP_REPO; }

// 加密：密钥由 BACKUP_SECRET 派生；即使仓库泄露也无法读取内容
function key() { return crypto.scryptSync(String(process.env.BACKUP_SECRET), 'archery-backup-v1', 32); }
function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]); // iv(12) + tag(16) + 密文
}
function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}

async function gh(p, options = {}) {
  return fetch(`https://api.github.com${p}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: options.body,
  });
}

// 启动时恢复：云端有备份就下载解密覆盖本地 data.sqlite
async function restoreBackup() {
  if (!isConfigured()) return false;
  const p = `/repos/${repo()}/contents/${KEY}`;
  try {
    const res = await gh(p);
    if (res.status === 404) return false; // 尚无备份
    if (res.status !== 200) { console.error('[backup] 读取备份失败:', res.status); return false; }
    const body = await res.json();
    const plain = decrypt(Buffer.from(body.content, 'base64'));
    fs.writeFileSync(DB_FILE, plain);
    for (const suffix of ['-wal', '-shm']) {
      const f = DB_FILE + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    console.log('[backup] 已从 GitHub 恢复数据备份');
    return true;
  } catch (e) {
    console.error('[backup] 恢复失败:', e.message);
    return false;
  }
}

// 上传加密后的 data.sqlite 到私密仓库（调用前应先 db.checkpoint() 合并 WAL）
async function uploadBackup() {
  if (!isConfigured()) return false;
  if (!fs.existsSync(DB_FILE)) return false;
  const enc = encrypt(fs.readFileSync(DB_FILE));
  const p = `/repos/${repo()}/contents/${KEY}`;
  try {
    let sha = null;
    const existing = await gh(p);
    if (existing.status === 200) sha = (await existing.json()).sha;
    const payload = { message: 'backup ' + new Date().toISOString(), content: enc.toString('base64'), branch: 'main' };
    if (sha) payload.sha = sha;
    const res = await gh(p, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.status >= 200 && res.status < 300) return true;
    console.error('[backup] 上传失败:', res.status, await res.text().catch(() => ''));
    return false;
  } catch (e) {
    console.error('[backup] 备份失败:', e.message);
    return false;
  }
}

module.exports = { isConfigured, restoreBackup, uploadBackup };
