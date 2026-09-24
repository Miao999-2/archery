const fs = require('fs');
const path = require('path');

// 数据库备份到 Cloudflare R2（S3 兼容对象存储），解决 Render 免费版临时盘丢数据问题。
// 未配置 R2 环境变量时，所有函数自动跳过（本地开发零影响）。
const DB_FILE = path.join(__dirname, 'data.sqlite');
const KEY = 'backup/data.sqlite'; // 云端唯一备份对象，始终覆盖为最新快照

function isConfigured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
            process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

function getS3() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// 启动时恢复：云端有备份就下载覆盖本地 data.sqlite，返回是否真正恢复了数据
async function restoreFromR2() {
  if (!isConfigured()) return false;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = getS3();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: KEY }));
      const bytes = await res.Body.transformToByteArray();
      if (bytes && bytes.length) {
        fs.writeFileSync(DB_FILE, Buffer.from(bytes));
        // 清掉可能残留的 WAL/SHM，避免与刚恢复的主文件不一致
        for (const suffix of ['-wal', '-shm']) {
          const f = DB_FILE + suffix;
          if (fs.existsSync(f)) fs.rmSync(f);
        }
        console.log('[backup] 已从 R2 恢复数据库备份');
        return true;
      }
      return false;
    } catch (e) {
      const notFound = e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404));
      if (notFound) return false; // 还没有备份，首次部署
      console.error(`[backup] 恢复失败（第 ${attempt} 次）:`, e.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

// 上传本地 data.sqlite 到 R2（调用前应先由 db.checkpoint() 把 WAL 合并进主文件）
async function uploadNow() {
  if (!isConfigured()) return false;
  if (!fs.existsSync(DB_FILE)) return false;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = getS3();
  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: KEY,
      Body: fs.readFileSync(DB_FILE),
    }));
    return true;
  } catch (e) {
    console.error('[backup] 备份失败:', e.message);
    return false;
  }
}

module.exports = { isConfigured, restoreFromR2, uploadNow };
